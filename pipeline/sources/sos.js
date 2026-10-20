// Texas Secretary of State election-night results (https://results.texas-election.com).
//
// The results site is an Angular app with no documented API. It loads static JSON:
//   /static/data/Version.json                         -> { ___versionNo }            (site constants version)
//   /static/data/ElectionConstants_<v>.json           -> list of elections by year/type + current election
//   /static/data/election/<id>/Version.json           -> { ___versionNo }            (results snapshot version)
//   /static/data/election/<id>/<ev>/Home.json         -> statewide precinct/county reporting counts
//   /static/data/election/<id>/<ev>/County.json       -> every county (keyed by FIPS) with every race's candidates
// The site sits behind a Cloudflare bot check, so plain requests can get a 403 challenge page. When
// that happens we open the page in headless Chromium (Playwright) and fetch the same JSON from
// inside the page, exactly as the site itself does.

import { fetchJSON, HttpError } from "../lib/http.js";

export const SOS_ORIGIN = "https://results.texas-election.com";
export const SOS_PAGE = `${SOS_ORIGIN}/races`;
const DATA = `${SOS_ORIGIN}/static/data`;

export const META = { name: "Texas Secretary of State", url: SOS_PAGE };

/* ---------------- Pure parsing (unit tested) ---------------- */

/** Find the November general election for `year` in ElectionConstants. Returns { id, name } or null. */
export function pickElection(constants, year) {
  const y = String(year);
  const generals = constants?.electionInfo?.[y]?.G || {};
  const entries = Object.entries(generals).map(([id, e]) => ({ id: String(id), name: e.N || "" }));
  const nov = entries.find((e) => /NOVEMBER/i.test(e.name) && /GENERAL/i.test(e.name)) || entries[0];
  if (nov) return nov;
  const cur = constants?.currentelectionInfo;
  if (cur && String(cur.Y) === y && cur.ET === "G" && cur.ID) return { id: String(cur.ID), name: cur.N || "" };
  return null;
}

const normName = (s) => String(s || "").toUpperCase().replace(/[^A-Z]/g, "");

/** Map a SOS county entry to a FIPS code present in the baseline. */
export function countyFips(key, entry, baseline, nameIndex) {
  if (/^48\d{3}$/.test(key) && baseline.counties[key]) return key;
  return nameIndex.get(normName(entry?.N)) || null;
}

export function buildNameIndex(baseline) {
  return new Map(Object.entries(baseline.counties).map(([fips, row]) => [normName(row[0]), fips]));
}

const pct1 = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

/**
 * Turn County.json + Home.json into per-race payloads.
 * raceDefs: { raceId: { sosOffice: RegExp } }
 * Returns { races: { raceId: payload }, warnings: [] } or throws on structural problems.
 */
export function parseResults({ countyData, home, election, baseline, raceDefs }) {
  if (!countyData || typeof countyData !== "object") throw new Error("County.json is empty or not an object");
  const nameIndex = buildNameIndex(baseline);
  const unmatched = [];
  const races = {};

  for (const [raceId, def] of Object.entries(raceDefs)) {
    races[raceId] = {
      available: false,
      election,
      office: null,
      candidates: { D: { name: null, votes: 0, pct: 0 }, R: { name: null, votes: 0, pct: 0 } },
      otherVotes: 0,
      totalVotes: 0,
      pctReporting: 0,
      countiesReporting: 0,
      sosTimestamp: home?.LastUpdatedTime || null,
      counties: {},
    };
  }

  for (const [key, entry] of Object.entries(countyData)) {
    const fips = countyFips(key, entry, baseline, nameIndex);
    if (!fips) { unmatched.push(entry?.N || key); continue; }
    const summaryPct = typeof entry?.Summary?.P === "number" ? entry.Summary.P : null;

    for (const [raceId, def] of Object.entries(raceDefs)) {
      const race = Object.values(entry?.Races || {}).find((r) => def.sosOffice.test(r.ON || ""));
      if (!race) continue;
      const out = races[raceId];
      out.available = true;
      out.office ??= String(race.ON).trim();
      let r = 0, d = 0;
      for (const c of Object.values(race.C || {})) {
        const v = Number(c.V) || 0;
        if (c.P === "REP" || c.P === "R") { r += v; out.candidates.R.name ??= titleCase(c.N); }
        else if (c.P === "DEM" || c.P === "D") { d += v; out.candidates.D.name ??= titleCase(c.N); }
      }
      const total = Math.max(Number(race.T) || 0, r + d);
      const pct = summaryPct ?? (race.TPR ? pct1(race.PR || 0, race.TPR) : 0);
      out.counties[fips] = [r, d, Math.round(pct * 10) / 10, total - r - d];
      out.candidates.R.votes += r;
      out.candidates.D.votes += d;
      out.totalVotes += total;
      if (total > 0 || pct > 0) out.countiesReporting += 1;
    }
  }

  if (unmatched.length) throw new Error(`Unmatched counties: ${unmatched.slice(0, 5).join(", ")}`);

  const pr = home?.PrecinctsReporting;
  for (const out of Object.values(races)) {
    out.otherVotes = out.totalVotes - out.candidates.R.votes - out.candidates.D.votes;
    out.candidates.R.pct = pct1(out.candidates.R.votes, out.totalVotes);
    out.candidates.D.pct = pct1(out.candidates.D.votes, out.totalVotes);
    out.pctReporting = pr?.PT ? pct1(pr.PR, pr.PT) : 0;
    // Stable key order keeps diffs (and commits) minimal.
    out.counties = Object.fromEntries(Object.entries(out.counties).sort(([a], [b]) => a.localeCompare(b)));
  }
  return { races };
}

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/(^|[\s\-'./])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

/** Sanity check: refuse payloads that would wipe out or sharply shrink data we already have. */
export function sanity(prev, next) {
  if (!prev?.available) return null;
  if (!next.available) return "race disappeared from the SOS feed";
  const prevCounties = Object.keys(prev.counties || {}).length;
  const nextCounties = Object.keys(next.counties || {}).length;
  if (nextCounties < prevCounties * 0.9) return `county count fell from ${prevCounties} to ${nextCounties}`;
  if (prev.totalVotes > 10000 && next.totalVotes < prev.totalVotes * 0.8) {
    return `statewide votes fell from ${prev.totalVotes} to ${next.totalVotes}`;
  }
  return null;
}

/* ---------------- Fetching ---------------- */

const isChallenge = (err) => err instanceof HttpError && (err.status === 403 || err.status === 503 || /just a moment|cf-chl|challenge/i.test(err.body || ""));

export class SosClient {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.browser = null;
    this.page = null;
  }

  async get(path) {
    if (!this.page) {
      try {
        return await fetchJSON(`${DATA}/${path}`, { retries: 1 });
      } catch (err) {
        if (!isChallenge(err)) throw err;
        this.log(`SOS: plain request blocked (${err.message}); switching to headless browser`);
        await this.openBrowser();
      }
    }
    const res = await this.page.evaluate(async (url) => {
      const r = await fetch(url, { cache: "no-store" });
      return { status: r.status, text: await r.text() };
    }, `${DATA}/${path}`);
    if (res.status !== 200) {
      // Clearance can expire during a long election night; start over on the next call.
      if (res.status === 403 || res.status === 503) await this.close();
      throw new HttpError(`HTTP ${res.status} for ${path} (browser)`, res.status);
    }
    try { return JSON.parse(res.text); } catch { throw new Error(`Invalid JSON for ${path} (browser)`); }
  }

  async openBrowser() {
    let playwright;
    try {
      playwright = await import("playwright");
    } catch {
      throw new Error("SOS site requires a browser (Cloudflare check) but Playwright is not installed");
    }
    const launch = { args: ["--disable-blink-features=AutomationControlled"] };
    if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY };
    this.browser = await playwright.chromium.launch(launch);
    const ctx = await this.browser.newContext({ ignoreHTTPSErrors: !!process.env.HTTPS_PROXY });
    this.page = await ctx.newPage();
    await this.page.goto(SOS_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Wait until Cloudflare has let us through and the app has loaded its own data.
    await this.page.waitForFunction(() => !/just a moment/i.test(document.title), null, { timeout: 60000 });
    await this.page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = this.page = null;
  }
}

/** Fetch and parse. Returns an outcome for store.applySource. */
export async function fetchSos({ client, year, baseline, raceDefs }) {
  try {
    const { ___versionNo: siteVersion } = await client.get("Version.json");
    const constants = await client.get(`ElectionConstants_${siteVersion}.json`);
    const election = pickElection(constants, year);
    if (!election) {
      const waiting = Object.fromEntries(Object.keys(raceDefs).map((id) => [id, {
        available: false, election: null, office: null,
        candidates: { D: { name: null, votes: 0, pct: 0 }, R: { name: null, votes: 0, pct: 0 } },
        otherVotes: 0, totalVotes: 0, pctReporting: 0, countiesReporting: 0, sosTimestamp: null, counties: {},
      }]));
      return { ok: true, races: waiting, note: `SOS has not published the ${year} general election yet` };
    }
    const { ___versionNo: ev } = await client.get(`election/${election.id}/Version.json`);
    const [home, countyData] = [
      await client.get(`election/${election.id}/${ev}/Home.json`),
      await client.get(`election/${election.id}/${ev}/County.json`),
    ];
    const { races } = parseResults({ countyData, home, election, baseline, raceDefs });
    const missing = Object.entries(races).filter(([, r]) => !r.available).map(([id]) => id);
    if (missing.length) return { ok: false, error: `Office not found in ${election.name}: ${missing.join(", ")}` };
    return { ok: true, races };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
