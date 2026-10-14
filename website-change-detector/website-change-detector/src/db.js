import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'wcd.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  discord_webhook TEXT,          -- encrypted
  telegram_bot_token TEXT,       -- encrypted
  telegram_chat_id TEXT,
  last_digest_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- One row per distinct URL: the page is fetched ONCE per cycle no matter how many users watch it.
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  host TEXT NOT NULL,
  interval_min INTEGER NOT NULL,        -- min() of all watchers' intervals
  next_check_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | ok | error | blocked
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

-- A user's subscription to a page (own name, regions, sensitivity, alert settings).
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  interval_min INTEGER NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'medium',  -- low | medium | high
  watch_selectors TEXT NOT NULL DEFAULT '[]',
  ignore_selectors TEXT NOT NULL DEFAULT '[]',
  keyword TEXT NOT NULL DEFAULT '',            -- bonus: keyword-only alerts (comma separated)
  notify_email INTEGER NOT NULL DEFAULT 1,
  notify_webhook INTEGER NOT NULL DEFAULT 1,
  digest INTEGER NOT NULL DEFAULT 0,
  rss_token TEXT UNIQUE,
  last_snapshot_id INTEGER,
  last_changed_at INTEGER,
  change_streak INTEGER NOT NULL DEFAULT 0,
  noisy INTEGER NOT NULL DEFAULT 0,
  rebaseline INTEGER NOT NULL DEFAULT 0,       -- settings changed: next snapshot is a new baseline, no alert
  status_alerted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  prev_id INTEGER,
  created_at INTEGER NOT NULL,
  hash TEXT NOT NULL,
  text TEXT NOT NULL,
  summary TEXT,
  screenshot_path TEXT,
  masks TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_snapshots_watch ON snapshots(watch_id, id);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_at);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- change | status | noisy
  dedupe_key TEXT UNIQUE NOT NULL,    -- guarantees no duplicate alerts
  summary TEXT NOT NULL,
  link TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  delivered TEXT NOT NULL DEFAULT '[]', -- channels already delivered (so retries never double-send)
  digest INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_unsent ON alerts(sent_at);
`);
