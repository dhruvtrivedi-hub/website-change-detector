import express from 'express';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { diffWordsWithSpace } from 'diff';

import { config } from './config.js';
import { db } from './db.js';
import { assertPublicUrl, normalizeUrl } from './util/ssrf.js';
import { sha256, randomToken, encrypt, safeEqual } from './util/crypto.js';
import { render, FetchError, closeBrowser } from './browser.js';
import { gate } from './ratelimit.js';
import { enqueue, cleanupJobs } from './queue.js';
import { schedulerTick, startWorker } from './worker.js';
import { diffUrl, sign, retryUnsent, sendDigests } from './alerts.js';
import { textDiff, sideBySide, imageDiff } from './diff.js';
import { aiEnabled } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- helpers ----------

const SESSION_COOKIE = 'wcd_session';
const SESSION_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const scrypt = promisify(crypto.scrypt);

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cookieValue(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const item = part.trim();
    if (item.startsWith(`${name}=`)) {
      try { return decodeURIComponent(item.slice(name.length + 1)); } catch { return ''; }
    }
  }
  return '';
}

function auth(req, res, next) {
  const sessionId = cookieValue(req, SESSION_COOKIE);
  const user = sessionId && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.session_hash=?')
    .get(sha256(sessionId));
  if (!user) return res.status(401).json({ error: 'Please sign in with your email and password.' });
  req.user = user;
  next();
}

function sessionCookie(value, clear = false, extension = false) {
  const secure = config.baseUrl.startsWith('https://') || extension ? '; Secure' : '';
  const sameSite = extension ? 'None' : 'Lax';
  return `${SESSION_COOKIE}=${clear ? '' : encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${clear ? 0 : SESSION_MAX_AGE_SECONDS}${clear ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}${secure}`;
}

const passwordHash = async (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
};

async function passwordMatches(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expected)) return false;
  const actual = await scrypt(password, salt, 64);
  return safeEqual(actual.toString('hex'), expected);
}

function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200 ? email : null;
}

function createSession(userId, res, extension = false) {
  const sessionId = randomToken(32);
  db.prepare('INSERT INTO sessions(session_hash, user_id, created_at) VALUES (?,?,?)')
    .run(sha256(sessionId), userId, Date.now());
  res.setHeader('Set-Cookie', sessionCookie(sessionId, false, extension));
}

function ownWatch(req, res) {
  const w = db.prepare('SELECT * FROM watches WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!w) res.status(404).json({ error: 'Watch not found' });
  return w;
}

function validSelectors(arr, label) {
  if (!Array.isArray(arr)) throw new Error(`${label} must be a list`);
  if (arr.length > 20) throw new Error(`Too many ${label} (max 20)`);
  const $ = cheerio.load('<div></div>');
  return arr.map((s) => {
    if (typeof s !== 'string' || !s.trim() || s.length > 300) throw new Error(`Invalid selector in ${label}`);
    try { $(s.trim()); } catch { throw new Error(`Invalid CSS selector: ${s.slice(0, 60)}`); }
    return s.trim();
  });
}

async function parseWatch(b, { partial = false } = {}) {
  const out = {};
  if (!partial || b.url !== undefined) {
    const u = await assertPublicUrl(String(b.url || ''));
    out.url = normalizeUrl(u.toString());
  }
  if (!partial || b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name || name.length > 100) throw new Error('Name is required (max 100 characters)');
    out.name = name;
  }
  if (!partial || b.interval_min !== undefined) {
    const n = Math.round(Number(b.interval_min));
    if (!Number.isFinite(n) || n < config.minIntervalMin || n > config.maxIntervalMin)
      throw new Error(`Check interval must be between ${config.minIntervalMin} minutes and 24 hours`);
    out.interval_min = n;
  }
  if (b.sensitivity !== undefined || !partial) {
    const s = b.sensitivity ?? 'medium';
    if (!['low', 'medium', 'high'].includes(s)) throw new Error('Sensitivity must be low, medium or high');
    out.sensitivity = s;
  }
  if (b.watch_selectors !== undefined || !partial) out.watch_selectors = validSelectors(b.watch_selectors ?? [], 'watch regions');
  if (b.ignore_selectors !== undefined || !partial) out.ignore_selectors = validSelectors(b.ignore_selectors ?? [], 'ignore regions');
  if (b.keyword !== undefined || !partial) out.keyword = String(b.keyword ?? '').slice(0, 200);
  for (const k of ['notify_email', 'notify_webhook', 'digest', 'ai_summary']) {
    if (b[k] !== undefined || !partial) out[k] = b[k] === undefined ? (k === 'digest' ? 0 : 1) : b[k] ? 1 : 0;
  }
  if (b.trackers !== undefined || !partial) out.trackers = parseTrackers(b.trackers ?? []);
  return out;
}

// ---------- tracked numbers ----------

const TRACK_MODES = ['any', 'below', 'above', 'none'];

function parseTrackers(arr) {
  if (!Array.isArray(arr)) throw new Error('Tracked numbers must be a list');
  if (arr.length > config.maxTrackersPerWatch) throw new Error(`Too many tracked numbers (max ${config.maxTrackersPerWatch})`);
  return arr.map((t) => {
    const label = String(t?.label ?? '').trim();
    if (!label || label.length > 60) throw new Error('Each tracked number needs a name (max 60 characters)');
    const [selector] = validSelectors([t?.selector], 'tracked numbers');
    const mode = t.mode ?? 'any';
    if (!TRACK_MODES.includes(mode)) throw new Error(`Unknown alert type for "${label}"`);
    let threshold = null;
    if (mode === 'below' || mode === 'above') {
      threshold = t.threshold === '' || t.threshold == null ? NaN : Number(t.threshold);
      if (!Number.isFinite(threshold)) throw new Error(`"${label}" needs a threshold number`);
    }
    const id = t.id == null ? null : Number(t.id);
    return { id: Number.isInteger(id) ? id : null, label, selector, mode, threshold };
  });
}

const publicTracker = (t) => ({
  id: t.id, label: t.label, selector: t.selector, mode: t.mode, threshold: t.threshold,
  last_value: t.last_value, last_raw: t.last_raw, last_read_at: t.last_read_at, last_error: t.last_error,
});

/** Make the watch's trackers match `list`. Keeps history for ids that stay. Returns true if the set changed. */
function saveTrackers(watchId, list) {
  let changed = false;
  db.transaction(() => {
    const existing = new Map(db.prepare('SELECT * FROM trackers WHERE watch_id=?').all(watchId).map((t) => [t.id, t]));
    const keep = new Set();
    for (const t of list) {
      const cur = t.id != null ? existing.get(t.id) : null;
      if (cur) {
        keep.add(cur.id);
        if (cur.selector !== t.selector) {
          changed = true; // a different element is tracked now: restart without a bogus "changed" alert
          db.prepare(
            `UPDATE trackers SET label=?, selector=?, mode=?, threshold=?, last_value=NULL, last_raw=NULL,
             last_error=NULL, misses=0, miss_alerted=0 WHERE id=?`,
          ).run(t.label, t.selector, t.mode, t.threshold, cur.id);
        } else {
          db.prepare('UPDATE trackers SET label=?, mode=?, threshold=? WHERE id=?').run(t.label, t.mode, t.threshold, cur.id);
        }
      } else {
        changed = true;
        db.prepare('INSERT INTO trackers(watch_id, label, selector, mode, threshold, created_at) VALUES (?,?,?,?,?,?)').run(
          watchId, t.label, t.selector, t.mode, t.threshold, Date.now(),
        );
      }
    }
    for (const id of existing.keys()) {
      if (!keep.has(id)) { changed = true; db.prepare('DELETE FROM trackers WHERE id=?').run(id); }
    }
  })();
  return changed;
}

const trackersOf = (watchId) => db.prepare('SELECT * FROM trackers WHERE watch_id=? ORDER BY id').all(watchId).map(publicTracker);

function recomputePage(pageId) {
  const r = db.prepare('SELECT MIN(interval_min) AS m, COUNT(*) AS n FROM watches WHERE page_id=?').get(pageId);
  if (!r.n) { db.prepare('DELETE FROM pages WHERE id=?').run(pageId); return; }
  const p = db.prepare('SELECT * FROM pages WHERE id=?').get(pageId);
  const next = p.last_checked_at ? Math.min(p.next_check_at, p.last_checked_at + r.m * 60_000) : p.next_check_at;
  db.prepare('UPDATE pages SET interval_min=?, next_check_at=? WHERE id=?').run(r.m, next, pageId);
}

const wipeShots = (watchId) => fs.rmSync(path.join(config.dataDir, 'shots', String(watchId)), { recursive: true, force: true });

function publicWatch(w, trackers = trackersOf(w.id)) {
  return {
    id: w.id, name: w.name, url: w.url, interval_min: w.interval_min, sensitivity: w.sensitivity,
    watch_selectors: JSON.parse(w.watch_selectors), ignore_selectors: JSON.parse(w.ignore_selectors),
    keyword: w.keyword, notify_email: !!w.notify_email, notify_webhook: !!w.notify_webhook, digest: !!w.digest,
    ai_summary: !!w.ai_summary, trackers,
    status: w.status, last_error: w.last_error, last_checked_at: w.last_checked_at,
    last_changed_at: w.last_changed_at, next_check_at: w.next_check_at, noisy: !!w.noisy,
    rss_url: `${config.baseUrl}/rss/${w.rss_token}`,
  };
}

const WATCH_SELECT = `SELECT w.*, p.url, p.status, p.last_error, p.last_checked_at, p.next_check_at
                      FROM watches w JOIN pages p ON p.id = w.page_id`;

// ---------- API: email/password accounts ----------

app.post('/api/signup', wrap(async (req, res) => {
  const email = validEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 10 || password.length > 1024)
    return res.status(400).json({ error: 'Password must be at least 10 characters.' });

  const existing = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (existing?.password_hash) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });

  const encoded = await passwordHash(password);
  let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (user?.password_hash) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
  if (!user) {
    const legacyOwner = db.prepare("SELECT * FROM users WHERE email='owner@localhost' AND password_hash IS NULL ORDER BY id LIMIT 1").get();
    if (legacyOwner) {
      db.prepare('UPDATE users SET email=?, password_hash=? WHERE id=?').run(email, encoded, legacyOwner.id);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(legacyOwner.id);
    }
  }
  if (user) {
    // Claim a legacy token-era account by its email while keeping its watches and alert settings.
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(encoded, user.id);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  } else {
    const r = db.prepare('INSERT INTO users(email, password_hash, created_at) VALUES (?,?,?)')
      .run(email, encoded, Date.now());
    user = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
  }
  createSession(user.id, res, (req.headers.origin || '').startsWith('chrome-extension://'));
  res.status(201).json({ ok: true, email: user.email });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = validEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = email && db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !await passwordMatches(password, user.password_hash))
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  createSession(user.id, res, (req.headers.origin || '').startsWith('chrome-extension://'));
  res.json({ ok: true, email: user.email });
}));

app.post('/api/logout', auth, (req, res) => {
  const sessionId = cookieValue(req, SESSION_COOKIE);
  if (sessionId) db.prepare('DELETE FROM sessions WHERE session_hash=?').run(sha256(sessionId));
  res.setHeader('Set-Cookie', sessionCookie('', true, (req.headers.origin || '').startsWith('chrome-extension://')));
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  res.json({
    email: u.email,
    discord_configured: !!u.discord_webhook,
    telegram_configured: !!(u.telegram_bot_token && u.telegram_chat_id),
    telegram_chat_id: u.telegram_chat_id || '',
    email_delivery: !!config.smtpUrl,
    ai_enabled: aiEnabled(),
  });
});

app.put('/api/me', auth, wrap(async (req, res) => {
  const { discord_webhook, telegram_bot_token, telegram_chat_id } = req.body;
  if (discord_webhook !== undefined && discord_webhook !== '') {
    let u;
    try { u = new URL(discord_webhook); } catch { return res.status(400).json({ error: 'Invalid Discord webhook URL' }); }
    if (u.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(u.hostname) || !u.pathname.startsWith('/api/webhooks/'))
      return res.status(400).json({ error: 'That does not look like a Discord webhook URL' });
  }
  if (discord_webhook !== undefined)
    db.prepare('UPDATE users SET discord_webhook=? WHERE id=?').run(discord_webhook ? encrypt(discord_webhook) : null, req.user.id);
  if (telegram_bot_token !== undefined)
    db.prepare('UPDATE users SET telegram_bot_token=? WHERE id=?').run(telegram_bot_token ? encrypt(String(telegram_bot_token).trim()) : null, req.user.id);
  if (telegram_chat_id !== undefined)
    db.prepare('UPDATE users SET telegram_chat_id=? WHERE id=?').run(String(telegram_chat_id).trim().slice(0, 64) || null, req.user.id);
  res.json({ ok: true });
}));

// ---------- API: watches ----------

app.get('/api/watches', auth, (req, res) => {
  const rows = db.prepare(`${WATCH_SELECT} WHERE w.user_id=? ORDER BY w.id DESC`).all(req.user.id);
  const byWatch = new Map();
  for (const t of db.prepare('SELECT t.* FROM trackers t JOIN watches w ON w.id=t.watch_id WHERE w.user_id=? ORDER BY t.id').all(req.user.id)) {
    if (!byWatch.has(t.watch_id)) byWatch.set(t.watch_id, []);
    byWatch.get(t.watch_id).push(publicTracker(t));
  }
  res.json(rows.map((w) => publicWatch(w, byWatch.get(w.id) || [])));
});

app.post('/api/watches', auth, wrap(async (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM watches WHERE user_id=?').get(req.user.id).n;
  if (count >= config.maxWatchesPerUser) return res.status(400).json({ error: `Limit of ${config.maxWatchesPerUser} watches reached` });
  let v;
  try { v = await parseWatch(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }

  const now = Date.now();
  let watchId;
  db.transaction(() => {
    let page = db.prepare('SELECT * FROM pages WHERE url=?').get(v.url);
    if (!page) {
      const r = db
        .prepare('INSERT INTO pages(url, host, interval_min, next_check_at, created_at) VALUES (?,?,?,?,?)')
        .run(v.url, new URL(v.url).hostname, v.interval_min, now, now);
      page = { id: Number(r.lastInsertRowid) };
    }
    const r = db
      .prepare(
        `INSERT INTO watches(user_id, page_id, name, interval_min, sensitivity, watch_selectors, ignore_selectors,
           keyword, notify_email, notify_webhook, digest, ai_summary, rss_token, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(req.user.id, page.id, v.name, v.interval_min, v.sensitivity, JSON.stringify(v.watch_selectors),
        JSON.stringify(v.ignore_selectors), v.keyword, v.notify_email, v.notify_webhook, v.digest, v.ai_summary, randomToken(18), now);
    watchId = Number(r.lastInsertRowid);
    saveTrackers(watchId, v.trackers);
    recomputePage(page.id);
    // A new watcher on an already-known page can reuse the page's next fetch; a new page is fetched now.
  })();

  const w = db.prepare(`${WATCH_SELECT} WHERE w.id=?`).get(watchId);
  // New watch on an existing page needs a baseline soon: pull the page's next check forward (still one fetch).
  db.prepare('UPDATE pages SET next_check_at=MIN(next_check_at, ?) WHERE id=?').run(now + 5000, w.page_id);
  enqueue(w.page_id, now);
  res.status(201).json(publicWatch(w));
}));

app.put('/api/watches/:id', auth, wrap(async (req, res) => {
  const w = ownWatch(req, res);
  if (!w) return;
  let v;
  try { v = await parseWatch({ ...req.body, url: undefined }, { partial: true }); } catch (e) { return res.status(400).json({ error: e.message }); }

  const regionChanged =
    (v.sensitivity !== undefined && v.sensitivity !== w.sensitivity) ||
    (v.watch_selectors !== undefined && JSON.stringify(v.watch_selectors) !== w.watch_selectors) ||
    (v.ignore_selectors !== undefined && JSON.stringify(v.ignore_selectors) !== w.ignore_selectors);

  const trackersChanged = v.trackers !== undefined ? saveTrackers(w.id, v.trackers) : false;

  const set = { ...v };
  delete set.trackers;
  if (set.watch_selectors) set.watch_selectors = JSON.stringify(set.watch_selectors);
  if (set.ignore_selectors) set.ignore_selectors = JSON.stringify(set.ignore_selectors);
  // text will be extracted differently (tracked numbers are left out of the text diff): next snapshot is a silent baseline
  if (regionChanged || trackersChanged) set.rebaseline = 1;
  const keys = Object.keys(set);
  if (keys.length) {
    db.prepare(`UPDATE watches SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => set[k]), w.id);
  }
  recomputePage(w.page_id);
  if (regionChanged || trackersChanged) {
    db.prepare('UPDATE pages SET next_check_at=MIN(next_check_at, ?) WHERE id=?').run(Date.now() + 5000, w.page_id);
    enqueue(w.page_id);
  }
  res.json(publicWatch(db.prepare(`${WATCH_SELECT} WHERE w.id=?`).get(w.id)));
}));

app.delete('/api/watches/:id', auth, (req, res) => {
  const w = ownWatch(req, res);
  if (!w) return;
  db.prepare('DELETE FROM watches WHERE id=?').run(w.id);
  wipeShots(w.id);
  recomputePage(w.page_id);
  res.json({ ok: true });
});

app.post('/api/watches/:id/check', auth, (req, res) => {
  const w = ownWatch(req, res);
  if (!w) return;
  if (limited(`check:${w.id}`, 1, 5 * 60_000)) return res.status(429).json({ error: 'Checked recently. Try again in a few minutes.' });
  db.prepare('UPDATE pages SET next_check_at=? WHERE id=?').run(Date.now(), w.page_id);
  enqueue(w.page_id);
  res.json({ queued: true });
});

app.get('/api/watches/:id/snapshots', auth, (req, res) => {
  const w = ownWatch(req, res);
  if (!w) return;
  const rows = db
    .prepare('SELECT id, prev_id, created_at, summary, length(text) AS chars FROM snapshots WHERE watch_id=? ORDER BY id DESC LIMIT 100')
    .all(w.id);
  res.json(rows.map((r) => ({ ...r, compare_url: r.prev_id ? diffUrl(w.id, r.prev_id, r.id) : null })));
});

// Any two versions: returns a signed link to the side-by-side comparison page
app.get('/api/watches/:id/compare', auth, (req, res) => {
  const w = ownWatch(req, res);
  if (!w) return;
  const a = Number(req.query.from), b = Number(req.query.to);
  const rows = db.prepare('SELECT id FROM snapshots WHERE watch_id=? AND id IN (?,?)').all(w.id, a, b);
  if (rows.length < (a === b ? 1 : 2)) return res.status(404).json({ error: 'Snapshot not found' });
  res.json({ url: diffUrl(w.id, Math.min(a, b), Math.max(a, b)) });
});

// Tracked numbers with their history (for the chart)
app.get('/api/watches/:id/numbers', auth, (req, res) => {
  const w = ownWatch(req, res);
  if (!w) return;
  const out = db.prepare('SELECT * FROM trackers WHERE watch_id=? ORDER BY id').all(w.id).map((t) => {
    const points = db
      .prepare('SELECT created_at, value FROM readings WHERE tracker_id=? ORDER BY id DESC LIMIT 500')
      .all(t.id)
      .reverse()
      .map((r) => [r.created_at, r.value]);
    const values = points.map((p) => p[1]);
    return {
      ...publicTracker(t),
      points,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      first: values.length ? values[0] : null,
    };
  });
  res.json(out);
});

// ---------- API: visual region picker ----------

app.post('/api/picker', auth, wrap(async (req, res) => {
  if (limited(`picker:${req.user.id}`, 8, 10 * 60_000)) return res.status(429).json({ error: 'Too many previews. Wait a few minutes.' });
  let url;
  try { url = normalizeUrl((await assertPublicUrl(String(req.body.url || ''))).toString()); } catch (e) { return res.status(400).json({ error: e.message }); }
  const host = new URL(url).hostname;
  try {
    await gate.acquire(host);
  } catch (e) { return res.status(503).json({ error: e.message }); }
  try {
    const r = await render(url, { collectElements: true });
    const elements = r.elements.filter((e) => e.y < r.pageHeight);
    res.json({
      screenshot: r.screenshot.toString('base64'),
      width: r.pageWidth,
      height: r.pageHeight,
      elements,
    });
  } catch (e) {
    const msg = e instanceof FetchError && e.kind === 'blocked'
      ? `This site blocks automated browsers (${e.message}). It can't be monitored.`
      : `Could not load the page: ${e.message}`;
    res.status(422).json({ error: msg });
  } finally {
    gate.release(host);
  }
}));

// ---------- Public, signed diff pages (linked from alerts) ----------

function loadPair(req, res) {
  const { w, a, b, sig } = req.params;
  if (!safeEqual(sig, sign(w, a, b))) { res.status(403).send('Invalid link'); return null; }
  const watch = db.prepare('SELECT w.*, p.url FROM watches w JOIN pages p ON p.id=w.page_id WHERE w.id=?').get(w);
  const A = db.prepare('SELECT * FROM snapshots WHERE id=? AND watch_id=?').get(a, w);
  const B = db.prepare('SELECT * FROM snapshots WHERE id=? AND watch_id=?').get(b, w);
  if (!watch || !A || !B) { res.status(404).send('Snapshot no longer exists (old versions are pruned).'); return null; }
  return { watch, A, B };
}

function wordDiffHtml(l, r) {
  const parts = diffWordsWithSpace(l, r);
  return {
    l: parts.filter((p) => !p.added).map((p) => (p.removed ? `<del>${esc(p.value)}</del>` : esc(p.value))).join(''),
    r: parts.filter((p) => !p.removed).map((p) => (p.added ? `<ins>${esc(p.value)}</ins>` : esc(p.value))).join(''),
  };
}

app.get('/d/:w/:a/:b/:sig', (req, res) => {
  const pair = loadPair(req, res);
  if (!pair) return;
  const { watch, A, B } = pair;
  const d = textDiff(A.text, B.text);
  const rows = sideBySide(d.parts)
    .map((row) => {
      if (row.t === 'gap') return `<tr class="gap"><td colspan="2">… ${row.n} unchanged lines …</td></tr>`;
      if (row.t === 'chg' && row.l !== null && row.r !== null) {
        const w = wordDiffHtml(row.l, row.r);
        return `<tr class="chg"><td>${w.l}</td><td>${w.r}</td></tr>`;
      }
      return `<tr class="${row.t}"><td>${row.l === null ? '' : esc(row.l)}</td><td>${row.r === null ? '' : esc(row.r)}</td></tr>`;
    })
    .join('');
  const base = `/d/${watch.id}/${A.id}/${B.id}/${req.params.sig}`;
  const when = (t) => new Date(t).toUTCString();
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Changes: ${esc(watch.name)}</title>
<style>
:root{--ink:#1a1d24;--muted:#667085;--rule:#dfe3ea;--add:#e3f4ea;--addi:#b9e6c9;--del:#fde8e8;--deli:#f7c1c1}
body{font:15px/1.5 system-ui,sans-serif;color:var(--ink);margin:0;padding:24px;background:#f5f6f8}
main{max-width:1400px;margin:auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.meta{color:var(--muted);margin:0 0 4px}a{color:#2b4acb}
table{width:100%;border-collapse:collapse;table-layout:fixed;background:#fff;border:1px solid var(--rule)}
td{vertical-align:top;padding:3px 10px;white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,Menlo,monospace;border-left:1px solid var(--rule);width:50%}
td:first-child{border-left:0}tr.add td:last-child,tr.chg td:last-child{background:var(--add)}tr.del td:first-child,tr.chg td:first-child{background:var(--del)}
ins{background:var(--addi);text-decoration:none}del{background:var(--deli);text-decoration:none}
tr.gap td{background:#eef0f4;color:var(--muted);text-align:center;font:12px system-ui}
.heads{display:grid;grid-template-columns:1fr 1fr;gap:0}.heads div{padding:6px 10px;font-weight:600;background:#fff;border:1px solid var(--rule);border-bottom:0}
.shots{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.shots figure{margin:0;background:#fff;border:1px solid var(--rule);padding:8px}
.shots img{width:100%;display:block}.shots figcaption{font-size:13px;color:var(--muted);margin-bottom:6px}
@media(max-width:900px){.shots{grid-template-columns:1fr}}
</style></head><body><main>
<h1>${esc(watch.name)}</h1>
<p class="meta"><a href="${esc(watch.url)}" rel="noopener noreferrer">${esc(watch.url)}</a></p>
<p class="meta">${d.added.length} line(s) added, ${d.removed.length} removed</p>
<h2>Text changes</h2>
<div class="heads"><div>Before — ${when(A.created_at)}</div><div>After — ${when(B.created_at)}</div></div>
<table>${rows || '<tr><td colspan="2">No text differences.</td></tr>'}</table>
${A.screenshot_path && B.screenshot_path ? `<h2>Screenshots</h2>
<div class="shots">
<figure><figcaption>Before</figcaption><img loading="lazy" src="${base}/old.png" alt="Screenshot before"></figure>
<figure><figcaption>After</figcaption><img loading="lazy" src="${base}/new.png" alt="Screenshot after"></figure>
<figure><figcaption>Highlighted differences</figcaption><img loading="lazy" src="${base}/diff.png" alt="Highlighted screenshot differences"></figure>
</div>` : '<p class="meta">Screenshots were not recorded for one or both of these versions.</p>'}</main></body></html>`);
});

const sendShot = (res, p) => (p && fs.existsSync(p) ? res.sendFile(path.resolve(p)) : res.status(404).send('Screenshot not available'));

app.get('/d/:w/:a/:b/:sig/old.png', (req, res) => { const p = loadPair(req, res); if (p) sendShot(res, p.A.screenshot_path); });
app.get('/d/:w/:a/:b/:sig/new.png', (req, res) => { const p = loadPair(req, res); if (p) sendShot(res, p.B.screenshot_path); });
app.get('/d/:w/:a/:b/:sig/diff.png', wrap(async (req, res) => {
  const p = loadPair(req, res);
  if (!p) return;
  const cacheDir = path.join(config.dataDir, 'diffs');
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${p.A.id}-${p.B.id}.png`);
  if (!fs.existsSync(file)) {
    if (!fs.existsSync(p.A.screenshot_path || '') || !fs.existsSync(p.B.screenshot_path || '')) return res.status(404).send('Screenshot not available');
    const out = imageDiff(fs.readFileSync(p.A.screenshot_path), fs.readFileSync(p.B.screenshot_path), JSON.parse(p.A.masks), JSON.parse(p.B.masks));
    fs.writeFileSync(file, out.png);
  }
  res.sendFile(file);
}));

// ---------- Per-watch RSS feed (bonus) ----------

app.get('/rss/:token', (req, res) => {
  const w = db.prepare('SELECT w.*, p.url FROM watches w JOIN pages p ON p.id=w.page_id WHERE w.rss_token=?').get(req.params.token);
  if (!w) return res.status(404).send('Not found');
  const rows = db.prepare('SELECT * FROM snapshots WHERE watch_id=? AND prev_id IS NOT NULL ORDER BY id DESC LIMIT 30').all(w.id);
  const items = rows
    .map((s) => `<item><title>${esc(`${w.name}: ${s.summary}`)}</title><link>${esc(diffUrl(w.id, s.prev_id, s.id))}</link>
<guid isPermaLink="false">wcd-${w.id}-${s.id}</guid><pubDate>${new Date(s.created_at).toUTCString()}</pubDate>
<description>${esc(s.summary)}</description></item>`)
    .join('\n');
  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${esc(w.name)}</title><link>${esc(w.url)}</link>
<description>Changes detected on ${esc(w.url)}</description>
${items}
</channel></rss>`);
});

// ---------- errors + boot ----------

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

const server = app.listen(config.port, () => {
  console.log(`Website Change Detector listening on ${config.baseUrl}`);
});

startWorker();
setInterval(() => { try { schedulerTick(); } catch (e) { console.error('scheduler', e); } }, config.tickMs);
setInterval(() => { retryUnsent().catch((e) => console.error('retryUnsent', e)); }, config.tickMs);
setInterval(() => { sendDigests().catch((e) => console.error('digest', e)); }, 10 * 60_000);
setInterval(cleanupJobs, 3600_000);
schedulerTick();

async function shutdown() {
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
