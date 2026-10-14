# Website Change Detector

Monitors public web pages in a headless browser (Playwright) and alerts you to meaningful changes while ignoring noise.

## Run it

Requires **Node.js 22.13 or newer**. Storage uses Node's built-in SQLite, so there are no native modules to compile (no Visual Studio / build tools needed).

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
| `ANTHROPIC_API_KEY` | Turns on AI-written change summaries (see below). Without it the built-in summary is used |
| `AI_MODEL` | Model used for summaries (default `claude-haiku-5-5`, a small fast model is plenty) |

Open the dashboard and choose **Create an account** with your email address and a password of at least 10 characters. Use **Sign in** on later visits. Passwords are stored as scrypt hashes and sessions persist across browser restarts until you sign out. Existing token-era users can claim their saved watches by creating an account with the same email address. Email is used as the account name and notification destination; the app does not send verification or sign-in tokens.

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

Bonus included: keyword-only alerts, per-page RSS feed, **AI change summaries**, **number tracking with charts and threshold alerts**, and a **browser extension helper**. Each is described below.

## AI change summaries

Set `ANTHROPIC_API_KEY` and alerts carry a one- or two-sentence summary such as "Price dropped from $129 to $99" instead of "1 line added, 1 removed".

- **Only when an alert is going out.** Pages that are unchanged, below your sensitivity, paused as noisy, or filtered out by your keywords never trigger an API call. When an AI summary is produced it also replaces the stored summary shown in the timeline and RSS feed.
- **Always falls back.** If the key is missing, the request fails or times out, or the per-check budget (`config.ai.budgetPerJobMs`) is used up, the built-in summary is used and the alert still goes out. After 3 failures in a row the AI is skipped for 5 minutes.
- **Cost bounded.** At most about 6,000 characters of the diff are sent per summary; identical changes seen by several watchers are summarised once.
- **Privacy.** The *changed lines of text* (not screenshots) are sent to the Anthropic API. Each watch has an "AI-written change summaries" checkbox (on by default) so you can opt a page out. Don't enable the key on a server that monitors pages containing personal data.
- **Untrusted page text.** The prompt tells the model to treat page content as data and never as instructions, the output is plain text only, and it is length-capped.

## Number tracking

In **Add / Edit watch → Numbers to track** (or *Pick regions visually → Track number*) choose the element that shows a price, stock count, rating, and so on. Every check reads the first number in that element, even when it is written like `$1,299.00`, `1.299,00 €`, `1 299,50 kr` or `12,5 %`.

- **Chart and history.** The **Numbers** button on a watch shows a chart plus lowest / highest / change since first reading. A reading is stored only when the value *changes* (up to 2,000 per number), and the chart runs a step line to the last check.
- **Alerts per number:** any change, drops **below** X, rises **above** X (fires when the value *crosses* the line, not on every check below it), or chart only.
- **Tracked elements are left out of the text diff** (and masked in the screenshot diff). That way a price change sends one "Price went down from 129 to 99 (−23.3%)" alert rather than that *and* a "page changed" alert. If you want both, track the number in a second, separate watch.
- **If the number disappears** (selector no longer matches, or no digits in the element) the dashboard shows a warning, and after 3 checks in a row you get a single status alert. Re-pick the element in Edit.
- Editing which elements are tracked re-baselines the text diff silently on the next check; label/alert-type edits do not.
- Numbers are read from the first matching element only. Pick the *smallest* element that contains just the number you want. Ambiguous formats like `1.299` are read as 1,299 (thousands), not 1.299.

## Browser extension helper

`extension/` is a Manifest V3 extension for Chrome, Edge, Brave and other Chromium browsers (not tested in Firefox). It lets you add the page you are looking at, and pick regions or numbers by clicking on the live page, without copying URLs or CSS selectors by hand.

1. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, and choose the `extension` folder.
2. Open the extension's settings (it opens on first use), enter your server address (for example `http://localhost:3000`), email and password, and allow access to that one address when the browser asks.
3. On any page click the toolbar button: **Start watching** adds it, or **Pick on the page…** opens an overlay where you click to *Watch*, *Ignore* or *Track number* (↑ / ↓ selects a larger / smaller area, Esc cancels). Reopen the popup to finish. If the page is already watched, picks are merged into the existing watch.

Notes: the extension only asks for access to your server's address (not all sites), only touches the current tab when you press the button, and stores the server session in the browser cookie jar rather than saving your password. Use `https://` for any server that is not on your own computer. The server renders the page in its own fresh headless browser, so a selector built from a page you are logged into, or that differs for you (cookie banners, personalisation, A/B tests), may not match there. After adding, use **Check now** and look at the dashboard; the number or region will show a warning if it can't be found.

## The four design questions

**1. Is a site outage or CAPTCHA a change?** No. `browser.js` classifies every fetch as `ok`, `error` (5xx, DNS, timeout, empty page) or `blocked` (401/403/429, CAPTCHA or bot-challenge page). Errors and blocks never create a snapshot or a hash comparison. After 2 consecutive failures the user gets a separate *status* alert (once), and a "reachable again" alert on recovery. Blocked sites are not retried; they back off for at least an hour.

**2. If 200 users watch the same URL, is it fetched 200 times?** No. URLs are normalised into one `pages` row; users subscribe through `watches`. A job fetches the page once (using the shortest interval among its watchers), and every watcher's regions, ignore rules and sensitivity are applied to that single result. Screenshots are hard-linked between watchers.

**3. How to avoid endless alerts on pages that differ on every load?** Four layers: default noise stripping (timestamps, counters, tokens, ads, carousels); the sensitivity setting; user ignore regions; and a streak detector. If a page changes on 5 checks in a row, one "page changes constantly" notice is sent and change alerts pause until a check comes back unchanged. Alerts also carry a unique `dedupe_key`, and per-channel delivery is tracked so retries never double-send.

**4. How to avoid hammering a site?** Minimum 15-minute interval; one request per host at a time with a minimum gap (10 s + jitter) between requests to the same host; global concurrency cap; ±10% jitter on schedules; exponential backoff after failures; `Retry-After` is honoured; no automatic retries on 4xx/blocked; "Check now" is limited to once per 5 minutes per watch.

## Notes and known limits

- **Public pages only:** URLs with credentials, `localhost` and private/link-local IPs are rejected, and every sub-request the browser makes is re-checked (SSRF guard). A determined DNS-rebinding attacker could still race the check; for a public deployment, also run the browser in a network-isolated container.
- Dashboard sessions use an HttpOnly cookie stored server-side and remain valid until sign-out. Set `BASE_URL` to your HTTPS URL when deploying publicly.
- Screenshots are capped at 1366×6000 px. Diff links are signed (HMAC) but not login-protected, so anyone with the link can view that comparison.
- The service sends a normal Chrome user agent. Respect each site's terms of service and robots rules for the pages you monitor.
- Old versions are pruned to the latest 100 per watch.
- Testing status: there was no network access to install the dependencies here, so the full stack (real Express, Cheerio and Playwright rendering of live sites) has **not** been run together. What was tested: the noise filter, number parsing (`npm test`), the database migration from the previous version, number tracking and the AI-summary path against a real SQLite database, the new API routes and the worker loop with stand-ins for the browser and HTML parser, the dashboard and extension in a real Chromium with mocked servers. The first `npm install && npm start` is still its first real end-to-end run.
- Upgrading from the previous version: just replace the files and restart. The database migrates itself (adds the `ai_summary` column and the `trackers` / `readings` tables) and existing watches keep working.
