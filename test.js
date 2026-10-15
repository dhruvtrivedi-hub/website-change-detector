import assert from 'node:assert/strict';
import { runScraperCheck } from './src/scraper-check.js';

async function main() {
  const result = await runScraperCheck();
  assert.ok(result.ok, result.error || `Scraper check failed for ${result.targetUrl}`);
  console.log(`Scraper test passed: ${result.targetUrl} returned HTTP ${result.httpStatus}; extracted ${result.extractedCharacters} characters of visible text.`);
}

main().catch((error) => {
  console.error('Scraper test failed:', error?.stack || error);
  process.exit(1);
});
