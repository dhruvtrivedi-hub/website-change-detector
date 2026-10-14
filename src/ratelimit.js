import { config } from './config.js';

// Per-host politeness: at most `hostConcurrency` in-flight requests per host and a minimum gap between
// consecutive requests. Many pages on one site are therefore spread out instead of fired in a burst.
const hosts = new Map(); // host -> { active, nextAt }

const jitter = (ms) => Math.floor(Math.random() * ms);

export const gate = {
  /** Returns 0 and reserves the slot if allowed now, otherwise the number of ms to wait. */
  tryAcquire(host) {
    const h = hosts.get(host) || { active: 0, nextAt: 0 };
    hosts.set(host, h);
    const now = Date.now();
    if (h.active >= config.hostConcurrency) return 2000 + jitter(1000);
    if (now < h.nextAt) return h.nextAt - now + jitter(1000);
    h.active++;
    return 0;
  },

  release(host, extraDelayMs = 0) {
    const h = hosts.get(host);
    if (!h) return;
    h.active = Math.max(0, h.active - 1);
    h.nextAt = Date.now() + config.hostMinGapMs + extraDelayMs + jitter(2000);
  },

  /** Async variant for interactive requests (region picker). */
  async acquire(host) {
    for (let i = 0; i < 60; i++) {
      const wait = this.tryAcquire(host);
      if (wait === 0) return;
      await new Promise((r) => setTimeout(r, Math.min(wait, 3000)));
    }
    throw new Error('Site is busy, try again shortly');
  },
};
