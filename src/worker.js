import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { render, FetchError } from './scraper.js';
import { extractText } from './extract.js';
import { textDiff, isSignificant, summarize } from './diff.js';
import { claimJobs, completeJob, failJob, enqueue } from './queue.js';
import { gate } from './ratelimit.js';
import { createAlert, diffUrl } from './alerts.js';
import { aiEnabled, aiSummarize } from './ai.js';
import { processTrackers } from './tracking.js';
import { sha256 } from './util/crypto.js';

const running = new Set();
const jitter = (ms) => (Math.random() * 2 - 1) * ms; // +/- ms

// ---------- Scheduler: turns "due" pages into queued jobs ----------

export function schedulerTick() {
  const now = Date.now();
  const due = db.prepare('SELECT id FROM pages WHERE next_check_at <= ?').all(now);
  for (const p of due) enqueue(p.id, now);
}

export function startWorker() {
  setInterval(() => {
    const free = config.concurrency - running.size;
    if (free <= 0) return;
    let jobs;
    try { jobs = claimJobs(free, gate); } catch (e) { console.error('claim failed', e); return; }
    for (const job of jobs) {
      running.add(job.id);
      runJob(job)
        .catch((e) => console.error('job crashed', e))
        .finally(() => running.delete(job.id));
    }
  }, 2000);
}

// ---------- One job = one fetch of one page, shared by every watcher ----------

async function runJob(job) {
  let extraDelay = 0;
  try {
    const page = db.prepare('SELECT * FROM pages WHERE id=?').get(job.page_id);
    if (!page) return;
    const watches = db.prepare('SELECT * FROM watches WHERE page_id=?').all(page.id);
    if (!watches.length) {
      db.prepare('DELETE FROM pages WHERE id=?').run(page.id);
      return;
    }

    const trackerRows = db
      .prepare('SELECT * FROM trackers WHERE watch_id IN (SELECT id FROM watches WHERE page_id=?) ORDER BY id')
      .all(page.id);
    const trackersOf = (watchId) => trackerRows.filter((t) => t.watch_id === watchId);

    const selectors = [
      ...new Set([
        ...watches.flatMap((w) => [...JSON.parse(w.watch_selectors), ...JSON.parse(w.ignore_selectors)]),
        ...trackerRows.map((t) => t.selector),
      ]),
    ];

    let result;
    try {
      result = await render(page.url, { selectors });
    } catch (e) {
      const kind = e instanceof FetchError ? e.kind : 'error';
      const msg = (e.message || 'Unknown error').slice(0, 300);
      extraDelay = e.retryAfterMs || 0;
      const final = failJob(job, msg, kind === 'error' && !e.noRetry);
      if (final) recordFailure(page, watches, kind, msg, extraDelay);
      return;
    }

    recordSuccess(page, watches);
    // AI summaries can take a few seconds per watcher: extend the job lock so it is not reclaimed mid-way.
    db.prepare('UPDATE jobs SET locked_until=? WHERE id=?').run(Date.now() + 2 * 60_000, job.id);
    const shotCache = {};
    const aiBudget = { spent: 0 };
    for (const w of watches) {
      const trackers = trackersOf(w.id);
      try { processTrackers(w, trackers, result.html); }
      catch (e) { console.error(`trackers for watch ${w.id} failed:`, e); }
      try { await processWatch(w, trackers, result, shotCache, page, aiBudget); }
      catch (e) { console.error(`watch ${w.id} failed:`, e); }
    }
    completeJob(job.id);
  } catch (e) {
    console.error('runJob error', e);
    failJob(job, String(e.message || e), false);
  } finally {
    gate.release(job.host, extraDelay);
  }
}

// ---------- Outcomes ----------

function nextCheckDelay(intervalMin) {
  const base = intervalMin * 60_000;
  return base + jitter(base * 0.1); // jitter avoids synchronized bursts
}

function recordFailure(page, watches, kind, message, extraDelay) {
  const now = Date.now();
  const failures = page.consecutive_failures + 1;
  const base = page.interval_min * 60_000;
  // Exponential backoff on repeated failures; blocked sites are left alone for at least an hour.
  let delay = Math.min(24 * 3600_000, base * 2 ** Math.min(failures - 1, 4));
  if (kind === 'blocked') delay = Math.max(delay, 3600_000);
  delay = Math.max(delay, extraDelay) * (1 + Math.random() * 0.1);

  db.prepare(
    `UPDATE pages SET status=?, consecutive_failures=?, last_error=?, last_checked_at=?, next_check_at=? WHERE id=?`,
  ).run(kind, failures, message, now, now + delay, page.id);

  // An outage or CAPTCHA is NOT a content change: it becomes a separate "status" alert, only after a
  // couple of consecutive failures (so one flaky request doesn't page anyone), and only once.
  if (failures >= config.failureAlertThreshold) {
    for (const w of watches) {
      if (w.status_alerted) continue;
      const summary =
        kind === 'blocked'
          ? `The site is blocking automated access (${message}). Monitoring is paused for a while; no content changes are being reported.`
          : `The page is unreachable (${message}). Failed ${failures} checks in a row.`;
      createAlert({ watch: w, kind: 'status', summary, dedupeKey: `${w.id}:status:down:${page.id}:${now}` });
      db.prepare('UPDATE watches SET status_alerted=1 WHERE id=?').run(w.id);
    }
  }
}

function recordSuccess(page, watches) {
  const now = Date.now();
  db.prepare(
    `UPDATE pages SET status='ok', consecutive_failures=0, last_error=NULL, last_checked_at=?, next_check_at=? WHERE id=?`,
  ).run(now, now + nextCheckDelay(page.interval_min), page.id);

  for (const w of watches) {
    if (!w.status_alerted) continue;
    createAlert({
      watch: w,
      kind: 'status',
      summary: 'The page is reachable again.',
      dedupeKey: `${w.id}:status:up:${page.id}:${now}`,
    });
    db.prepare('UPDATE watches SET status_alerted=0 WHERE id=?').run(w.id);
  }
}

// ---------- Per-watch change detection ----------

function saveShot(watchId, buf, cache) {
  if (!buf) return null;
  const dir = path.join(config.dataDir, 'shots', String(watchId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.png`);
  if (cache.first) {
    try { fs.linkSync(cache.first, file); return file; } catch { /* fall back to a copy */ }
  }
  fs.writeFileSync(file, buf);
  cache.first ||= file;
  return file;
}

function storeSnapshot(w, prev, text, hash, summary, result, cache, trackerSelectors = []) {
  const rectsOf = (sels) => sels.flatMap((s) => result.rects[s] || []);
  const masks = {
    ignore: rectsOf([...JSON.parse(w.ignore_selectors), ...trackerSelectors]),
    only: rectsOf(JSON.parse(w.watch_selectors)),
  };
  const file = saveShot(w.id, result.screenshot, cache);
  const info = db
    .prepare(
      `INSERT INTO snapshots(watch_id, prev_id, created_at, hash, text, summary, screenshot_path, masks)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(w.id, prev?.id ?? null, Date.now(), hash, text, summary, file, JSON.stringify(masks));
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE watches SET last_snapshot_id=?, rebaseline=0 WHERE id=?').run(id, w.id);
  pruneSnapshots(w.id);
  return id;
}

function pruneSnapshots(watchId) {
  const old = db
    .prepare('SELECT id, screenshot_path FROM snapshots WHERE watch_id=? ORDER BY id DESC LIMIT -1 OFFSET ?')
    .all(watchId, config.maxSnapshotsPerWatch);
  for (const s of old) {
    if (s.screenshot_path) fs.rmSync(s.screenshot_path, { force: true });
    db.prepare('DELETE FROM snapshots WHERE id=?').run(s.id);
  }
}

async function processWatch(w, trackers, result, shotCache, page, aiBudget) {
  // Tracked numbers have their own alerts and chart, so they are left out of the text diff
  // (otherwise a price change would send two alerts: "number changed" and "page changed").
  const trackerSelectors = trackers.map((t) => t.selector);
  const cfg = {
    watchSelectors: JSON.parse(w.watch_selectors),
    ignoreSelectors: [...JSON.parse(w.ignore_selectors), ...trackerSelectors],
  };
  const { text } = extractText(result.html, cfg, w.sensitivity);
  const hash = sha256(text);
  const prev = w.last_snapshot_id
    ? db.prepare('SELECT * FROM snapshots WHERE id=?').get(w.last_snapshot_id)
    : null;

  // 1) Unchanged: nothing stored (hash compare), the "changing every time" streak resets.
  if (prev && hash === prev.hash && !w.rebaseline) {
    db.prepare('UPDATE watches SET change_streak=0, noisy=0 WHERE id=?').run(w.id);
    return;
  }

  // 2) First snapshot, or settings were edited: record a baseline silently.
  if (!prev || w.rebaseline) {
    storeSnapshot(w, prev, text, hash, 'Baseline captured', result, shotCache, trackerSelectors);
    db.prepare('UPDATE watches SET change_streak=0, noisy=0 WHERE id=?').run(w.id);
    return;
  }

  // 3) Hash differs: is it a meaningful change at this sensitivity?
  const d = textDiff(prev.text, text);
  if (!isSignificant(prev.text, text, d, w.sensitivity)) return; // keep old baseline; nothing stored

  let summary = summarize(d); // built-in summary; replaced by an AI summary below if an alert is going out
  const snapId = storeSnapshot(w, prev, text, hash, summary, result, shotCache, trackerSelectors);
  const streak = w.change_streak + 1;
  db.prepare('UPDATE watches SET last_changed_at=?, change_streak=?, noisy=? WHERE id=?').run(
    Date.now(),
    streak,
    streak >= config.noisyStreak ? 1 : 0,
    w.id,
  );

  // 4) Endless-alert protection: a page that differs on EVERY load gets one "noisy" notice, then silence
  //    until it produces an unchanged check again.
  if (streak > config.noisyStreak) return;
  if (streak === config.noisyStreak) {
    createAlert({
      watch: w,
      kind: 'noisy',
      summary: `This page has changed on ${streak} checks in a row, so change alerts are paused until it settles. Add the constantly changing area as an ignore region or lower the sensitivity.`,
      link: diffUrl(w.id, prev.id, snapId),
      dedupeKey: `${w.id}:noisy:${snapId}`,
    });
    return;
  }

  // 5) Keyword-only alerts (bonus): the snapshot is kept, but no alert unless a keyword is in the diff.
  const keywords = w.keyword.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (keywords.length) {
    const changed = [...d.added, ...d.removed].join('\n').toLowerCase();
    if (!keywords.some((k) => changed.includes(k))) return;
  }

  // 6) An alert is going out: try for a better, AI-written summary (opt-out per watch, falls back silently).
  if (w.ai_summary && aiEnabled()) {
    const ai = await aiSummarize({
      name: w.name,
      url: page.url,
      d,
      cacheKey: `${prev.hash}:${hash}`,
      budget: aiBudget,
    });
    if (ai) {
      summary = ai;
      db.prepare('UPDATE snapshots SET summary=? WHERE id=?').run(summary, snapId);
    }
  }

  createAlert({
    watch: w,
    kind: 'change',
    summary,
    link: diffUrl(w.id, prev.id, snapId),
    dedupeKey: `${w.id}:change:${snapId}`,
  });
}
