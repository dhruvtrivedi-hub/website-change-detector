# Website Change Detector

Monitors public web pages in a headless browser (Playwright) and alerts you to meaningful changes while ignoring noise.

## Run it

```bash
npm install
npm run setup          # downloads Chromium for Playwright
npm start              # http://localhost:3000
```

Optional environment variables:

| Variable | Purpose |
|---|---|
| `PORT`, `BASE_URL` | Server port and the public URL used in alert diff links |
| `SMTP_URL`, `MAIL_FROM` | Email alerts, e.g. `smtps://user:pass@smtp.example.com`. Without it, emails are printed to the log |
| `SECRET` | Signs diff links and encrypts stored webhook/bot tokens (auto-generated in `data/secret.key` if unset) |
| `DATA_DIR` | SQLite DB + screenshots (default `./data`) |
| `CONCURRENCY` | Parallel browser checks (default 3) |

Open the dashboard, create an access token, add a URL, and (optionally) add a Discord webhook or Telegram bot under **Alert settings**.

## Requirement map

| # | Requirement | Where |
|---|---|---|
| 1 | URL, name, 15 min–24 h interval, headless render | `server.js` (validation), `browser.js` |
| 2 | Scheduler, job queue, timeouts, retries, public pages only | `worker.js` (`schedulerTick`), `queue.js`, `util/ssrf.js` |
| 3 | Save text + screenshot; new snapshot only when hash changes | `worker.js` (`processWatch`) |
| 4 | Noise filtering + sensitivity | `noise.js`, `extract.js`, `diff.js` (`isSignificant`) |
| 5 | Visual picker, CSS selectors, ignore regions | `public/index.html`, `browser.js` (`collectElementsInPage`) |
| 6 | Text diff, highlighted screenshot diff, side-by-side any two versions | `diff.js`, `/d/...` pages in `server.js` |
| 7 | Email + Telegram/Discord, summary + diff link, no duplicates, daily digest | `alerts.js` |
| 8 | Version timeline + dashboard (last checked / changed / status) | `public/index.html` |

Bonus included: keyword-only alerts, per-page RSS feed, a heuristic one-line change summary (`summarize()` in `diff.js` is the place to plug in an LLM). Not included: number tracking with charts, browser extension.

## The four design questions

**1. Is a site outage or CAPTCHA a change?** No. `browser.js` classifies every fetch as `ok`, `error` (5xx, DNS, timeout, empty page) or `blocked` (401/403/429, CAPTCHA or bot-challenge page). Errors and blocks never create a snapshot or a hash comparison. After 2 consecutive failures the user gets a separate *status* alert (once), and a "reachable again" alert on recovery. Blocked sites are not retried; they back off for at least an hour.

**2. If 200 users watch the same URL, is it fetched 200 times?** No. URLs are normalised into one `pages` row; users subscribe through `watches`. A job fetches the page once (using the shortest interval among its watchers), and every watcher's regions, ignore rules and sensitivity are applied to that single result. Screenshots are hard-linked between watchers.

**3. How to avoid endless alerts on pages that differ on every load?** Four layers: default noise stripping (timestamps, counters, tokens, ads, carousels); the sensitivity setting; user ignore regions; and a streak detector. If a page changes on 5 checks in a row, one "page changes constantly" notice is sent and change alerts pause until a check comes back unchanged. Alerts also carry a unique `dedupe_key`, and per-channel delivery is tracked so retries never double-send.

**4. How to avoid hammering a site?** Minimum 15-minute interval; one request per host at a time with a minimum gap (10 s + jitter) between requests to the same host; global concurrency cap; ±10% jitter on schedules; exponential backoff after failures; `Retry-After` is honoured; no automatic retries on 4xx/blocked; "Check now" is limited to once per 5 minutes per watch.

## Notes and known limits

- **Public pages only:** URLs with credentials, `localhost` and private/link-local IPs are rejected, and every sub-request the browser makes is re-checked (SSRF guard). A determined DNS-rebinding attacker could still race the check; for a public deployment, also run the browser in a network-isolated container.
- Auth is a simple per-user bearer token. Put the app behind HTTPS and swap in real accounts before exposing it publicly.
- Screenshots are capped at 1366×6000 px. Diff links are signed (HMAC) but not login-protected, so anyone with the link can view that comparison.
- The service sends a normal Chrome user agent. Respect each site's terms of service and robots rules for the pages you monitor.
- Old versions are pruned to the latest 100 per watch.
- I could not install dependencies or run the full stack in my sandbox (no network), so I syntax-checked every file and tested the noise filter, but the first `npm install && npm start` run is its first real test.
