// Prediction-market odds from Kalshi and Polymarket (public, read-only, no keys).
//
// Kalshi:     discovery via the search endpoint kalshi.com itself uses
//             (api.elections.kalshi.com/v1/search/series), prices via the documented
//             trade API (api.elections.kalshi.com/trade-api/v2/events/<ticker>).
// Polymarket: discovery via gamma-api.polymarket.com/public-search, prices via
//             gamma-api.polymarket.com/events?slug=<slug>.
//
// For each race we pick the two-way "who wins" market (not combos, margins or turnout), read the
// Democratic and Republican "Yes" prices, and normalize them so they sum to 100%.

import { fetchJSON } from "../lib/http.js";

export const KALSHI_META = { name: "Kalshi", url: "https://kalshi.com" };
export const POLYMARKET_META = { name: "Polymarket", url: "https://polymarket.com" };

const KALSHI_API = "https://api.elections.kalshi.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const EXCLUDE = /combo|margin|turnout|vote percent|primary|exact outcome|odds hit|closer|three-way|which party/i;

const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const round2 = (x) => Math.round(x * 100) / 100;

/** Price of a "Yes" share in dollars: bid/ask midpoint when the book is tight, else last trade. */
export function yesPrice({ bid, ask, last }) {
  bid = num(bid); ask = num(ask); last = num(last);
  if (bid > 0 && ask > 0 && ask >= bid && ask - bid <= 0.1) return { price: round2((bid + ask) / 2), basis: "mid" };
  if (last > 0) return { price: round2(last), basis: "last" };
  if (bid > 0 && ask > 0) return { price: round2((bid + ask) / 2), basis: "mid" };
  return null;
}

export function normalize(markets) {
  const d = markets.D?.price, r = markets.R?.price;
  if (!(d > 0) || !(r > 0)) throw new Error("missing a Democratic or Republican price");
  const probD = Math.round((d / (d + r)) * 100);
  return { probD, probR: 100 - probD };
}

/* ---------------- Kalshi ---------------- */

export function pickKalshiEvent(search, def) {
  const hits = (search?.current_page || []).filter((s) =>
    def.title.test(s.event_title || "") && !EXCLUDE.test(s.event_title || "") && (s.markets || []).length >= 2);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.total_volume || 0) - (a.total_volume || 0));
  const h = hits[0];
  return { eventTicker: h.event_ticker, seriesTicker: h.series_ticker, title: h.event_title };
}

export function kalshiParty(m) {
  const t = String(m.ticker || "");
  if (/-(D|DEM)$/i.test(t)) return "D";
  if (/-(R|REP|GOP)$/i.test(t)) return "R";
  const rules = String(m.rules_primary || "");
  if (/democratic party/i.test(rules)) return "D";
  if (/republican party/i.test(rules)) return "R";
  return null;
}

export function parseKalshiEvent(eventJson, picked) {
  const event = eventJson?.event;
  const list = event?.markets || eventJson?.markets || [];
  const markets = {};
  for (const m of list) {
    if (m.status && !/active|open/i.test(m.status)) continue;
    const party = kalshiParty(m);
    if (!party || markets[party]) continue;
    const p = yesPrice({ bid: m.yes_bid_dollars, ask: m.yes_ask_dollars, last: m.last_price_dollars });
    if (!p) continue;
    markets[party] = { ticker: m.ticker, name: m.yes_sub_title || null, ...p };
  }
  const { probD, probR } = normalize(markets);
  const series = picked.seriesTicker || event?.series_ticker || "";
  return {
    market: picked.eventTicker,
    title: event?.title || picked.title,
    url: `https://kalshi.com/markets/${series.toLowerCase()}`,
    probD, probR, markets,
  };
}

export async function fetchKalshi(def) {
  const search = await fetchJSON(`${KALSHI_API}/v1/search/series?query=${encodeURIComponent(def.kalshi.query)}&page_size=25`);
  const picked = pickKalshiEvent(search, def.kalshi);
  if (!picked) throw new Error(`no Kalshi market matched "${def.kalshi.query}"`);
  const ev = await fetchJSON(`${KALSHI_API}/trade-api/v2/events/${encodeURIComponent(picked.eventTicker)}?with_nested_markets=true`);
  return parseKalshiEvent(ev, picked);
}

/* ---------------- Polymarket ---------------- */

export function pickPolymarketEvent(search, def) {
  const hits = (search?.events || []).filter((e) =>
    def.title.test(e.title || "") && !EXCLUDE.test(e.title || "") && e.closed !== true && e.active !== false);
  if (!hits.length) return null;
  hits.sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0));
  return { slug: hits[0].slug, id: String(hits[0].id), title: hits[0].title };
}

export function polymarketParty(m) {
  const label = `${m.groupItemTitle || ""} ${m.question || ""}`;
  if (/\(D\)|\bdemocrat/i.test(label)) return "D";
  if (/\(R\)|\brepublican/i.test(label)) return "R";
  return null;
}

function parseList(v) {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v || "[]"); } catch { return []; }
}

export function parsePolymarketEvent(events, picked) {
  const event = Array.isArray(events) ? events[0] : events;
  if (!event) throw new Error("Polymarket event not found");
  const markets = {};
  for (const m of event.markets || []) {
    if (m.closed === true || m.active === false) continue;
    const party = polymarketParty(m);
    if (!party || markets[party]) continue;
    const outcomes = parseList(m.outcomes);
    const prices = parseList(m.outcomePrices);
    const yesIdx = Math.max(0, outcomes.findIndex((o) => /^yes$/i.test(o)));
    const p = yesPrice({ bid: m.bestBid, ask: m.bestAsk, last: prices[yesIdx] ?? m.lastTradePrice });
    if (!p) continue;
    markets[party] = { id: String(m.id), name: (m.groupItemTitle || "").trim() || null, ...p };
  }
  const { probD, probR } = normalize(markets);
  return {
    market: picked.slug,
    title: event.title || picked.title,
    url: `https://polymarket.com/event/${picked.slug}`,
    probD, probR, markets,
  };
}

export async function fetchPolymarket(def) {
  const search = await fetchJSON(`${GAMMA_API}/public-search?q=${encodeURIComponent(def.polymarket.query)}&limit_per_type=25`);
  const picked = pickPolymarketEvent(search, def.polymarket);
  if (!picked) throw new Error(`no Polymarket event matched "${def.polymarket.query}"`);
  const events = await fetchJSON(`${GAMMA_API}/events?slug=${encodeURIComponent(picked.slug)}`);
  return parsePolymarketEvent(events, picked);
}

/** Run one market source across all races. Any race failing fails the source (keeps last good data). */
export async function fetchMarketSource(fetcher, races) {
  const out = {};
  try {
    for (const [id, def] of Object.entries(races)) out[id] = await fetcher(def);
    return { ok: true, races: out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
