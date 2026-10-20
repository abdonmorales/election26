import { test } from "node:test";
import assert from "node:assert/strict";
import { findTables, parseTable, textOf, sectionById } from "../pipeline/lib/html-table.js";

test("textOf drops footnotes, comments and decodes entities", () => {
  assert.equal(textOf(`Emerson<sup class="reference">[1]</sup> &amp; Co<!-- note -->&#160;(R)`), "Emerson & Co (R)");
});

test("parseTable expands rowspan/colspan and ignores quoted '>' in attributes", () => {
  const html = `<table><tr><th>Poll</th><th colspan="2">Cands</th></tr>
    <tr><td rowspan="2" data-x='a>b'>Marist</td><td>47%</td><td>45%</td></tr>
    <tr><td>48%</td><td>44%</td></tr>
    <tr><td>Other<table><tr><td>nested</td></tr></table></td><td>1</td><td>2</td></tr></table>`;
  const grid = parseTable(html);
  assert.deepEqual(grid.map((r) => r.map((c) => c.text)), [
    ["Poll", "Cands", "Cands"],
    ["Marist", "47%", "45%"],
    ["Marist", "48%", "44%"],
    ["Other nested", "1", "2"],
  ]);
});

test("findTables returns top-level tables only", () => {
  assert.equal(findTables("<table><tr><td><table></table></td></tr></table><p></p><table></table>").length, 2);
});

test("sectionById stops at the next heading of the same level", () => {
  const html = `<h2 id="A">A</h2>one<h3 id="B">B</h3>two<h2 id="C">C</h2>three`;
  assert.equal(textOf(sectionById(html, "A")), "A one B two");
});
