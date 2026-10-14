import { db } from './db.js';
import { config } from './config.js';

const jitter = (ms) => Math.floor(Math.random() * ms);

/** One pending/running job per page at most: duplicate enqueues are no-ops. */
export function enqueue(pageId, runAt = Date.now()) {
  const exists = db.prepare("SELECT 1 FROM jobs WHERE page_id=? AND status IN ('pending','running')").get(pageId);
  if (exists) return false;
  db.prepare("INSERT INTO jobs(page_id, run_at, status) VALUES (?, ?, 'pending')").run(pageId, runAt);
  return true;
}

/** Claim up to `max` due jobs. Jobs whose host is busy / cooling down are pushed back, not failed. */
export function claimJobs(max, gate) {
  const now = Date.now();
  // crash recovery: jobs whose lock expired go back to pending
  db.prepare("UPDATE jobs SET status='pending', locked_until=NULL WHERE status='running' AND locked_until < ?").run(now);

  const rows = db
    .prepare(
      `SELECT j.*, p.host FROM jobs j JOIN pages p ON p.id = j.page_id
       WHERE j.status='pending' AND j.run_at <= ? ORDER BY j.run_at LIMIT 50`,
    )
    .all(now);

  const claimed = [];
  for (const j of rows) {
    if (claimed.length >= max) break;
    const wait = gate.tryAcquire(j.host);
    if (wait > 0) {
      db.prepare('UPDATE jobs SET run_at=? WHERE id=?').run(now + wait, j.id);
      continue;
    }
    db.prepare("UPDATE jobs SET status='running', locked_until=?, attempts=attempts+1 WHERE id=?").run(
      now + config.jobTimeoutMs + 15_000,
      j.id,
    );
    claimed.push({ ...j, attempts: j.attempts + 1 });
  }
  return claimed;
}

export function completeJob(id) {
  db.prepare("UPDATE jobs SET status='done', locked_until=NULL WHERE id=?").run(id);
}

/** Returns true when the job has failed for good (no more retries). */
export function failJob(job, error, retryable) {
  if (retryable && job.attempts < config.maxAttempts) {
    const delay = 30_000 * 2 ** (job.attempts - 1) + jitter(10_000); // 30s, 60s, ...
    db.prepare("UPDATE jobs SET status='pending', locked_until=NULL, run_at=?, error=? WHERE id=?").run(
      Date.now() + delay,
      error,
      job.id,
    );
    return false;
  }
  db.prepare("UPDATE jobs SET status='failed', locked_until=NULL, error=? WHERE id=?").run(error, job.id);
  return true;
}

export function cleanupJobs() {
  db.prepare("DELETE FROM jobs WHERE status IN ('done','failed') AND run_at < ?").run(Date.now() - 24 * 3600_000);
}
