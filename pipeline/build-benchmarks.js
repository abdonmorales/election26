#!/usr/bin/env node
// One-off: build data/turnout-benchmarks.json, the early-vote curves of past Texas general
// elections (2022 midterm, 2024 presidential) that the site compares 2026 against. Also records
// each election's final turnout from the SOS results feed. Re-run only to add an election.
//
//   node pipeline/build-benchmarks.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EarlyVotingClient, pickEvElection, parseEvDates, parseEvReport } from "./sources/earlyvoting.js";
import { SosClient, pickElection, parseTurnout } from "./sources/sos.js";
import { loadSchema } from "./schemas.js";
import { validate } from "./lib/schema.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const YEARS = [2022, 2024];
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "baseline-2024.json"), "utf8"));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const ev = new EarlyVotingClient();
const sos = new SosClient();
const elections = [];
try {
  const details = await ev.details();
  for (const year of YEARS) {
    const election = pickEvElection(details, year);
    if (!election) throw new Error(`no ${year} general on the early-voting site`);
    const { electionDate, dates } = parseEvDates(await ev.dates(election.id));
    const history = [];
    for (const d of dates) {
      const { total } = parseEvReport(await ev.report(election.id, d.value), baseline);
      history.push({ date: d.date, daysBefore: daysBetween(d.date, electionDate), total: total.total, pct: Math.round((total.total / total.registered) * 1000) / 10 });
      console.log(year, d.date, total.total);
    }
    // Final turnout from the results site's County.json.
    const { ___versionNo: v } = await sos.get("Version.json");
    const resEl = pickElection(await sos.get(`ElectionConstants_${v}.json`), year);
    let final = null;
    if (resEl) {
      const { ___versionNo: rv } = await sos.get(`election/${resEl.id}/Version.json`);
      const t = parseTurnout({ countyData: await sos.get(`election/${resEl.id}/${rv}/County.json`), home: null, election: resEl, baseline });
      if (t) final = { registeredVoters: t.registeredVoters, ballotsCast: t.ballotsCast, turnoutPct: t.turnoutPct };
    }
    elections.push({ year, id: election.id, name: election.name, electionDate, final, history });
  }
} finally {
  await ev.close();
  await sos.close();
}

const doc = { schemaVersion: 1, source: "https://earlyvoting.texas-election.com and https://results.texas-election.com", elections };
const errors = validate(loadSchema("turnout-benchmarks"), doc);
if (errors.length) throw new Error(errors.join("; "));
fs.writeFileSync(path.join(ROOT, "data", "turnout-benchmarks.json"), JSON.stringify(doc, null, 2) + "\n");
console.log("wrote data/turnout-benchmarks.json");
