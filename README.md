# Texas Election 26

A live projection site for the 2026 Texas **U.S. Senate** (Talarico vs. Paxton) and **Governor** (Hinojosa vs. Abbott) races, hosted on GitHub Pages.

- **`index.html`** — public site: a top bar that rotates my projections ("I project James Talarico to win by +8 D"), a race card and county map for each race, and a projection feed. It re-checks for updates every 20 seconds.
- **`admin.html`** — the projection desk, where I set projections, the top-bar headline, and county results.
- **`data/projections.json`** — the single source of truth the desk edits.

## How the maps work

Before returns come in, each county is shaded by uniform swing: its 2024 presidential margin (`data/baseline-2024.json`) shifted by the gap between my statewide projection and the 2024 statewide result (R+13.7). When county results are pasted into the desk, those counties are shaded by reported votes, and counties with no returns are shown faded.

## One-time setup

1. Merge this branch into `main`.
2. In the repo go to **Settings → Pages**, and under **Build and deployment** set **Source** to **GitHub Actions**. The workflow in `.github/workflows/pages.yml` deploys on every push to `main`.
3. Create a **fine-grained personal access token** at <https://github.com/settings/personal-access-tokens/new>:
   - Repository access: **Only select repositories** → `election26`
   - Permissions: **Contents: Read and write** (nothing else)
   - Set an expiration (for example, the end of November 2026)
4. Open `https://abdonmorales.github.io/election26/admin.html`, paste the token, and sign in.

## Using the desk

1. For each race pick a status: *No projection yet*, *Toss-up*, *Projection*, or *Race called*.
2. For a projection or call, pick the winner and set the margin (slider, number box, or the ±/preset buttons). The preview shows the exact top-bar text.
3. Optionally add a custom headline for the top bar or a note under a race.
4. On election night, open **County results** and paste lines of `County, Republican votes, Democratic votes, % reporting` (county name or FIPS code; tab-separated paste from a spreadsheet works too), then **Apply results**.
5. Click **Publish**. This commits `data/projections.json` to `main`, Pages redeploys (usually under a minute), and open browsers pick up the change on their next 20-second check. Each changed projection is logged to the feed automatically.

## Security

- The site is fully static. There is no password in the code: the only thing that can change the site is a GitHub commit, so publishing requires a token with write access to this repo.
- The desk checks that the token can push to the repo before showing the editor. The token stays in that browser tab's `sessionStorage` (it is cleared when the tab closes or you sign out) and is only sent to `api.github.com`.
- Both pages use a Content-Security-Policy; the desk loads no third-party scripts at all, and the public page loads d3 and topojson from jsDelivr with Subresource Integrity hashes. All user-entered text is rendered with `textContent`, never as HTML.
- Edits use the file's SHA, so a publish from a stale copy (for example, from a second device) is rejected instead of overwriting newer changes.
- If a token leaks, revoke it at <https://github.com/settings/personal-access-tokens>; every change is also a normal git commit that can be reverted.

## Local preview

```sh
python3 -m http.server 8000
# open http://localhost:8000/ and http://localhost:8000/admin.html
```

## Data sources

- County boundaries: U.S. Census Bureau via [us-atlas](https://github.com/topojson/us-atlas) (Texas counties extracted to `data/tx-counties.topo.json`).
- 2024 presidential results by county: [tonmcg/US_County_Level_Election_Results_08-24](https://github.com/tonmcg/US_County_Level_Election_Results_08-24).
