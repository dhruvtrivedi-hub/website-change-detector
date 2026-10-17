import nodemailer from 'nodemailer';
import { db } from './db.js';
import { config } from './config.js';
import { decrypt, hmac } from './util/crypto.js';

// ---------- Signed diff links (shareable without logging in, unguessable) ----------

export const sign = (w, a, b) => hmac(`diff:${w}:${a}:${b}`);
export const diffUrl = (w, a, b) => `${config.baseUrl}/d/${w}/${a}/${b}/${sign(w, a, b)}`;

// ---------- Channels ----------

let transport;
async function sendEmail(to, subject, text) {
  if (!config.smtpUrl) {
    console.log(`[email:not-configured] to=${to} subject=${subject}\n${text}\n`);
    return;
  }
  transport ??= nodemailer.createTransport(config.smtpUrl);
  await transport.sendMail({ from: config.mailFrom, to, subject, text });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

const sendDiscord = (webhook, text) => postJson(webhook, { content: text.slice(0, 1900) });
const sendTelegram = (botToken, chatId, text) =>
  postJson(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    chat_id: chatId,
    text: text.slice(0, 4000),
    disable_web_page_preview: true,
  });

function channelsFor(user, watch) {
  const list = [];
  if (watch.notify_email) list.push({ name: 'email', send: (subject, text) => sendEmail(user.email, subject, text) });
  if (watch.notify_webhook) {
    const hook = decrypt(user.discord_webhook);
    if (hook) list.push({ name: 'discord', send: (_s, text) => sendDiscord(hook, text) });
    const bot = decrypt(user.telegram_bot_token);
    if (bot && user.telegram_chat_id) list.push({ name: 'telegram', send: (_s, text) => sendTelegram(bot, user.telegram_chat_id, text) });
  }
  return list;
}

const TITLES = { change: 'Page changed', status: 'Page problem', noisy: 'Page changes constantly', number: 'Tracked number changed' };

function format(watch, a, pageUrl) {
  const lines = [
    `${TITLES[a.kind] || 'Alert'}: ${watch.name}`,
    `Watch: ${watch.name}`,
    `URL: ${pageUrl}`,
    `Change details: ${a.summary}`,
  ];
  if (a.link) lines.push(`Diff: ${a.link}`);
  return lines.join('\n');
}

// ---------- Create + deliver ----------

/**
 * dedupeKey makes (watch, kind, snapshot) unique, so the same change can never alert twice,
 * even if a job is retried or the process restarts mid-check.
 */
export function createAlert({ watch, kind, summary, link, dedupeKey }) {
  const digest = watch.digest && kind === 'change' ? 1 : 0;
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO alerts(watch_id, user_id, kind, dedupe_key, summary, link, created_at, digest)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(watch.id, watch.user_id, kind, dedupeKey, summary, link || null, Date.now(), digest);
  if (r.changes && !digest) deliver(r.lastInsertRowid).catch((e) => console.error('deliver failed', e));
}

export async function deliver(id) {
  const a = db.prepare('SELECT * FROM alerts WHERE id=? AND sent_at IS NULL').get(id);
  if (!a) return;
  const w = db.prepare('SELECT w.*, p.url AS page_url FROM watches w JOIN pages p ON p.id=w.page_id WHERE w.id=?').get(a.watch_id);
  const u = w && db.prepare('SELECT * FROM users WHERE id=?').get(a.user_id);
  if (!w || !u) {
    db.prepare('UPDATE alerts SET sent_at=? WHERE id=?').run(Date.now(), id);
    return;
  }

  const delivered = new Set(JSON.parse(a.delivered));
  const pending = channelsFor(u, w).filter((c) => !delivered.has(c.name));
  const subject = `${TITLES[a.kind] || 'Alert'}: ${w.name}`;
  const text = format(w, a, w.page_url);

  const results = await Promise.allSettled(pending.map((c) => c.send(subject, text)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') delivered.add(pending[i].name);
    else console.error(`alert ${id}: ${pending[i].name} failed:`, r.reason?.message);
  });

  const allDone = pending.every((c) => delivered.has(c.name));
  const attempts = a.attempts + 1;
  db.prepare('UPDATE alerts SET delivered=?, attempts=?, last_attempt_at=?, sent_at=? WHERE id=?').run(
    JSON.stringify([...delivered]),
    attempts,
    Date.now(),
    allDone || attempts >= 5 ? Date.now() : null,
    id,
  );
}

/** Retry alerts where some channel failed; channels that already succeeded are never re-sent. */
export async function retryUnsent() {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT id FROM alerts WHERE sent_at IS NULL AND digest=0 AND attempts>0 AND attempts<5
       AND created_at > ? AND (last_attempt_at IS NULL OR last_attempt_at < ? - 60000 * attempts)`,
    )
    .all(now - 24 * 3600_000, now);
  for (const r of rows) await deliver(r.id);
}

/** Daily digest: one message per user, covering all digest-mode changes since the last one. */
export async function sendDigests() {
  const now = Date.now();
  const users = db.prepare('SELECT * FROM users WHERE last_digest_at < ?').all(now - 24 * 3600_000);
  for (const u of users) {
    const items = db
      .prepare(
        `SELECT a.*, w.name, p.url AS page_url FROM alerts a
         JOIN watches w ON w.id=a.watch_id JOIN pages p ON p.id=w.page_id
         WHERE a.user_id=? AND a.digest=1 AND a.sent_at IS NULL ORDER BY a.created_at`,
      )
      .all(u.id);
    if (!items.length) continue;

    const targets = channelsFor(u, { notify_email: 1, notify_webhook: 1 });
    if (!targets.length) {
      const mark = db.prepare('UPDATE alerts SET sent_at=? WHERE id=?');
      for (const i of items) mark.run(now, i.id);
      db.prepare('UPDATE users SET last_digest_at=? WHERE id=?').run(now, u.id);
      continue;
    }

    // Track digest delivery per channel, just like regular alerts. If one destination fails,
    // a later retry sends only to that destination and won't duplicate successful deliveries.
    const deliveredById = new Map(items.map((i) => [i.id, new Set(JSON.parse(i.delivered))]));
    for (const channel of targets) {
      const pending = items.filter((i) => !deliveredById.get(i.id).has(channel.name));
      if (!pending.length) continue;
      const text =
        `Daily digest: ${pending.length} change${pending.length === 1 ? '' : 's'}\n\n` +
        pending.map((i) => `• ${i.name}: ${i.summary}\n  ${i.link}`).join('\n\n');
      try {
        await channel.send('Daily digest', text);
        for (const item of pending) {
          deliveredById.get(item.id).add(channel.name);
          db.prepare('UPDATE alerts SET delivered=? WHERE id=?')
            .run(JSON.stringify([...deliveredById.get(item.id)]), item.id);
        }
      } catch (e) {
        console.error(`daily digest for user ${u.id}: ${channel.name} failed:`, e?.message || e);
      }
    }

    const allDelivered = items.every((item) =>
      targets.every((channel) => deliveredById.get(item.id).has(channel.name)),
    );
    if (allDelivered) {
      const mark = db.prepare('UPDATE alerts SET sent_at=? WHERE id=?');
      for (const item of items) mark.run(now, item.id);
      db.prepare('UPDATE users SET last_digest_at=? WHERE id=?').run(now, u.id);
    }
  }
}
