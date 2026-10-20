import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEvElection, parseEvDates, parseEvReport, buildPayload, fetchEarlyVoting, sanity } from "../pipeline/sources/earlyvoting.js";
import { fixture, dataJSON } from "./helpers.js";

const baseline = dataJSON("baseline-2024.json");
const details = fixture("earlyvoting/details.html");
const dates = fixture("earlyvoting/dates-2024.html");
const report = fixture("earlyvoting/report-2024-11-01.html");

test("pickEvElection finds November generals by year", () => {
  assert.deepEqual(pickEvElection(details, 2024), { id: "49664", name: "2024 NOVEMBER 5TH GENERAL ELECTION" });
  assert.deepEqual(pickEvElection(details, 2022), { id: "47009", name: "2022 NOVEMBER 8TH GENERAL ELECTION" });
  assert.equal(pickEvElection(details, 2026), null);
});

test("parseEvDates keeps report dates before Election Day", () => {
  const { electionDate, dates: list } = parseEvDates(dates);
  assert.equal(electionDate, "2024-11-05");
  assert.equal(list.length, 34);
  assert.deepEqual(list[0], { date: "2024-09-29", value: "2024-09-29 00:00:00.0" });
  assert.equal(list.at(-1).date, "2024-11-01");
  assert.ok(list.every((d) => d.date < "2024-11-05"));
});

test("parseEvReport reads every county and matches the SOS TOTAL row", () => {
  const r = parseEvReport(report, baseline);
  assert.equal(Object.keys(r.counties).length, 254);
  assert.deepEqual(r.counties["48201"], [2693055, 1176426, 53500, 1229926]); // Harris
  assert.deepEqual(r.total, { registered: 18623931, inPerson: 8715935, mail: 342501, total: 9058436 });
  assert.equal(r.inPersonDay, 884542);
});

test("parseEvReport rejects a truncated or renamed table", () => {
  const truncated = report.replace(/<tr>(?:(?!<\/tr>)[\s\S])*?<\/tr>/g, (row, i) => (i > report.length / 3 ? "" : row));
  assert.throws(() => parseEvReport(truncated, baseline), /only \d+ counties/);
  assert.throws(() => parseEvReport(report.replace(/Registered Voters/g, "RV"), baseline), /table not found/);
  assert.throws(() => parseEvReport(report.replace("HARRIS", "ATLANTIS"), baseline), /Unmatched counties: ATLANTIS/);
});

test("buildPayload merges history and uses the latest day for the map", () => {
  const parsed = parseEvReport(report, baseline);
  const prevHistory = [{ date: "2024-10-31", inPersonDay: 1, inPerson: 7000000, mail: 300000, total: 7300000, pct: 39.2 }];
  const p = buildPayload({ election: { id: "49664", name: "x" }, electionDate: "2024-11-05", prevHistory, reports: [{ date: "2024-11-01", parsed }] });
  assert.equal(p.asOf, "2024-11-01");
  assert.equal(p.total, 9058436);
  assert.equal(p.turnoutPct, 48.6);
  assert.deepEqual(p.history.map((h) => h.date), ["2024-10-31", "2024-11-01"]);
  assert.equal(Object.keys(p.counties).length, 254);
});

test("fetchEarlyVoting only re-fetches new days and the two most recent", async () => {
  const fetched = [];
  const client = {
    details: async () => details,
    dates: async () => dates,
    report: async (id, value) => { fetched.push(value.slice(0, 10)); return report; },
  };
  const { dates: all } = parseEvDates(dates);
  const prev = { election: { id: "49664" }, history: all.slice(0, -3).map((d) => ({ date: d.date, inPersonDay: 0, inPerson: 0, mail: 0, total: 1, pct: 0 })) };
  const out = await fetchEarlyVoting({ client, year: 2024, baseline, prev });
  assert.equal(out.ok, true);
  assert.deepEqual(fetched, ["2024-10-30", "2024-10-31", "2024-11-01"]);
  assert.equal(out.races.statewide.history.length, 34);
});

test("fetchEarlyVoting reports a not-yet-listed election as unavailable, not an error", async () => {
  const out = await fetchEarlyVoting({ client: { details: async () => details }, year: 2026, baseline, prev: null });
  assert.equal(out.ok, true);
  assert.equal(out.races.statewide.available, false);
});

test("sanity refuses a shrinking curve or falling totals", () => {
  const prev = { available: true, history: [{}, {}], total: 50000 };
  assert.match(sanity(prev, { available: true, history: [{}], total: 50000 }), /shrank/);
  assert.match(sanity(prev, { available: true, history: [{}, {}], total: 100 }), /fell/);
  assert.equal(sanity(prev, { available: true, history: [{}, {}, {}], total: 60000 }), null);
});
