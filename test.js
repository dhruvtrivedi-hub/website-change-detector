import assert from 'node:assert/strict';
import { render } from './src/scraper.js';

// Override this to smoke-test the scraper against a public page you monitor.
// The default is a stable static HTML page so the test also works in CI.
const targetUrl = process.env.SCRAPER_TEST_URL || 'https://example.com/';

async function main() {
  const result = await render(targetUrl, { timeoutMs: 15_000 });

  assert.ok(result.status >= 200 && result.status < 300,
    `Expected a successful HTTP response from ${targetUrl}, received ${result.status}`);
  assert.ok(result.html.length > 0, `Expected HTML content from ${targetUrl}`);
  assert.ok(result.visibleText.trim().length >= 20,
    `Expected meaningful visible text from ${targetUrl}`);

  console.log(`Scraper test passed: ${targetUrl} returned HTTP ${result.status}; extracted ${result.visibleText.trim().length} characters of visible text.`);
}

main().catch((error) => {
  console.error('Scraper test failed:', error?.stack || error);
  process.exit(1);
});
