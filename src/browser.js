import { chromium } from 'playwright';
import { config } from './config.js';
import { assertPublicUrl } from './util/ssrf.js';

/**
 * kind:
 *   'error'   - site outage / network failure / HTTP 4xx-5xx / empty page
 *   'blocked' - CAPTCHA, bot challenge, 401/403/429
 * Neither is ever treated as a content "change": no snapshot is stored for them.
 */
export class FetchError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  }
  return browser;
}
export async function closeBrowser() {
  await browser?.close().catch(() => {});
}

// Simple semaphore: bound the number of live browser contexts.
let active = 0;
const waiters = [];
async function acquire() {
  if (active < config.concurrency + 1) { active++; return; }
  await new Promise((r) => waiters.push(r));
}
function release() {
  const next = waiters.shift();
  if (next) next(); else active--;
}

export function classify(status, text) {
  const t = text.slice(0, 4000).toLowerCase();
  const challenge =
    /captcha|verify (?:that )?you(?:'| a)re (?:a )?human|are you a robot|unusual traffic|checking your browser|just a moment|attention required|access denied|request blocked|enable javascript and cookies|bot protection/.test(t);
  if (status === 429) return { kind: 'blocked', message: 'Rate limited by the site (HTTP 429)' };
  if (status === 401 || status === 403) return { kind: 'blocked', message: `Access denied (HTTP ${status})` };
  if (challenge && (status === 503 || text.length < 2500)) return { kind: 'blocked', message: 'CAPTCHA / bot-challenge page' };
  if (status >= 500) return { kind: 'error', message: `Server error (HTTP ${status})` };
  if (status >= 400) return { kind: 'error', message: `HTTP ${status}`, noRetry: true };
  if (text.trim().length < 20) return { kind: 'error', message: 'Page rendered empty' };
  return null;
}

function parseRetryAfter(v) {
  if (!v) return 0;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.min(s, 3600) * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.min(Math.max(d - Date.now(), 0), 3600_000) : 0;
}

// Runs inside the page: build a stable-ish unique CSS selector for each sizeable element.
function collectElementsInPage() {
  const W = document.documentElement.scrollWidth;
  const H = document.documentElement.scrollHeight;
  const esc = (s) => CSS.escape(s);
  const idOk = (el) => el.id && !/\d{4,}/.test(el.id) && document.querySelectorAll('#' + esc(el.id)).length === 1;
  function selector(el) {
    const parts = [];
    let anchored = false;
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      if (idOk(n)) { parts.unshift('#' + esc(n.id)); anchored = true; break; }
      const tag = n.tagName.toLowerCase();
      const sibs = [...n.parentElement.children].filter((c) => c.tagName === n.tagName);
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(n) + 1})` : tag);
    }
    return (anchored ? '' : 'body > ') + parts.join(' > ');
  }
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'BR', 'SVG', 'PATH'].includes(el.tagName.toUpperCase())) continue;
    const r = el.getBoundingClientRect();
    const w = r.width, h = r.height;
    if (w < 40 || h < 14 || w * h < 600 || w * h > 0.95 * W * H) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const pr = el.parentElement?.getBoundingClientRect();
    if (pr && Math.abs(pr.width - w) < 2 && Math.abs(pr.height - h) < 2 && el.parentElement !== document.body) continue;
    const text = (el.innerText || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    out.push({
      selector: selector(el),
      tag: el.tagName.toLowerCase(),
      text,
      x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(w), h: Math.round(h),
    });
  }
  out.sort((a, b) => b.w * b.h - a.w * a.h);
  return out.slice(0, 400);
}

export async function render(url, { selectors = [], timeoutMs = config.jobTimeoutMs, collectElements = false } = {}) {
  await assertPublicUrl(url);
  await acquire();
  let ctx;
  let timedOut = false;
  let timer;
  try {
    const b = await getBrowser();
    // Fresh, isolated context per check: no cookies, no stored credentials, nothing persisted.
    ctx = await b.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: config.userAgent,
      locale: 'en-US',
      timezoneId: 'UTC', // fixed so locale/time-dependent rendering doesn't create noise
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    timer = setTimeout(() => { timedOut = true; ctx.close().catch(() => {}); }, timeoutMs);

    await ctx.route('**/*', async (route) => {
      const req = route.request();
      const u = req.url();
      if (/^(data|blob|about):/.test(u)) return route.continue();
      if (['media', 'font'].includes(req.resourceType())) return route.abort();
      try {
        await assertPublicUrl(u); // also guards redirects and sub-requests (SSRF)
        return route.continue();
      } catch {
        return route.abort('blockedbyclient');
      }
    });

    const page = await ctx.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);

    const status = resp?.status() ?? 0;
    const headers = resp?.headers() ?? {};
    const visibleText = await page.evaluate(() => document.body?.innerText || '');
    const verdict = classify(status, visibleText);
    if (verdict) {
      throw new FetchError(verdict.kind, verdict.message, {
        noRetry: verdict.noRetry || verdict.kind === 'blocked',
        retryAfterMs: parseRetryAfter(headers['retry-after']),
      });
    }

    const html = await page.content();
    const pageHeight = await page.evaluate(() =>
      Math.min(6000, Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)),
    );
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: true,
      clip: { x: 0, y: 0, width: 1366, height: Math.max(pageHeight, 100) },
      animations: 'disabled',
      caret: 'hide',
    });

    // Bounding boxes of watched/ignored regions (used to mask or crop the screenshot diff)
    const rects = await page.evaluate((sels) => {
      const out = {};
      for (const s of sels) {
        try {
          out[s] = [...document.querySelectorAll(s)].slice(0, 25).map((e) => {
            const r = e.getBoundingClientRect();
            return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
          }).filter((r) => r.w > 0 && r.h > 0);
        } catch { out[s] = []; }
      }
      return out;
    }, selectors);

    const elements = collectElements ? await page.evaluate(collectElementsInPage) : undefined;

    return { status, html, visibleText, screenshot, rects, elements, pageWidth: 1366, pageHeight };
  } catch (e) {
    if (e instanceof FetchError) throw e;
    if (timedOut) throw new FetchError('error', `Timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw new FetchError('error', String(e.message || e).split('\n')[0].slice(0, 300));
  } finally {
    clearTimeout(timer);
    await ctx?.close().catch(() => {});
    release();
  }
}
