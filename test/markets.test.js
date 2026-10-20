import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../pipeline/sources/markets.js";
import { RACES } from "../pipeline/config.js";
import { fixtureJSON } from "./helpers.js";

test("yesPrice prefers a tight bid/ask midpoint, else last trade", () => {
  assert.deepEqual(m.yesPrice({ bid: "0.60", ask: "0.62", last: "0.5" }), { price: 0.61, basis: "mid" });
  assert.deepEqual(m.yesPrice({ bid: 0.1, ask: 0.9, last: 0.4 }), { price: 0.4, basis: "last" });
  assert.equal(m.yesPrice({ bid: 0, ask: 1, last: 0 }), null);
});

test("normalize requires both sides and sums to 100", () => {
  assert.deepEqual(m.normalize({ D: { price: 0.6 }, R: { price: 0.4 } }), { probD: 60, probR: 40 });
  assert.throws(() => m.normalize({ D: { price: 0.6 } }), /missing/);
});

for (const race of ["senate", "governor"]) {
  test(`Kalshi: picks the ${race} winner market, not combos or margins`, () => {
    const picked = m.pickKalshiEvent(fixtureJSON(`kalshi/search-${race}.json`), RACES[race].kalshi);
    assert.equal(picked.eventTicker, race === "senate" ? "SENATETX-26" : "GOVPARTYTX-26");
    const odds = m.parseKalshiEvent(fixtureJSON(`kalshi/event-${race}.json`), picked);
    assert.equal(odds.probD + odds.probR, 100);
    assert.ok(race === "senate" ? odds.probD > 55 : odds.probD < 35);
    assert.equal(odds.markets.D.ticker.endsWith("-D"), true);
    assert.equal(odds.markets.D.basis, "mid");
    assert.match(odds.url, /^https:\/\/kalshi\.com\/markets\//);
  });

  test(`Polymarket: picks the ${race} winner event and skips placeholder markets`, () => {
    const picked = m.pickPolymarketEvent(fixtureJSON(`polymarket/search-${race}.json`), RACES[race].polymarket);
    assert.equal(picked.slug, race === "senate" ? "texas-senate-election-winner" : "texas-governor-winner-2026");
    const odds = m.parsePolymarketEvent(fixtureJSON(`polymarket/event-${race}.json`), picked);
    assert.equal(odds.probD + odds.probR, 100);
    assert.ok(race === "senate" ? odds.probD > 55 : odds.probD < 35);
    assert.equal(Object.keys(odds.markets).sort().join(), "D,R");
  });
}

test("party detection", () => {
  assert.equal(m.kalshiParty({ ticker: "X-26-GOP" }), "R");
  assert.equal(m.kalshiParty({ ticker: "X-26-Q", rules_primary: "If a representative of the Democratic party is sworn in" }), "D");
  assert.equal(m.polymarketParty({ groupItemTitle: "Person A", question: "Will Person A win?" }), null);
  assert.equal(m.polymarketParty({ groupItemTitle: "Greg Abbott (R)" }), "R");
});

test("pickers return null when nothing matches", () => {
  assert.equal(m.pickKalshiEvent({ current_page: [] }, RACES.senate.kalshi), null);
  assert.equal(m.pickPolymarketEvent({ events: [{ title: "Texas Senate Election Winner", closed: true }] }, RACES.senate.polymarket), null);
});
