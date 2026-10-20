import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDateRange, parseSample, extractPolls, buildRacePolls, pollingAverage, trustedName, sanity } from "../pipeline/sources/polls.js";
import { RACES, TRUSTED_POLLSTERS, AVERAGE } from "../pipeline/config.js";
import { fixture } from "./helpers.js";

test("parseDateRange handles Wikipedia date formats", () => {
  assert.deepEqual(parseDateRange("October 8–16, 2026"), { start: "2026-10-08", end: "2026-10-16" });
  assert.deepEqual(parseDateRange("September 30 – October 14, 2026"), { start: "2026-09-30", end: "2026-10-14" });
  assert.deepEqual(parseDateRange("December 28, 2025 – January 3, 2026"), { start: "2025-12-28", end: "2026-01-03" });
  assert.deepEqual(parseDateRange("Dec 28 – Jan 3, 2026"), { start: "2025-12-28", end: "2026-01-03" });
  assert.deepEqual(parseDateRange("October 5, 2026"), { start: "2026-10-05", end: "2026-10-05" });
  assert.equal(parseDateRange("TBD"), null);
});

test("parseSample reads size and population", () => {
  assert.deepEqual(parseSample("1,492 (LV)"), { n: 1492, population: "LV" });
  assert.deepEqual(parseSample("800 (RV)"), { n: 800, population: "RV" });
  assert.deepEqual(parseSample("1,000 (V)"), { n: 1000, population: "RV" });
  assert.deepEqual(parseSample("–"), { n: null, population: null });
});

test("extractPolls reads the general-election head-to-head tables", () => {
  const senate = extractPolls(fixture("wikipedia/senate.html"), RACES.senate.candidates);
  const governor = extractPolls(fixture("wikipedia/governor.html"), RACES.governor.candidates);
  assert.equal(senate.length, 63);
  assert.equal(governor.length, 55);
  const uh = governor.find((p) => p.pollster === "University of Houston");
  assert.deepEqual({ ...uh, url: undefined }, {
    pollster: "University of Houston", start: "2026-10-10", end: "2026-10-14", n: 2000, population: "LV",
    D: 46, R: 49, margin: 3, url: undefined,
  });
  // HTML comments in a cell must not leak into the name (it mentions the NYT).
  assert.ok(senate.some((p) => p.pollster === "Pulse Decision Science (R)"));
});

test("trusted pollster matching", () => {
  const t = (s) => trustedName(s, TRUSTED_POLLSTERS);
  assert.equal(t("University of Texas/Texas Politics Project"), "Texas Politics Project (UT Austin)");
  assert.equal(t("University of Houston/ Texas Southern University"), "UH Hobby School");
  assert.equal(t("Texas Southern University"), "Texas Southern University (Texas Tribune partner)");
  assert.equal(t("New York Times/Siena University"), "NYT/Siena");
  assert.equal(t("Texas Public Opinion Research (D)"), "TPOR");
  assert.equal(t("Emerson College"), "Emerson College");
  assert.equal(t("Marist University"), "Marist");
  assert.equal(t("Quinnipiac University"), "Quinnipiac");
  assert.equal(t("Pulse Decision Science (R)"), null);
  assert.equal(t("Trafalgar Group (R)"), null);
  assert.equal(t("CBS News/YouGov"), null);
});

test("buildRacePolls keeps only trusted polls and averages them", () => {
  const r = buildRacePolls(fixture("wikipedia/senate.html"), RACES.senate, TRUSTED_POLLSTERS, AVERAGE, "https://en.wikipedia.org/wiki/x");
  assert.equal(r.totalPollsOnPage, 63);
  assert.ok(r.polls.length > 10);
  assert.ok(r.polls.every((p) => p.trustedAs));
  assert.equal(r.average.asOf, r.polls[0].end);
  assert.ok(r.average.pollCount <= new Set(r.polls.map((p) => p.trustedAs)).size);
  assert.ok(r.average.margin < 0 && r.average.margin > -10, `Talarico-leaning average expected, got ${r.average.margin}`);
});

test("pollingAverage: recency, sample size, LV preference and RV adjustment", () => {
  const base = { pollster: "A", trustedAs: "A", start: "2026-10-01", end: "2026-10-10", n: 800, population: "LV", D: 48, R: 46, margin: -2 };
  // Same field dates, LV and RV versions: LV wins.
  let avg = pollingAverage([base, { ...base, population: "RV", D: 50, R: 44, margin: -6 }], AVERAGE, "2026-10-10");
  assert.equal(avg.margin, -2);
  assert.equal(avg.pollCount, 1);
  // An RV-only poll is shifted toward R by the configured amount.
  avg = pollingAverage([{ ...base, population: "RV" }], AVERAGE, "2026-10-10");
  assert.equal(avg.margin, -2 + AVERAGE.population.RV.shift);
  // Two pollsters: the newer poll carries more weight.
  const older = { ...base, pollster: "B", trustedAs: "B", end: "2026-09-12", margin: 6, D: 44, R: 50 };
  avg = pollingAverage([base, older], AVERAGE, "2026-10-10");
  assert.ok(avg.margin < 2 && avg.margin > -2, `got ${avg.margin}`);
  // Larger samples weigh more.
  const big = { ...base, pollster: "C", trustedAs: "C", n: 2000, margin: 4, D: 45, R: 49 };
  const small = { ...base, pollster: "D", trustedAs: "D", n: 400, margin: -4, D: 49, R: 45 };
  assert.ok(pollingAverage([big, small], AVERAGE, "2026-10-10").margin > 0);
  // Too old: excluded.
  assert.equal(pollingAverage([{ ...base, end: "2025-01-01" }], AVERAGE, "2026-10-10"), null);
});

test("sanity refuses an empty or collapsed table", () => {
  const prev = { polls: [{}], totalPollsOnPage: 40 };
  assert.match(sanity(prev, { polls: [], totalPollsOnPage: 40 }), /0 trusted polls/);
  assert.match(sanity(prev, { polls: [{}], totalPollsOnPage: 3 }), /shrank/);
  assert.equal(sanity(prev, { polls: [{}], totalPollsOnPage: 41 }), null);
});
