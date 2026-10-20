// Early-voting turnout from the Texas SOS "Election Information & Turnout Data" site
// (https://earlyvoting.texas-election.com). Server-rendered pages, no API:
//
//   GET  /Elections/getElectionDetails.do                      -> <select id="idElection"> of elections
//   POST /Elections/getElectionEVDates.do   idElection=<id>    -> <select id="selectedDate"> of report dates
//                                                                 and <select id="electionDate">
//   POST /Elections/getEVDetails.do         idElection, selectedDate, webPageSyncDate=true
//        -> a table with one row per county: registered voters, in person that day, cumulative in
//           person, cumulative by mail, cumulative in person + mail, cumulative % of registered.
//
// Reports are cumulative, so each date's TOTAL row is one point on the turnout curve. We keep the
// curve in the data file and only re-fetch dates we don't have yet plus the two most recent ones
// (counties sometimes revise the latest day).

import { CloudflareSession } from "../lib/cfsession.js";
import { findTables, parseTable } from "../lib/html-table.js";
import { buildNameIndex } from "./sos.js";

export const EV_ORIGIN = "https://earlyvoting.texas-election.com";
export const EV_PAGE = `${EV_ORIGIN}/Elections/getElectionDetails.do`;
export const META = { name: "Texas SOS early-voting turnout", url: EV_PAGE };

/* ---------------- Pure parsing (unit tested) ---------------- */

const OPTION = /<option\b[^>]*\bvalue\s*=\s*"([^"]*)"[^>]*>([^<]*)/gi;

export function selectOptions(html, id) {
  const m = new RegExp(`<select\\b[^>]*\\bid\\s*=\\s*"${id}"[^>]*>([\\s\\S]*?)</select>`, "i").exec(html);
  if (!m) return [];
  return [...m[1].matchAll(OPTION)].map(([, value, text]) => ({ value: value.trim(), text: text.replace(/\s+/g, " ").trim() })).filter((o) => o.value);
}

/** The November general election for `year` in the election picker, or null. */
export function pickEvElection(detailsHtml, year) {
  const opt = selectOptions(detailsHtml, "idElection")
    .find((o) => o.text.startsWith(String(year)) && /NOVEMBER/i.test(o.text) && /GENERAL/i.test(o.text));
  return opt ? { id: opt.value, name: opt.text } : null;
}

/** Report dates strictly before Election Day, as YYYY-MM-DD, plus the election date. */
export function parseEvDates(datesHtml) {
  const electionDate = selectOptions(datesHtml, "electionDate")[0]?.value.slice(0, 10) || null;
  const dates = selectOptions(datesHtml, "selectedDate")
    .map((o) => ({ date: o.value.slice(0, 10), value: o.value }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && (!electionDate || d.date < electionDate));
  return { electionDate, dates };
}

const num = (t) => {
  const n = Number(String(t || "").replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const normName = (s) => String(s || "").toUpperCase().replace(/[^A-Z]/g, "");

/** Parse one day's county table. Returns { counties, total, inPersonDay } with counties keyed by FIPS. */
export function parseEvReport(html, baseline) {
  const grid = findTables(html).map(parseTable).find((g) => /county/i.test(g[0]?.[0]?.text || "") && g[0].some((c) => /registered/i.test(c?.text || "")));
  if (!grid) throw new Error("early-voting table not found");
  const header = grid[0].map((c) => c?.text.toLowerCase() || "");
  const col = {
    registered: header.findIndex((h) => /registered/.test(h)),
    day: header.findIndex((h) => /in person on/.test(h)),
    inPerson: header.findIndex((h) => /cumulative in-person voters/.test(h)),
    mail: header.findIndex((h) => /by mail/.test(h)),
    total: header.findIndex((h) => /in-person and mail/.test(h)),
  };
  for (const [k, i] of Object.entries(col)) if (i < 0) throw new Error(`early-voting column missing: ${k}`);

  const index = buildNameIndex(baseline);
  const counties = {};
  const unmatched = [];
  let totalRow = null;
  let inPersonDay = 0;
  for (const row of grid.slice(1)) {
    const name = row[0]?.text || "";
    if (!name) continue;
    const vals = { registered: num(row[col.registered]?.text), day: num(row[col.day]?.text), inPerson: num(row[col.inPerson]?.text), mail: num(row[col.mail]?.text), total: num(row[col.total]?.text) };
    if (/^total$/i.test(name.trim())) { totalRow = vals; continue; }
    const fips = index.get(normName(name));
    if (!fips) { unmatched.push(name); continue; }
    // Some counties report mail ballots only; keep total >= in person + mail when they disagree.
    const total = Math.max(vals.total, vals.inPerson + vals.mail);
    counties[fips] = [vals.registered, vals.inPerson, vals.mail, total];
    inPersonDay += vals.day;
  }
  if (unmatched.length) throw new Error(`Unmatched counties: ${unmatched.slice(0, 5).join(", ")}`);
  if (Object.keys(counties).length < 240) throw new Error(`only ${Object.keys(counties).length} counties in the early-voting table`);

  const sum = (i) => Object.values(counties).reduce((a, c) => a + c[i], 0);
  const total = { registered: sum(0), inPerson: sum(1), mail: sum(2), total: sum(3) };
  if (totalRow && totalRow.registered && Math.abs(totalRow.registered - total.registered) > total.registered * 0.005) {
    throw new Error(`county rows (${total.registered}) do not add up to the TOTAL row (${totalRow.registered})`);
  }
  return { counties: Object.fromEntries(Object.entries(counties).sort(([a], [b]) => a.localeCompare(b))), total, inPersonDay };
}

const pct1 = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

export function emptyPayload(election = null) {
  return { available: false, election, electionDate: null, asOf: null, registeredVoters: 0, inPerson: 0, mail: 0, total: 0, turnoutPct: 0, history: [], counties: {} };
}

/** Combine the previous curve with freshly parsed days into the stored payload. */
export function buildPayload({ election, electionDate, prevHistory = [], reports }) {
  const byDate = new Map(prevHistory.map((h) => [h.date, h]));
  for (const { date, parsed } of reports) {
    byDate.set(date, {
      date,
      inPersonDay: parsed.inPersonDay,
      inPerson: parsed.total.inPerson,
      mail: parsed.total.mail,
      total: parsed.total.total,
      pct: pct1(parsed.total.total, parsed.total.registered),
    });
  }
  const history = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const latest = reports.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!latest) return { ...emptyPayload(election), available: true, electionDate, history };
  const t = latest.parsed.total;
  return {
    available: true,
    election,
    electionDate,
    asOf: latest.date,
    registeredVoters: t.registered,
    inPerson: t.inPerson,
    mail: t.mail,
    total: t.total,
    turnoutPct: pct1(t.total, t.registered),
    history,
    counties: latest.parsed.counties,
  };
}

export function sanity(prev, next) {
  if (!prev?.available || !next.available) return null;
  if (next.history.length < prev.history.length) return `turnout history shrank from ${prev.history.length} to ${next.history.length} days`;
  if (prev.total > 10000 && next.total < prev.total * 0.9) return `early votes fell from ${prev.total} to ${next.total}`;
  return null;
}

/* ---------------- Fetching ---------------- */

export class EarlyVotingClient {
  constructor({ log = console.log } = {}) {
    this.session = new CloudflareSession({ origin: EV_ORIGIN, landing: EV_PAGE, log });
  }
  details() { return this.session.text("/Elections/getElectionDetails.do"); }
  dates(id) { return this.session.text("/Elections/getElectionEVDates.do", { form: { idElection: id } }); }
  report(id, value) { return this.session.text("/Elections/getEVDetails.do", { form: { idElection: id, selectedDate: value, webPageSyncDate: "true" } }); }
  close() { return this.session.close(); }
}

/** Fetch new days and return an outcome for store.applySource (key: "earlyvoting"). */
export async function fetchEarlyVoting({ client, year, baseline, prev }) {
  try {
    const election = pickEvElection(await client.details(), year);
    if (!election) return { ok: true, races: { statewide: emptyPayload() }, note: `SOS early-voting site has no ${year} general election yet` };
    const { electionDate, dates } = parseEvDates(await client.dates(election.id));
    const have = new Set((prev?.election?.id === election.id ? prev.history : []).map((h) => h.date));
    const recent = new Set(dates.slice(-2).map((d) => d.date));
    const todo = dates.filter((d) => !have.has(d.date) || recent.has(d.date));
    const reports = [];
    for (const d of todo) reports.push({ date: d.date, parsed: parseEvReport(await client.report(election.id, d.value), baseline) });
    // The latest day's county table is needed for the map even if nothing else is new.
    const prevHistory = prev?.election?.id === election.id ? prev.history : [];
    return { ok: true, races: { statewide: buildPayload({ election, electionDate, prevHistory, reports }) } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
