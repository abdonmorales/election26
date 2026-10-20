// Shared document handling for data/results.json, data/polls.json and data/markets.json.
//
// Every file has the same envelope:
//   { schemaVersion, updatedAt, sources: { <key>: SourceStatus }, races: { <raceId>: { <key>: payload } } }
//
// Rules that keep history quiet and the site safe:
//  * A source's `updatedAt` only moves when its payload actually changes.
//  * A failed fetch keeps the previous payload and records `error` + `errorSince` (which does not
//    move on repeated identical failures, so a broken source does not cause a commit every run).
//  * A payload that fails its sanity check or the JSON schema is treated as a failed fetch.
//  * The file is only rewritten when its serialized contents differ.

import fs from "node:fs";
import { validate } from "./schema.js";

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function serialize(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

export function emptyDoc(raceIds) {
  return {
    schemaVersion: 1,
    updatedAt: null,
    sources: {},
    races: Object.fromEntries(raceIds.map((id) => [id, {}])),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply one source's fetch outcome to a document (returns a new document).
 * outcome = { ok: true, races: { raceId: payload } } | { ok: false, error: string }
 * meta = { name, url }
 */
export function applySource(prev, key, meta, outcome, now, { sanity } = {}) {
  const doc = structuredClone(prev);
  const before = prev.sources[key] || {};
  const status = { name: meta.name, url: meta.url, ok: true, updatedAt: before.updatedAt ?? null, error: null, errorSince: null };

  let error = outcome.ok ? null : outcome.error || "Unknown error";
  if (!error && sanity) {
    for (const [raceId, payload] of Object.entries(outcome.races)) {
      const problem = sanity(prev.races[raceId]?.[key], payload, raceId);
      if (problem) { error = `${raceId}: ${problem}`; break; }
    }
  }

  if (error) {
    status.ok = false;
    status.error = String(error).slice(0, 300);
    status.errorSince = before.ok === false && before.errorSince ? before.errorSince : now;
  } else {
    let changed = false;
    for (const [raceId, payload] of Object.entries(outcome.races)) {
      doc.races[raceId] ??= {};
      if (!same(doc.races[raceId][key], payload)) {
        doc.races[raceId][key] = payload;
        changed = true;
      }
    }
    if (changed || !status.updatedAt) status.updatedAt = now;
  }
  doc.sources[key] = status;
  doc.updatedAt = latest(Object.values(doc.sources).map((s) => s.updatedAt)) ?? doc.updatedAt;
  return doc;
}

function latest(times) {
  const valid = times.filter(Boolean).sort();
  return valid.length ? valid[valid.length - 1] : null;
}

/** Apply an outcome, but fall back to a recorded failure if the result breaks the schema. */
export function applySourceValidated(prev, key, meta, outcome, now, schema, opts) {
  let doc = applySource(prev, key, meta, outcome, now, opts);
  const errors = validate(schema, doc);
  if (errors.length) {
    doc = applySource(prev, key, meta, { ok: false, error: `Schema check failed: ${errors.slice(0, 3).join("; ")}` }, now);
  }
  return doc;
}

/** Write only when contents changed and the whole document validates. Returns true if written. */
export function writeIfChanged(file, doc, schema) {
  const errors = validate(schema, doc);
  if (errors.length) throw new Error(`Refusing to write ${file}: ${errors.slice(0, 5).join("; ")}`);
  const text = serialize(doc);
  let old = null;
  try { old = fs.readFileSync(file, "utf8"); } catch { /* new file */ }
  if (old === text) return false;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return true;
}
