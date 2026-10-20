# Texas Election 26

<img src="assets/logo.svg" alt="Election ’26 logo" width="240">

A live projection site for the 2026 Texas **U.S. Senate** (Talarico vs. Paxton) and **Governor** (Hinojosa vs. Abbott) races, hosted on GitHub Pages.

- **`index.html`** — public site: a top bar that rotates my projections ("I project James Talarico to win by +8 D"), a race card and county map for each race, and a projection feed. It re-checks for updates every 20 seconds.
- **`admin.html`** — the projection desk, where I set projections, the top-bar headline, and county results.
- **`data/projections.json`** — my projections; only the desk edits it.
- **`data/results.json`, `data/turnout.json`, `data/polls.json`, `data/markets.json`**: official returns, early-vote and election-day turnout, trusted polls with an average, and prediction-market odds. A GitHub Actions pipeline keeps these updated automatically (see [Live data pipeline](#live-data-pipeline)).

## How the maps work

Before returns come in, each county is shaded by uniform swing: its 2024 presidential margin (`data/baseline-2024.json`) shifted by the gap between my statewide projection and the 2024 statewide result (R+13.7). Once official returns arrive from the Texas Secretary of State, reporting counties are shaded by actual votes and counties with no returns are shown faded. Counties pasted into the desk's emergency override take precedence over the automatic numbers.

## One-time setup

1. Merge this branch into `main`.
2. In the repo go to **Settings → Pages**, and under **Build and deployment** set **Source** to **GitHub Actions**. The workflow in `.github/workflows/pages.yml` deploys on every push to `main`.
   Scheduled workflows only run from the default branch, so `main` must be the default branch for the data pipeline to start.
3. In **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions** so the data workflow can commit. (The workflow also requests these permissions itself; organization policies can override them.)
4. Create a **fine-grained personal access token** at <https://github.com/settings/personal-access-tokens/new>:
   - Repository access: **Only select repositories** → `election26`
   - Permissions: **Contents: Read and write** (nothing else)
   - Set an expiration (for example, the end of November 2026)
5. Open `https://abdonmorales.github.io/election26/admin.html`, paste the token, and sign in.

## Using the desk

1. For each race pick a status: *No projection yet*, *Toss-up*, *Projection*, or *Race called*.
2. For a projection or call, pick the winner and set the margin (slider, number box, or the ±/preset buttons). The preview shows the exact top-bar text.
3. Optionally add a custom headline for the top bar or a note under a race.
4. Each race shows a **Suggested margin** built from the polling average and market odds. **Use this** fills in the winner and margin; it never publishes. Review it, then publish yourself.
5. Official returns load automatically. Only if the SOS feed is down or wrong, open **Emergency override: county results** and paste lines of `County, Republican votes, Democratic votes, % reporting` (county name or FIPS code; tab-separated paste from a spreadsheet works too), then **Apply results**. Clear the override once the feed recovers.
6. Click **Publish**. This commits `data/projections.json` to `main`, Pages redeploys (usually under a minute), and open browsers pick up the change on their next 20-second check. Each changed projection is logged to the feed automatically.

## Security

- The site is fully static. There is no password in the code: the only thing that can change the site is a GitHub commit, so publishing requires a token with write access to this repo.
- The desk checks that the token can push to the repo before showing the editor. The token stays in that browser tab's `sessionStorage` (it is cleared when the tab closes or you sign out) and is only sent to `api.github.com`.
- Both pages use a Content-Security-Policy; the desk loads no third-party scripts at all, and the public page loads d3 and topojson from jsDelivr with Subresource Integrity hashes. All user-entered text is rendered with `textContent`, never as HTML.
- Edits use the file's SHA, so a publish from a stale copy (for example, from a second device) is rejected instead of overwriting newer changes.
- If a token leaks, revoke it at <https://github.com/settings/personal-access-tokens>; every change is also a normal git commit that can be reverted.

## Live data pipeline

Everything except my projections is automated with GitHub Actions. There are no servers, paid APIs or secrets: the workflows use only the built-in `GITHUB_TOKEN`.

| File | Source | How it's read |
|---|---|---|
| `data/results.json` | [Texas Secretary of State election-night results](https://results.texas-election.com/races) | The results app loads static JSON: `static/data/Version.json` → `ElectionConstants_<v>.json` (finds the 2026 November general) → `election/<id>/Version.json` → `election/<id>/<v>/Home.json` (statewide precincts reporting) and `County.json` (every county's returns for every race). Counties are matched to FIPS codes via `data/baseline-2024.json`. |
| `data/turnout.json` | [Texas SOS early-voting turnout](https://earlyvoting.texas-election.com/Elections/getElectionDetails.do) and the results feed above | The early-voting site renders HTML on the server, with no JSON. `getElectionDetails.do` lists the elections (we pick the 2026 November general). Posting `idElection` to `getElectionEVDates.do` lists the daily report dates. Posting `idElection` and `selectedDate` to `getEVDetails.do` returns a county table: registered voters, in person that day, cumulative in person, cumulative mail, cumulative total, and % of registered. Reports are cumulative, so each date's total is one point on the curve. Each run fetches only new dates plus the two most recent, since counties revise the latest day. Election-night ballots cast and registered voters come from each county's `Summary` in the results `County.json`. |
| `data/polls.json` | Wikipedia articles for [the Senate race](https://en.wikipedia.org/wiki/2026_United_States_Senate_election_in_Texas) and [the governor's race](https://en.wikipedia.org/wiki/2026_Texas_gubernatorial_election) | The head-to-head table in the "General election" section (the one with *Poll source* and both nominees' columns). |
| `data/markets.json` | Kalshi and Polymarket public APIs | The market is found by searching (Kalshi: `api.elections.kalshi.com/v1/search/series`; Polymarket: `gamma-api.polymarket.com/public-search`), choosing the two-way "who wins" market (not combos, margins or turnout) and recording its ticker or slug. Prices come from Kalshi's `trade-api/v2/events/<ticker>` and Polymarket's `events?slug=`. |

**Turnout comparisons.** `data/turnout-benchmarks.json` holds the 2022 midterm and 2024 presidential early-vote curves plus their final turnout, built once from the same SOS sites with `node pipeline/build-benchmarks.js`. The site lines up 2026 against them by days before Election Day. Turnout gets its own single-color (teal) map scale so it never looks like a partisan result.

**The SOS sites and Cloudflare.** Both SOS sites are behind a Cloudflare bot check that answers plain requests with HTTP 403. The fetcher tries a plain request first. If it's blocked, it opens that site's page in headless Chromium (Playwright), waits for the check to clear, and makes the same request from inside the page, the same way the page does (`pipeline/lib/cfsession.js`). Until the SOS adds the 2026 general election to its lists, `results.json` and `turnout.json` stay at "not reporting". That is a normal state, not an error.

**Polling average.** Only trusted pollsters count (list and matching rules in `pipeline/config.js`: Texas Politics Project/UT, UT Tyler, UH Hobby School, Texas Tribune and partners such as Texas Southern University, Emerson, TPOR, Quinnipiac, Marist, NYT/Siena). Each pollster contributes its most recent poll, and the likely-voter version wins when a poll reports both. Each poll's weight is `0.5^(age/14 days) × min(1.6, √(n/800)) × population factor`, with age counted from the newest trusted poll. Registered-voter polls are shifted 1.5 points toward R with weight 0.8, and adult samples 2.5 points with weight 0.5. Polls more than 120 days older than the newest are dropped.

**Market odds.** Each market's Yes price is the bid/ask midpoint when the spread is 10¢ or less, otherwise the last trade. The D and R prices are normalized to sum to 100%.

**Suggested margin (dashboard only).** This is 75% of the polling average plus 25% of the market-implied margin. The market-implied margin is `8 × Φ⁻¹(P(R wins))`, which treats the outcome as normally distributed with about 8 points of uncertainty. It is a suggestion and is never published automatically.

### Schedule (`.github/workflows/data.yml`, times in UTC)

| When | Cron | What runs |
|---|---|---|
| Always | `17 */3 * * *` | All sources once, every 3 hours |
| Election week (Oct 31 – Nov 6) | `*/5 * 31 10 *`, `*/5 * 1-6 11 *` | All sources every 5 minutes, the cron minimum. Skipped outside the 2026 window and while the night loop is running. |
| Election night | `40 23 3 11 *` and `20 5 4 11 *` | A loop from about 5:40 PM CT Nov 3 to 2:15 AM CT Nov 4. It fetches results and election-day turnout every 60–90 s, markets every ~5 passes, and polls and early-vote turnout every ~40. Each job stays under GitHub's 6-hour limit, so the night is split into two jobs; the second waits in its concurrency group until the first ends. |
| Manual | *Run workflow* → `once` or `night` | Run once now, or loop for N minutes (for testing or a recount night). |

**Deploying.** Pushes made with `GITHUB_TOKEN` don't trigger other workflows, so the data workflow never relies on `push`. One-shot runs commit and then call `pages.yml` as a reusable workflow in the same run. The night loop commits each change and calls the Pages workflow through `workflow_dispatch`, which `GITHUB_TOKEN` is allowed to trigger. A final reusable-workflow deploy runs at the end. The public page re-checks all four JSON files every 20 seconds.

**Quiet history and safe failures.**
- A source's `updatedAt` changes only when its data changes, so a run that changes nothing writes nothing. Nothing is committed and nothing is deployed.
- If a fetch fails, the last good data stays. The source's status records `ok: false`, the `error` and `errorSince`, and the site shows "⚠ Source unavailable since …". Repeated identical failures don't modify the file.
- Every file is checked against its JSON schema in `schemas/` before writing, along with sanity checks: no publishing zero polls after having some, no county count or vote total suddenly collapsing. A payload that fails is treated as a failed fetch. A file that would be invalid is never written.

### Running and testing locally

```sh
npm ci
npm test                                      # parser + pipeline tests against saved fixtures
node pipeline/run.js                          # fetch everything once, write changed files
node pipeline/run.js --sources polls,markets  # just some sources
node pipeline/run.js --loop --until 2026-11-04T08:15:00Z   # night loop (commits + pushes!)
npx playwright install chromium               # only needed if the SOS site blocks plain requests
```

The fixtures in `test/fixtures/` are trimmed copies of real responses captured on Oct 20, 2026. The SOS fixtures come from the 2024 general election; the tests check that its presidential county returns match `baseline-2024.json` exactly.

### When a source breaks

Look at the latest **Update election data** run in the Actions tab. Each source logs one line, and `sources.<name>.error` in the data file holds the same message. The site keeps showing the last good data in the meantime.

- **SOS: "Office not found" / no data on election night.** The office name changed. Check `ON` values in `County.json` (open the results site, DevTools → Network → `County.json`) and update `sosOffice` in `pipeline/config.js`. If the 2026 election never appears, check `ElectionConstants_<v>.json` for its id and name; `pickElection` looks for a year-2026 `G` (general) entry with "NOVEMBER".
- **Turnout: "early-voting table not found" / "column missing" / "only N counties".** The early-voting report page changed. Open it in a browser, save one day's report as a new fixture in `test/fixtures/earlyvoting/`, adjust `parseEvReport` in `pipeline/sources/earlyvoting.js`, and run `npm test`. If 2026 early voting never shows up, check that the election appears in the picker on `getElectionDetails.do`; `pickEvElection` looks for "2026 … NOVEMBER … GENERAL".
- **SOS: 403 even in the browser.** Cloudflare is blocking GitHub's runners. Use the desk's **Emergency override** paste box for affected counties. It takes precedence over the feed until you clear it.
- **SOS: JSON paths changed.** Open the results page with DevTools → Network, filter `static/data`, and update the paths in `pipeline/sources/sos.js`.
- **Polls: "no head-to-head polling table found" or "parsed 0 trusted polls".** The Wikipedia table layout or a nominee's name changed. Save the article HTML as a new fixture, adjust `extractPolls` or the candidate names in `pipeline/config.js`, and run `npm test`. To trust another pollster, add it to `TRUSTED_POLLSTERS`.
- **Markets: "no Kalshi/Polymarket market matched".** The market was renamed or delisted. Search kalshi.com or polymarket.com, then update the `query` and `title` pattern for that race in `pipeline/config.js`.
- **Need data right now.** Actions → **Update election data** → *Run workflow* (`once`).

## Local preview

```sh
python3 -m http.server 8000
# open http://localhost:8000/ and http://localhost:8000/admin.html
```

## Branding

The logo is the Election ’26 flag from `assets/brand/election26-logo.odg` (the original OpenOffice drawing). It was rebuilt as a vector file using the drawing's exact shapes, colors (#2a6099 blue, #ff0000 red, white) and star outlines, with the text converted to outlines so it looks the same in every browser. Files:

- `assets/logo.svg`: the full logo (site header, hero, README)
- `assets/favicon.svg`, `assets/icon-180.png`, `assets/icon-512.png`: browser tab and home-screen icons (the canton with "’26" and stripes, since the full flag is illegible at 16 px)
- `assets/og-image.png`: 1200×630 preview card for links shared on social media and in messages

## Data sources

- County boundaries: U.S. Census Bureau via [us-atlas](https://github.com/topojson/us-atlas) (Texas counties extracted to `data/tx-counties.topo.json`).
- 2024 presidential results by county: [tonmcg/US_County_Level_Election_Results_08-24](https://github.com/tonmcg/US_County_Level_Election_Results_08-24).
