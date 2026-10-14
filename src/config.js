import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const port = Number(env.PORT) || 3000;
const dataDir = path.resolve(env.DATA_DIR || './data');

function loadSecret() {
  if (env.SECRET) return env.SECRET;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

export const config = {
  port,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir,
  secret: loadSecret(),
  appPassword: env.APP_PASSWORD || '',
  appEmail: env.APP_EMAIL || '',

  // Email (optional). Example: smtps://user:pass@smtp.example.com
  smtpUrl: env.SMTP_URL || '',
  mailFrom: env.MAIL_FROM || 'Change Detector <alerts@localhost>',

  // Interval limits (spec: 15 min to 24 h)
  minIntervalMin: 15,
  maxIntervalMin: 1440,

  // Job queue
  concurrency: Number(env.CONCURRENCY) || 3, // parallel browser checks overall
  jobTimeoutMs: 45_000,
  maxAttempts: 3, // per scheduled check (timeouts / 5xx / network errors)
  tickMs: 15_000, // scheduler tick

  // Politeness: never hammer a site
  hostMinGapMs: 10_000, // minimum gap between two requests to the same host
  hostConcurrency: 1,

  // Alerting
  failureAlertThreshold: 2, // consecutive failed checks before an outage/blocked alert
  noisyStreak: 5, // changes in N consecutive checks => page is "noisy", alerts paused

  // AI change summaries (optional). Without ANTHROPIC_API_KEY the built-in heuristic summary is used.
  ai: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.AI_MODEL || 'claude-haiku-5-5',
    timeoutMs: 15_000, // per request
    budgetPerJobMs: 40_000, // total AI time spent on one page check (all watchers together)
    maxInputChars: 6000, // how much of the diff is sent
  },

  maxWatchesPerUser: 50,
  maxTrackersPerWatch: 10,
  maxReadingsPerTracker: 2000,
  maxSnapshotsPerWatch: 100,

  userAgent:
    env.USER_AGENT ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 WebsiteChangeDetector/1.0',
};
