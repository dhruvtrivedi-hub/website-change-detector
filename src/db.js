import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Uses Node's BUILT-IN SQLite (node:sqlite): nothing to install, no native compilation, no Visual Studio.
// Requires Node.js 22.13+ (or 23.4+/24+).
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(
    `\nThis app needs Node.js 22.13 or newer (built-in SQLite). You are running ${process.version}.\n` +
      'Download the current LTS from https://nodejs.org and run again.\n',
  );
  process.exit(1);
}

fs.mkdirSync(config.dataDir, { recursive: true });
const raw = new DatabaseSync(path.join(config.dataDir, 'wcd.sqlite'));
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Thin wrapper exposing the small API the rest of the code uses: prepare().run/get/all, exec(), transaction().
let depth = 0;
export const db = {
  exec: (sql) => raw.exec(sql),
  prepare: (sql) => {
    const st = raw.prepare(sql);
    return {
      run: (...a) => st.run(...a),
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
    };
  },
  transaction: (fn) => (...args) => {
    if (depth++ > 0) { try { return fn(...args); } finally { depth--; } }
    raw.exec('BEGIN');
    try {
      const r = fn(...args);
      raw.exec('COMMIT');
      return r;
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  discord_webhook TEXT,          -- encrypted
  telegram_bot_token TEXT,       -- encrypted
  telegram_chat_id TEXT,
  last_digest_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Browser sessions have no server-side expiration; they remain valid until logout or removal.
CREATE TABLE IF NOT EXISTS sessions (
  session_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

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
  ai_summary INTEGER NOT NULL DEFAULT 1,       -- AI-written change summaries (only if the server has an API key)
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

-- Number tracking: one row per tracked element; readings are stored only when the value changes.
CREATE TABLE IF NOT EXISTS trackers (
  id INTEGER PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  selector TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'any',   -- any | below | above | none
  threshold REAL,
  last_value REAL,
  last_raw TEXT,
  last_read_at INTEGER,
  last_error TEXT,
  misses INTEGER NOT NULL DEFAULT 0,
  miss_alerted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trackers_watch ON trackers(watch_id);

CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY,
  tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  value REAL NOT NULL,
  raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_readings_tracker ON readings(tracker_id, id);
`);

// Migrations for databases created by an older version of the app (safe to run every start).
function addColumn(table, column, ddl) {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumn('watches', 'ai_summary', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'password_hash', 'TEXT');

// Remove the obsolete access-token column while preserving legacy accounts and their ids.
if (raw.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'token_hash')) {
  raw.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  try {
    raw.exec(`
      CREATE TABLE users_password_auth (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        discord_webhook TEXT,
        telegram_bot_token TEXT,
        telegram_chat_id TEXT,
        last_digest_at INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO users_password_auth(id,email,password_hash,discord_webhook,telegram_bot_token,telegram_chat_id,last_digest_at,created_at)
        SELECT id,email,password_hash,discord_webhook,telegram_bot_token,telegram_chat_id,last_digest_at,created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_password_auth RENAME TO users;
    `);
    raw.exec('COMMIT;');
  } catch (e) {
    raw.exec('ROLLBACK;');
    throw e;
  } finally {
    raw.exec('PRAGMA foreign_keys=ON;');
  }
}
db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE password_hash IS NULL)').run();
