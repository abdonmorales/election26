import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyDoc, applySource, applySourceValidated, writeIfChanged } from "../pipeline/lib/store.js";
import { validate } from "../pipeline/lib/schema.js";
import { loadSchema } from "../pipeline/schemas.js";
import { dataJSON } from "./helpers.js";

const meta = { name: "Kalshi", url: "https://kalshi.com" };
const odds = (probD) => ({
  market: "SENATETX-26", title: "Texas Senate winner?", url: "https://kalshi.com/markets/senatetx", probD, probR: 100 - probD,
  markets: { D: { ticker: "SENATETX-26-D", name: "D", price: probD / 100, basis: "mid" }, R: { ticker: "SENATETX-26-R", name: "R", price: (100 - probD) / 100, basis: "mid" } },
});
const T1 = "2026-10-20T10:00:00Z", T2 = "2026-10-20T13:00:00Z", T3 = "2026-10-20T16:00:00Z";

test("updatedAt moves only when the payload changes", () => {
  let doc = applySource(emptyDoc(["senate"]), "kalshi", meta, { ok: true, races: { senate: odds(61) } }, T1);
  assert.equal(doc.sources.kalshi.updatedAt, T1);
  doc = applySource(doc, "kalshi", meta, { ok: true, races: { senate: odds(61) } }, T2);
  assert.equal(doc.sources.kalshi.updatedAt, T1);
  doc = applySource(doc, "kalshi", meta, { ok: true, races: { senate: odds(63) } }, T3);
  assert.equal(doc.sources.kalshi.updatedAt, T3);
  assert.equal(doc.updatedAt, T3);
});

test("a failure keeps the last good data and a stable errorSince", () => {
  let doc = applySource(emptyDoc(["senate"]), "kalshi", meta, { ok: true, races: { senate: odds(61) } }, T1);
  doc = applySource(doc, "kalshi", meta, { ok: false, error: "HTTP 503" }, T2);
  assert.equal(doc.races.senate.kalshi.probD, 61);
  assert.deepEqual([doc.sources.kalshi.ok, doc.sources.kalshi.error, doc.sources.kalshi.errorSince, doc.sources.kalshi.updatedAt], [false, "HTTP 503", T2, T1]);
  const again = applySource(doc, "kalshi", meta, { ok: false, error: "HTTP 503" }, T3);
  assert.deepEqual(again, doc, "a repeated identical failure must not change the file");
  const recovered = applySource(again, "kalshi", meta, { ok: true, races: { senate: odds(61) } }, T3);
  assert.equal(recovered.sources.kalshi.ok, true);
  assert.equal(recovered.sources.kalshi.errorSince, null);
});

test("sanity failures are recorded as errors", () => {
  let doc = applySource(emptyDoc(["senate"]), "kalshi", meta, { ok: true, races: { senate: odds(61) } }, T1);
  doc = applySource(doc, "kalshi", meta, { ok: true, races: { senate: odds(99) } }, T2, { sanity: () => "too jumpy" });
  assert.equal(doc.races.senate.kalshi.probD, 61);
  assert.equal(doc.sources.kalshi.error, "senate: too jumpy");
});

test("schema-breaking payloads are rejected and the old data kept", () => {
  const schema = loadSchema("markets");
  let doc = applySourceValidated({ ...emptyDoc(["senate", "governor"]) }, "kalshi", meta, { ok: true, races: { senate: odds(61) } }, T1, schema);
  assert.equal(doc.sources.kalshi.ok, true);
  const broken = odds(61); broken.probD = 140;
  doc = applySourceValidated(doc, "kalshi", meta, { ok: true, races: { senate: broken } }, T2, schema);
  assert.equal(doc.races.senate.kalshi.probD, 61);
  assert.match(doc.sources.kalshi.error, /Schema check failed/);
});

test("writeIfChanged writes once and refuses invalid documents", () => {
  const schema = loadSchema("markets");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e26-")), "markets.json");
  const doc = applySource(emptyDoc(["senate", "governor"]), "kalshi", meta, { ok: true, races: { senate: odds(61) } }, T1);
  assert.equal(writeIfChanged(file, doc, schema), true);
  assert.equal(writeIfChanged(file, doc, schema), false);
  assert.throws(() => writeIfChanged(file, { ...doc, schemaVersion: 2 }, schema), /Refusing/);
});

test("committed data files match their schemas", () => {
  for (const name of ["results", "turnout", "polls", "markets", "turnout-benchmarks"]) {
    assert.deepEqual(validate(loadSchema(name), dataJSON(`${name}.json`)), [], name);
  }
});

test("validator catches common mistakes", () => {
  const schema = { type: "object", required: ["a"], additionalProperties: false, properties: { a: { type: "integer", minimum: 0 } } };
  assert.deepEqual(validate(schema, { a: 1 }), []);
  assert.equal(validate(schema, { a: -1 }).length, 1);
  assert.equal(validate(schema, { a: 1.5 }).length, 1);
  assert.equal(validate(schema, { b: 1 }).length, 2);
});
