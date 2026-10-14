import axios from 'axios';
import * as cheerio from 'cheerio';
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

export function classify(status, text) {
  const t = text.slice(0, 4000).toLowerCase();
  const challenge =
    /captcha|verify (?:that )?you(?:'| a)re (?:a )?human|are you a robot|unusual traffic|checking your browser|just a moment|attention required|access denied|request blocked|enable javascript and cookies|bot protection/.test(t);
  if (status === 429) return { kind: 'blocked', message: 'Rate limited by the site (HTTP 429)' };
  if (status === 401 || status === 403) return { kind: 'blocked', message: `Access denied (HTTP ${status})` };
  if (challenge && (status === 503 || text.length < 2500)) return { kind: 'blocked', message: 'CAPTCHA / bot-challenge page' };
  if (status >= 500) return { kind: 'error', message: `Server error (HTTP ${status})` };
  if (status >= 400) return { kind: 'error', message: `HTTP ${status}`, noRetry: true };
  if (text.trim().length < 20) return { kind: 'error', message: 'Page returned empty content' };
  return null;
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds, 3600) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 3600_000) : 0;
}

async function fetchHtml(startUrl, timeoutMs) {
  let currentUrl = startUrl;
  for (let redirects = 0; redirects <= 5; redirects++) {
    // Validate each redirect destination too, preventing redirects to private/internal hosts.
    const safeUrl = await assertPublicUrl(currentUrl);
    const response = await axios.get(safeUrl.toString(), {
      timeout: timeoutMs,
      maxRedirects: 0,
      maxContentLength: 5 * 1024 * 1024,
      responseType: 'text',
      transformResponse: [(data) => data],
      validateStatus: () => true,
      headers: {
        'User-Agent': config.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) return response;
      if (redirects === 5) throw new Error('Too many redirects');
      currentUrl = new URL(location, safeUrl).toString();
      continue;
    }
    return response;
  }
  throw new Error('Too many redirects');
}

/** Fetch public HTML without launching a browser. JavaScript on the page is not executed. */
export async function render(url, { selectors = [], timeoutMs = config.jobTimeoutMs } = {}) {
  try {
    const response = await fetchHtml(url, timeoutMs);
    const contentType = response.headers['content-type'] || '';
    if (contentType && !/html|xhtml|text\//i.test(contentType)) {
      throw new FetchError('error', `Unsupported page content type (${contentType.split(';')[0]})`, { noRetry: true });
    }

    const html = typeof response.data === 'string' ? response.data : '';
    const $ = cheerio.load(html);
    $('script,style,noscript,template,svg,canvas,head').remove();
    const visibleText = $('body').text() || $.root().text();
    const verdict = classify(response.status, visibleText);
    if (verdict) {
      throw new FetchError(verdict.kind, verdict.message, {
        noRetry: verdict.noRetry || verdict.kind === 'blocked',
        retryAfterMs: parseRetryAfter(response.headers['retry-after']),
      });
    }

    return {
      status: response.status,
      html,
      visibleText,
      screenshot: null,
      rects: Object.fromEntries(selectors.map((selector) => [selector, []])),
      elements: undefined,
      pageWidth: 0,
      pageHeight: 0,
    };
  } catch (e) {
    if (e instanceof FetchError) throw e;
    const message = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT'
      ? `Timed out after ${Math.round(timeoutMs / 1000)}s`
      : String(e.message || e).split('\n')[0].slice(0, 300);
    throw new FetchError('error', message);
  }
}
