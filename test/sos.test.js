import { test } from "node:test";
import assert from "node:assert/strict";
import { pickElection, parseResults, sanity } from "../pipeline/sources/sos.js";
import { fixtureJSON, dataJSON } from "./helpers.js";

const baseline = dataJSON("baseline-2024.json");
const constants = fixtureJSON("sos/ElectionConstants.json");
const home = fixtureJSON("sos/Home.json");
const countyData = fixtureJSON("sos/County.json");
const raceDefs = {
  senate: { sosOffice: /^\s*U\.?\s*S\.?\s*SENATOR\b/i },
  president: { sosOffice: /^PRESIDENT/i },
};
const election = { id: "49664", name: "2024 NOVEMBER 5TH GENERAL ELECTION" };

test("pickElection finds the November general for a year", () => {
  assert.deepEqual(pickElection(constants, 2024), election);
});

test("pickElection returns null until the year is published", () => {
  assert.equal(pickElection(constants, 2026), null);
});

test("pickElection falls back to currentelectionInfo", () => {
  const c = { electionInfo: {}, currentelectionInfo: { ID: "51000", Y: "2026", ET: "G", N: "2026 NOVEMBER 3RD GENERAL ELECTION" } };
  assert.deepEqual(pickElection(c, 2026), { id: "51000", name: "2026 NOVEMBER 3RD GENERAL ELECTION" });
});

test("parseResults builds county returns keyed by FIPS with statewide totals", () => {
  const { races } = parseResults({ countyData, home, election, baseline, raceDefs });
  const s = races.senate;
  assert.equal(s.available, true);
  assert.equal(s.office, "U. S. SENATOR");
  assert.deepEqual(s.counties["48201"], [666027, 841784, 100, 1548914 - 666027 - 841784]);
  assert.deepEqual(s.counties["48301"], [75, 17, 100, 3]);
  assert.equal(Object.keys(s.counties).length, 4);
  assert.equal(s.candidates.D.name, "Colin Allred");
  assert.equal(s.candidates.D.votes, 3872 + 841784 + 407210 + 17);
  assert.equal(s.candidates.R.votes, 15022 + 666027 + 157203 + 75);
  assert.equal(s.pctReporting, 100);
  assert.equal(s.countiesReporting, 4);
  assert.equal(s.sosTimestamp, "Nov 26, 2024 12:57:43");
  // Presidential returns must match the 2024 baseline we ship.
  for (const fips of Object.keys(countyData)) {
    assert.equal(races.president.counties[fips][0], baseline.counties[fips][1]);
    assert.equal(races.president.counties[fips][1], baseline.counties[fips][2]);
  }
});

test("parseResults maps counties by name when the key is not a FIPS code", () => {
  const renamed = { "1": countyData["48453"] };
  const { races } = parseResults({ countyData: renamed, home, election, baseline, raceDefs });
  assert.ok(races.senate.counties["48453"]);
});

test("parseResults rejects counties it cannot map", () => {
  const bad = { XYZ: { ...countyData["48001"], N: "ATLANTIS" } };
  assert.throws(() => parseResults({ countyData: bad, home, election, baseline, raceDefs }), /Unmatched counties: ATLANTIS/);
});

test("parseResults marks a race unavailable when the office is absent", () => {
  const { races } = parseResults({ countyData, home, election, baseline, raceDefs: { governor: { sosOffice: /^GOVERNOR$/i } } });
  assert.equal(races.governor.available, false);
});

test("county percent falls back to precincts reported when Summary is missing", () => {
  const e = structuredClone(countyData["48001"]);
  delete e.Summary;
  e.Races["7958"].PR = 6; e.Races["7958"].TPR = 24;
  const { races } = parseResults({ countyData: { "48001": e }, home, election, baseline, raceDefs: { senate: raceDefs.senate } });
  assert.equal(races.senate.counties["48001"][2], 25);
});

test("sanity refuses shrinking or vanished returns", () => {
  const { races } = parseResults({ countyData, home, election, baseline, raceDefs });
  const prev = races.senate;
  assert.equal(sanity(prev, prev), null);
  assert.match(sanity(prev, { ...prev, available: false }), /disappeared/);
  assert.match(sanity(prev, { ...prev, totalVotes: 100 }), /votes fell/);
  assert.match(sanity(prev, { ...prev, counties: {} }), /county count/);
  assert.equal(sanity(undefined, prev), null);
});
