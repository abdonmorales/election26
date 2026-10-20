#!/usr/bin/env node
// Data pipeline entry point.
//
//   node pipeline/run.js                              # fetch everything once, write changed files
//   node pipeline/run.js --sources polls,markets      # only some sources
//   node pipeline/run.js --window week                # no-op unless inside election week (and not the night loop)
//   node pipeline/run.js --loop --until <ISO>         # election night: loop, commit + push + deploy each change
//
// Writes data/results.json, data/polls.json, data/markets.json. Prints which files changed and,
// under GitHub Actions, sets the step output `changed=true|false`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ELECTION, RACES, TRUSTED_POLLSTERS, AVERAGE } from "./config.js";
import { loadSchema } from "./schemas.js";
import { readJSON, emptyDoc, applySourceValidated, writeIfChanged } from "./lib/store.js";
import * as sos from "./sources/sos.js";
import * as pollsSrc from "./sources/polls.js";
import * as markets from "./sources/markets.js";
import { commitAndPush, dispatchPages } from "./lib/git.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const RACE_IDS = Object.keys(RACES);

function parseArgs(argv) {
  const args = { sources: ["results", "polls", "markets"], loop: false, until: null, interval: 75, window: null, branch: process.env.GITHUB_REF_NAME || "main" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sources") args.sources = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--loop") args.loop = true;
    else if (a === "--until") args.until = argv[++i];
    else if (a === "--interval") args.interval = Number(argv[++i]);
    else if (a === "--window") args.window = argv[++i];
    else if (a === "--branch") args.branch = argv[++i];
    else throw new Error(`Unknown argument ${a}`);
  }
  return args;
}

const log = (...m) => console.log(new Date().toISOString(), ...m);
const inWindow = (now, start, end) => now >= Date.parse(start) && now < Date.parse(end);

/* ---------------- One pass per data file ---------------- */

async function updateResults(now, ctx) {
  const file = path.join(DATA, "results.json");
  const schema = loadSchema("results");
  const prev = readJSON(file) || emptyDoc(RACE_IDS);
  const baseline = readJSON(path.join(DATA, "baseline-2024.json"));
  const raceDefs = Object.fromEntries(Object.entries(RACES).map(([id, r]) => [id, { sosOffice: r.sosOffice }]));
  ctx.sosClient ??= new sos.SosClient({ log });
  const outcome = await sos.fetchSos({ client: ctx.sosClient, year: ELECTION.year, baseline, raceDefs });
  if (outcome.note) log(`results: ${outcome.note}`);
  if (!outcome.ok) log(`results: FAILED — ${outcome.error}`);
  const doc = applySourceValidated(prev, "sos", sos.META, outcome, now, schema, { sanity: sos.sanity });
  return writeIfChanged(file, doc, schema) ? file : null;
}

async function updatePolls(now) {
  const file = path.join(DATA, "polls.json");
  const schema = loadSchema("polls");
  const prev = readJSON(file) || emptyDoc(RACE_IDS);
  const outcome = await pollsSrc.fetchPolls(RACES, TRUSTED_POLLSTERS, AVERAGE);
  if (!outcome.ok) log(`polls: FAILED — ${outcome.error}`);
  else for (const [id, r] of Object.entries(outcome.races)) log(`polls: ${id} ${r.polls.length}/${r.totalPollsOnPage} trusted, average ${r.average?.margin ?? "n/a"}`);
  const doc = applySourceValidated(prev, "wikipedia", pollsSrc.META, outcome, now, schema, { sanity: pollsSrc.sanity });
  return writeIfChanged(file, doc, schema) ? file : null;
}

async function updateMarkets(now) {
  const file = path.join(DATA, "markets.json");
  const schema = loadSchema("markets");
  let doc = readJSON(file) || emptyDoc(RACE_IDS);
  for (const [key, meta, fetcher] of [
    ["kalshi", markets.KALSHI_META, markets.fetchKalshi],
    ["polymarket", markets.POLYMARKET_META, markets.fetchPolymarket],
  ]) {
    const outcome = await markets.fetchMarketSource(fetcher, RACES);
    if (!outcome.ok) log(`markets: ${key} FAILED — ${outcome.error}`);
    else for (const [id, r] of Object.entries(outcome.races)) log(`markets: ${key} ${id} ${r.market} D ${r.probD}% / R ${r.probR}%`);
    doc = applySourceValidated(doc, key, meta, outcome, now, schema);
  }
  return writeIfChanged(file, doc, schema) ? file : null;
}

const UPDATERS = { results: updateResults, polls: updatePolls, markets: updateMarkets };

async function runOnce(sources, ctx) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const changed = [];
  for (const s of sources) {
    if (!UPDATERS[s]) throw new Error(`Unknown source ${s}`);
    try {
      const f = await UPDATERS[s](now, ctx);
      if (f) changed.push(path.relative(ROOT, f));
    } catch (err) {
      // Validation refusals and unexpected bugs: never write, keep the last good file.
      log(`${s}: not written — ${err.message}`);
    }
  }
  return changed;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowMs = Date.now();

  if (args.window === "week") {
    if (!inWindow(nowMs, ELECTION.weekStart, ELECTION.weekEnd)) { log("Outside election week; nothing to do."); setOutput("changed", "false"); return; }
    if (inWindow(nowMs, ELECTION.nightStart, ELECTION.nightEnd)) { log("Election-night loop owns this window; skipping."); setOutput("changed", "false"); return; }
  } else if (args.window === "night") {
    if (!inWindow(nowMs, Date.parse(ELECTION.nightStart) - 30 * 60000, ELECTION.nightEnd)) { log("Outside election night; nothing to do."); setOutput("changed", "false"); return; }
  }

  const ctx = {};
  try {
    if (!args.loop) {
      const changed = await runOnce(args.sources, ctx);
      log(changed.length ? `Changed: ${changed.join(", ")}` : "No data changes.");
      setOutput("changed", changed.length ? "true" : "false");
      return;
    }

    // Election-night loop: results every pass, markets every ~5 passes, polls every ~40.
    const until = args.until ? Date.parse(args.until) : Date.parse(ELECTION.nightEnd);
    const hardStop = Date.now() + 5.75 * 3600 * 1000; // stay under the 6-hour job limit
    let pass = 0, anyChange = false;
    while (Date.now() < Math.min(until, hardStop)) {
      const sources = args.sources.filter((s) => s === "results" || (s === "markets" && pass % 5 === 0) || (s === "polls" && pass % 40 === 0));
      const changed = await runOnce(sources, ctx);
      if (changed.length) {
        const pushed = commitAndPush(changed, `data: update ${changed.map((f) => path.basename(f, ".json")).join(", ")} [election night]`, args.branch);
        if (pushed) {
          anyChange = true;
          log(`Pushed ${changed.join(", ")}`);
          try { await dispatchPages(args.branch); log("Pages deploy requested"); } catch (err) { log(err.message); }
        }
      }
      pass++;
      const wait = (args.interval + (Math.random() * 30 - 15)) * 1000; // 60–90 s with the default
      await new Promise((r) => setTimeout(r, Math.max(30000, wait)));
    }
    setOutput("changed", anyChange ? "true" : "false");
  } finally {
    await ctx.sosClient?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
