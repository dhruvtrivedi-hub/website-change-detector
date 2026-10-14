import * as cheerio from 'cheerio';
import { db } from './db.js';
import { config } from './config.js';
import { parseNumber, formatNumber } from './numbers.js';
import { createAlert } from './alerts.js';

const BLOCKISH = 'p,div,li,tr,td,th,h1,h2,h3,h4,h5,h6,section,article,br';
const MISS_ALERT_AFTER = 3; // consecutive checks where the number can't be found

export const trackersForWatch = (watchId) =>
  db.prepare('SELECT * FROM trackers WHERE watch_id=? ORDER BY id').all(watchId);

/** Text of the first element matching `selector`, or null when nothing matches. */
function textAt($, selector) {
  let el;
  try { el = $(selector).first(); } catch { return null; }
  if (!el.length) return null;
  const c = el.clone();
  c.find('script,style,noscript,template').remove();
  c.find(BLOCKISH).append(' ');
  return c.text().replace(/\s+/g, ' ').trim().slice(0, 200);
}

const pct = (from, to) => (from === 0 ? '' : ` (${to > from ? '+' : '−'}${Math.abs(((to - from) / from) * 100).toFixed(1)}%)`);

function shouldAlert(t, prev, now) {
  if (prev === null || prev === undefined || now === prev) return false;
  if (t.mode === 'any') return true;
  if (t.mode === 'below') return now < t.threshold && prev >= t.threshold;
  if (t.mode === 'above') return now > t.threshold && prev <= t.threshold;
  return false; // 'none': chart only
}

function describe(t, prev, now) {
  const f = formatNumber;
  if (t.mode === 'below') return `${t.label} dropped below ${f(t.threshold)}: now ${f(now)} (was ${f(prev)}).`;
  if (t.mode === 'above') return `${t.label} rose above ${f(t.threshold)}: now ${f(now)} (was ${f(prev)}).`;
  return `${t.label} went ${now > prev ? 'up' : 'down'} from ${f(prev)} to ${f(now)}${pct(prev, now)}.`;
}

/** Read every tracked number of one watch from the freshly rendered HTML; store changes; alert. */
export function processTrackers(w, trackers, html) {
  if (!trackers.length) return;
  const $ = cheerio.load(html);
  const now = Date.now();

  for (const t of trackers) {
    const raw = textAt($, t.selector);
    const value = raw === null ? null : parseNumber(raw);

    if (value === null) {
      const error = raw === null ? 'The tracked element was not found on the page' : 'No number found in the tracked element';
      const misses = t.misses + 1;
      db.prepare('UPDATE trackers SET last_error=?, misses=? WHERE id=?').run(error, misses, t.id);
      if (misses >= MISS_ALERT_AFTER && !t.miss_alerted) {
        db.prepare('UPDATE trackers SET miss_alerted=1 WHERE id=?').run(t.id);
        createAlert({
          watch: w,
          kind: 'status',
          summary: `Can't read “${t.label}” any more: ${error.toLowerCase()} (${misses} checks in a row). The page layout may have changed; re-pick the number in Edit.`,
          dedupeKey: `${w.id}:num-missing:${t.id}:${now}`,
        });
      }
      continue;
    }

    const prev = t.last_value;
    const changed = prev === null || prev === undefined || value !== prev;
    db.prepare(
      'UPDATE trackers SET last_value=?, last_raw=?, last_read_at=?, last_error=NULL, misses=0, miss_alerted=0 WHERE id=?',
    ).run(value, raw, now, t.id);
    if (!changed) continue;

    const r = db.prepare('INSERT INTO readings(tracker_id, created_at, value, raw) VALUES (?,?,?,?)').run(t.id, now, value, raw);
    db.prepare(
      'DELETE FROM readings WHERE tracker_id=? AND id NOT IN (SELECT id FROM readings WHERE tracker_id=? ORDER BY id DESC LIMIT ?)',
    ).run(t.id, t.id, config.maxReadingsPerTracker);

    if (shouldAlert(t, prev, value)) {
      createAlert({
        watch: w,
        kind: 'number',
        summary: describe(t, prev, value),
        dedupeKey: `${w.id}:num:${t.id}:${Number(r.lastInsertRowid)}`,
      });
    }
  }
}
