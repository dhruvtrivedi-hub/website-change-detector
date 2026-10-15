import { render } from './scraper.js';

export const scraperTestUrl = process.env.SCRAPER_TEST_URL || 'https://example.com/';

/** Shared smoke check used by both `npm test` and the live /test-status endpoint. */
export async function runScraperCheck() {
  const checkedAt = new Date().toISOString();

  try {
    const result = await render(scraperTestUrl, { timeoutMs: 15_000 });
    const extractedText = result.visibleText.trim();
    const checks = {
      successfulHttpStatus: result.status >= 200 && result.status < 300,
      htmlReceived: result.html.length > 0,
      meaningfulTextExtracted: extractedText.length >= 20,
    };
    const failedChecks = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);

    return {
      ok: failedChecks.length === 0,
      targetUrl: scraperTestUrl,
      checkedAt,
      httpStatus: result.status,
      htmlCharacters: result.html.length,
      extractedCharacters: extractedText.length,
      extractedText: extractedText.slice(0, 500),
      checks,
      ...(failedChecks.length ? { error: `Checks failed: ${failedChecks.join(', ')}` } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      targetUrl: scraperTestUrl,
      checkedAt,
      httpStatus: Number.isInteger(error?.status) ? error.status : null,
      htmlCharacters: 0,
      extractedCharacters: 0,
      extractedText: '',
      checks: {
        successfulHttpStatus: false,
        htmlReceived: false,
        meaningfulTextExtracted: false,
      },
      error: String(error?.message || error).slice(0, 300),
    };
  }
}
