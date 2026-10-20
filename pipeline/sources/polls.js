// Polls from the Wikipedia articles for each race, filtered to trusted pollsters, plus an average.
//
// We read the article HTML (https://en.wikipedia.org/wiki/<page>), take the "General election"
// section, and find the head-to-head table whose header names both nominees next to "Poll source".

import { fetchText } from "../lib/http.js";
import { findTables, parseTable, sectionById, attr } from "../lib/html-table.js";

export const META = { name: "Wikipedia polling tables", url: "https://en.wikipedia.org" };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthIndex = (s) => MONTHS.findIndex((m) => m.startsWith(String(s).toLowerCase().slice(0, 3)));
const lastName = (full) => full.trim().split(/\s+/).pop();
const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** "October 8–16, 2026" | "September 30 – October 14, 2026" | "Dec 28, 2025 – Jan 3, 2026" | "October 5, 2026" */
export function parseDateRange(text) {
  const t = text.replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();
  const parts = t.split(/\s*-\s*/);
  const tokRe = /([A-Za-z]+)?\.?\s*(\d{1,2})?(?:,?\s*(\d{4}))?/;
  const parse = (p) => {
    const m = tokRe.exec(p.trim());
    return { month: m?.[1] && monthIndex(m[1]) >= 0 ? monthIndex(m[1]) : null, day: m?.[2] ? Number(m[2]) : null, year: m?.[3] ? Number(m[3]) : null };
  };
  const a = parse(parts[0]);
  const b = parts.length > 1 ? parse(parts[parts.length - 1]) : { ...a };
  const year = b.year ?? a.year;
  if (year === null) return null;
  const endMonth = b.month ?? a.month;
  const startMonth = a.month ?? endMonth;
  if (endMonth === null || b.day === null) return null;
  const startYear = a.year ?? (startMonth > endMonth ? year - 1 : year);
  return { start: iso(startYear, startMonth, a.day ?? b.day), end: iso(year, endMonth, b.day) };
}

/** "1,492 (LV)" -> { n: 1492, population: "LV" } */
export function parseSample(text) {
  const n = Number((/([\d,]+)/.exec(text)?.[1] || "").replace(/,/g, "")) || null;
  const pop = /\((LV|RV|A|V)\)/i.exec(text)?.[1]?.toUpperCase() || null;
  return { n, population: pop === "V" ? "RV" : pop };
}

const pctValue = (text) => {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(text) || /^(\d+(?:\.\d+)?)$/.exec(text.trim());
  return m ? Number(m[1]) : null;
};

/** Pick the general-election head-to-head table and turn its rows into polls. */
export function extractPolls(html, candidates) {
  const section = sectionById(html, "General_election") || html;
  const dName = lastName(candidates.D).toLowerCase();
  const rName = lastName(candidates.R).toLowerCase();

  for (const tableHtml of findTables(section)) {
    const grid = parseTable(tableHtml);
    if (grid.length < 2) continue;
    const header = grid[0].map((c) => c?.text.toLowerCase() || "");
    const col = {
      source: header.findIndex((h) => /poll source/.test(h)),
      dates: header.findIndex((h) => /date/.test(h)),
      sample: header.findIndex((h) => /sample/.test(h)),
      D: header.findIndex((h) => h.includes(dName)),
      R: header.findIndex((h) => h.includes(rName)),
    };
    if (Object.values(col).some((i) => i < 0)) continue; // aggregate tables and hypothetical matchups

    const polls = [];
    for (const row of grid.slice(1)) {
      if (!row[col.source] || row[col.source].tag === "th") continue;
      const D = pctValue(row[col.D]?.text || "");
      const R = pctValue(row[col.R]?.text || "");
      const dates = parseDateRange(row[col.dates]?.text || "");
      if (D === null || R === null || !dates) continue;
      const { n, population } = parseSample(row[col.sample]?.text || "");
      const src = row[col.source];
      const href = attr(/<a\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(src.html)?.[0] || "", "href");
      polls.push({
        pollster: src.text.replace(/\s*\[\w+\]\s*/g, " ").trim(),
        start: dates.start,
        end: dates.end,
        n,
        population,
        D, R,
        margin: Math.round((R - D) * 10) / 10,
        url: href && /^https?:\/\//.test(href) ? href : null,
      });
    }
    // A pollster's LV/RV versions of one poll often share a single sample-size cell; borrow it.
    for (const p of polls) {
      if (p.n) continue;
      const twin = polls.find((q) => q !== p && q.n && q.pollster === p.pollster && q.end === p.end);
      if (twin) p.n = twin.n;
    }
    if (polls.length) return polls;
  }
  return [];
}

export function trustedName(pollster, trusted) {
  return trusted.find((t) => t.match.test(pollster))?.name || null;
}

/**
 * Weighted average. Each pollster counts once (its most recent poll; LV preferred over RV for the
 * same field dates). Weight = recency (half-life) x sqrt(sample) x population factor.
 */
export function pollingAverage(polls, params, asOf) {
  const asOfMs = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  const rank = { LV: 0, RV: 1, A: 2 };
  const latest = new Map();
  for (const p of polls) {
    const age = (asOfMs - Date.parse(`${p.end}T00:00:00Z`)) / 86400000;
    if (age > params.maxAgeDays || age < -1) continue;
    const key = p.trustedAs || p.pollster;
    const cur = latest.get(key);
    if (!cur || p.end > cur.end || (p.end === cur.end && (rank[p.population] ?? 3) < (rank[cur.population] ?? 3))) latest.set(key, p);
  }
  const used = [...latest.values()];
  if (!used.length) return null;

  let wSum = 0, mSum = 0, dSum = 0, rSum = 0;
  const contributions = used.map((p) => {
    const age = Math.max(0, (asOfMs - Date.parse(`${p.end}T00:00:00Z`)) / 86400000);
    const pop = params.population[p.population] || params.population.RV;
    const sizeW = p.n ? Math.min(params.maxSampleWeight, Math.sqrt(p.n / params.baseSample)) : 0.6;
    const w = 0.5 ** (age / params.halfLifeDays) * sizeW * pop.weight;
    const margin = p.margin + pop.shift;
    wSum += w; mSum += w * margin;
    dSum += w * (p.D - pop.shift / 2); rSum += w * (p.R + pop.shift / 2);
    return { pollster: p.pollster, end: p.end, weight: Math.round(w * 1000) / 1000, adjustedMargin: Math.round(margin * 10) / 10 };
  });
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    margin: r1(mSum / wSum),
    D: r1(dSum / wSum),
    R: r1(rSum / wSum),
    pollCount: used.length,
    asOf: asOf.slice(0, 10),
    latestPoll: used.map((p) => p.end).sort().pop(),
    contributions: contributions.sort((a, b) => b.weight - a.weight),
  };
}

/**
 * Build one race's payload from page HTML. Ages are measured from the newest trusted poll, not
 * from "now": with exponential decay that gives the same average, and the file only changes when
 * the polls do (instead of every day as weights tick down).
 */
export function buildRacePolls(html, def, trusted, params, pageUrl) {
  const all = extractPolls(html, def.candidates);
  if (!all.length) throw new Error(`no head-to-head polling table found for ${def.candidates.D} vs. ${def.candidates.R}`);
  const polls = all
    .map((p) => ({ ...p, trustedAs: trustedName(p.pollster, trusted) }))
    .filter((p) => p.trustedAs)
    .sort((a, b) => b.end.localeCompare(a.end) || a.pollster.localeCompare(b.pollster));
  const asOf = polls[0]?.end;
  return {
    page: pageUrl,
    candidates: def.candidates,
    totalPollsOnPage: all.length,
    polls,
    average: asOf ? pollingAverage(polls, params, asOf) : null,
  };
}

export function sanity(prev, next) {
  if (prev?.polls?.length && !next.polls.length) return `parsed 0 trusted polls (previously ${prev.polls.length})`;
  if (prev?.totalPollsOnPage > 5 && next.totalPollsOnPage < prev.totalPollsOnPage / 2) {
    return `polling table shrank from ${prev.totalPollsOnPage} to ${next.totalPollsOnPage} rows`;
  }
  return null;
}

export async function fetchPolls(races, trusted, params) {
  const out = {};
  try {
    for (const [id, def] of Object.entries(races)) {
      const url = `https://en.wikipedia.org/wiki/${def.wikipedia.page}`;
      const html = await fetchText(url, { retries: 3, timeoutMs: 30000 });
      out[id] = buildRacePolls(html, def, trusted, params, url);
    }
    return { ok: true, races: out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
