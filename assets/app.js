import {
  STATUS_LABELS, BINS, RAMP, h,
  signedMargin, formatMargin, formatPlus, rating, bannerMessages, colorFor,
  countyBaselineMargin, statewideBaselineMargin, projectedCountyMargin, resultMargin, relativeTime,
  mergedCounties,
} from "./common.js";

const POLL_MS = 20000;
const ELECTION_DAY = Date.parse("2026-11-03T07:00:00-06:00"); // polls open, Central Time

const state = {
  data: null, results: null, polls: null, markets: null,
  baseline: null, topo: null, cards: new Map(), failures: 0, raceKey: "",
};
// Automated data files. A failed fetch keeps whatever we had; the page never blanks out.
const FEEDS = { results: "data/results.json", polls: "data/polls.json", markets: "data/markets.json" };

/* ---------------- Data loading ---------------- */

async function fetchJSON(url, bust = false) {
  const res = await fetch(bust ? `${url}?t=${Date.now()}` : url, { cache: bust ? "no-store" : "default" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function poll() {
  try {
    const [data, ...feeds] = await Promise.all([
      fetchJSON("data/projections.json", true),
      ...Object.values(FEEDS).map((url) => fetchJSON(url, true).catch((err) => { console.warn(err); return null; })),
    ]);
    state.failures = 0;
    document.getElementById("live-pill").classList.remove("stale");
    let changed = !state.data || JSON.stringify(data) !== JSON.stringify(state.data);
    state.data = data;
    Object.keys(FEEDS).forEach((key, i) => {
      if (feeds[i] && JSON.stringify(feeds[i]) !== JSON.stringify(state[key])) { state[key] = feeds[i]; changed = true; }
    });
    if (changed) render();
  } catch (err) {
    console.warn(err);
    if (++state.failures >= 3) document.getElementById("live-pill").classList.add("stale");
  }
  updateClock();
}

/* ---------------- Top bar ---------------- */

let tickerTimer = null;
let tickerIndex = 0;

function renderTicker() {
  const el = document.getElementById("ticker");
  const msgs = bannerMessages(state.data);
  if (!msgs.length) msgs.push("Projections coming soon — stay tuned.");
  el.replaceChildren(...msgs.map((m, i) =>
    h("div", { class: "ticker-item" + (i === 0 ? " on" : "") }, h("span", { class: "tag" }, "MY PROJECTION"), m)));
  tickerIndex = 0;
  clearInterval(tickerTimer);
  if (msgs.length > 1) {
    tickerTimer = setInterval(() => {
      const items = el.children;
      items[tickerIndex].classList.remove("on");
      tickerIndex = (tickerIndex + 1) % items.length;
      items[tickerIndex].classList.add("on");
    }, 6000);
  }
}

function updateClock() {
  const up = document.getElementById("updated");
  if (state.data?.updatedAt) up.textContent = `Updated ${relativeTime(state.data.updatedAt)}`;
  const cd = document.getElementById("countdown");
  const diff = ELECTION_DAY - Date.now();
  if (diff > 0) {
    const days = Math.floor(diff / 86400000);
    const hrs = Math.floor((diff % 86400000) / 3600000);
    cd.textContent = days > 0 ? `${days} day${days === 1 ? "" : "s"}, ${hrs} hr to go` : `${hrs} hr to go`;
  } else if (diff > -86400000) {
    cd.textContent = "Election Day is here";
  } else {
    cd.textContent = "Results";
  }
}

/* ---------------- Race cards ---------------- */

function raceSummary(race) {
  const { counties } = mergedCounties(race, state.results);
  let r = 0, d = 0;
  for (const v of Object.values(counties)) { r += v[0] || 0; d += v[1] || 0; }
  return { hasResults: Object.keys(counties).length > 0 && r + d > 0, r, d };
}

function buildCard(race) {
  const card = h("article", { class: "card", id: `race-${race.id}`, "aria-labelledby": `race-${race.id}-h` });
  const refs = {};
  refs.chip = h("span", { class: "chip" });
  refs.dName = h("div", { class: "name" });
  refs.rName = h("div", { class: "name" });
  refs.dCand = h("div", { class: "cand" }, refs.dName, h("div", { class: "party" }, h("span", { class: "swatch", style: "background:var(--dem)" }), "Democrat"));
  refs.rCand = h("div", { class: "cand right" }, refs.rName, h("div", { class: "party" }, h("span", { class: "swatch", style: "background:var(--rep)" }), "Republican"));
  refs.margin = h("div", { class: "big-margin num" });
  refs.segD = h("div", { class: "seg D" });
  refs.segR = h("div", { class: "seg R" });
  refs.meterD = h("span", { class: "num" });
  refs.meterR = h("span", { class: "num" });
  refs.note = h("p", { class: "note" });
  refs.results = h("p", { class: "results-line num" });
  refs.mapWrap = h("div", { class: "map-wrap" });
  refs.tooltip = h("div", { class: "tooltip", role: "status" });
  refs.mode = h("div", { class: "map-mode" });
  refs.tbody = h("tbody");

  card.append(
    h("div", { class: "card-head" }, h("h2", { id: `race-${race.id}-h` }, race.title), refs.chip),
    h("div", { class: "matchup" }, refs.dCand, refs.margin, refs.rCand),
    h("div", { class: "meter", role: "img", "aria-label": "Projected two-party vote share" },
      refs.segD, refs.segR, h("div", { class: "meter-mid" })),
    h("div", { class: "meter-labels" }, refs.meterD, h("span", {}, "50%"), refs.meterR),
    refs.results,
    refs.signals = h("section", { class: "signals", "aria-label": "Other signals, separate from my projection" }),
    refs.note,
    refs.mapWrap,
    refs.mode,
    legend(),
    h("details", { class: "table-view" },
      h("summary", {}, "View counties as a table"),
      h("div", { class: "tbl-scroll" },
        h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "County"), h("th", { class: "r" }, "2024 pres."), h("th", { class: "r" }, "Projected"), h("th", { class: "r" }, "Result"))),
          refs.tbody))),
  );
  refs.mapWrap.append(refs.tooltip);
  buildMap(race, refs);
  return { card, refs };
}

function legend() {
  const colors = [...RAMP.D].reverse().concat(RAMP.R);
  return h("div", { class: "legend" },
    h("span", {}, "D"),
    h("span", { class: "scale", "aria-hidden": "true", title: `Margin bins: <${BINS.join(", <")}, ${BINS.at(-1)}+ points` },
      colors.map((c) => h("i", { style: `background:${c}` }))),
    h("span", {}, "R"),
    h("span", { class: "bins" }, "Margin in points: 0–1, 1–5, 5–10, 10–20, 20–40, 40+"),
  );
}

function buildMap(race, refs) {
  const { topo } = state;
  const counties = topojson.feature(topo, topo.objects.counties);
  const outline = topojson.mesh(topo, topo.objects.counties, (a, b) => a === b);
  const W = 600, H = 560;
  const projection = d3.geoConicConformal().parallels([27.5, 35]).rotate([100, 0]).fitSize([W, H], counties);
  const path = d3.geoPath(projection);

  const svg = d3.select(refs.mapWrap).insert("svg", ":first-child")
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr("role", "img")
    .attr("aria-label", `Texas county map for the ${race.title} race`);
  refs.paths = svg.append("g").selectAll("path")
    .data(counties.features)
    .join("path")
    .attr("class", "county")
    .attr("d", path)
    .attr("tabindex", 0)
    .on("pointerenter pointermove", (ev, f) => showTip(ev, f, race.id, refs))
    .on("pointerleave blur", () => refs.tooltip.classList.remove("on"))
    .on("focus", (ev, f) => showTip(ev, f, race.id, refs, true));
  svg.append("path").attr("class", "state-outline").attr("d", path(outline));
}

function countyInfo(raceId, fips) {
  const race = state.data.races.find((r) => r.id === raceId);
  const row = state.baseline.counties[fips];
  if (!race || !row) return null;
  const sm = signedMargin(race.projection);
  const swing = sm === null ? 0 : sm - statewideBaselineMargin(state.baseline);
  const res = mergedCounties(race, state.results).counties[fips];
  const resM = res ? resultMargin(res) : null;
  return {
    race, row, name: row[0],
    base: countyBaselineMargin(row),
    proj: sm === null ? null : projectedCountyMargin(row, swing),
    res, resM,
    anyResults: raceSummary(race).hasResults,
    swing,
  };
}

function showTip(ev, f, raceId, refs, fromFocus = false) {
  const info = countyInfo(raceId, f.id);
  if (!info) return;
  const tip = refs.tooltip;
  const rows = [
    ["2024 president", formatMargin(info.base)],
    ["Projected", formatMargin(info.proj)],
  ];
  if (info.res) {
    rows.push(["Result", formatMargin(info.resM)]);
    rows.push([info.race.candidates.D, (info.res[1] || 0).toLocaleString()]);
    rows.push([info.race.candidates.R, (info.res[0] || 0).toLocaleString()]);
    rows.push(["Reporting", `${info.res[2] ?? 0}%`]);
  }
  tip.replaceChildren(h("b", {}, `${info.name} County`), ...rows.map(([k, v]) => h("div", { class: "row" }, h("span", {}, k), h("span", { class: "num" }, v))));
  const box = refs.mapWrap.getBoundingClientRect();
  let x, y;
  if (fromFocus) {
    const r = ev.target.getBoundingClientRect();
    x = r.left + r.width / 2 - box.left; y = r.top - box.top;
  } else {
    x = ev.clientX - box.left; y = ev.clientY - box.top;
  }
  tip.classList.add("on");
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = `${Math.max(0, Math.min(box.width - tw, x + 14))}px`;
  tip.style.top = `${Math.max(0, y - th - 12)}px`;
}

function updateCard(race, { refs }) {
  const p = race.projection || {};
  const sm = signedMargin(p);
  const summary = raceSummary(race);
  const c = race.candidates;

  refs.dName.textContent = c.D;
  refs.rName.textContent = c.R;
  refs.dCand.classList.toggle("winner", p.status === "called" && p.winner === "D");
  refs.rCand.classList.toggle("winner", p.status === "called" && p.winner === "R");

  let chipText = rating(sm), chipClass = sm === null || sm === 0 ? "" : sm > 0 ? "R" : "D";
  if (p.status === "called") { chipText = `Called · ${c[p.winner]}`; chipClass = "called"; }
  if (p.status === "pending") chipText = STATUS_LABELS.pending;
  refs.chip.textContent = chipText;
  refs.chip.className = `chip ${chipClass}`;

  if (sm === null) {
    refs.margin.replaceChildren("—", h("small", {}, "Projection"));
  } else if (sm === 0) {
    refs.margin.replaceChildren("Even", h("small", {}, "Toss-up"));
  } else {
    refs.margin.replaceChildren(formatPlus(p.margin, p.winner), h("small", {}, p.status === "called" ? "Final call" : "My projection"));
  }

  // Meter: actual two-party share once votes are in, otherwise implied by the projection.
  let dShare, rShare, label;
  if (summary.hasResults) {
    dShare = (summary.d / (summary.r + summary.d)) * 100;
    rShare = 100 - dShare;
    label = "counted";
  } else {
    const m = sm ?? 0;
    rShare = 50 + m / 2; dShare = 100 - rShare;
    label = sm === null ? "" : "projected";
  }
  refs.segD.style.width = `${dShare}%`;
  refs.segR.style.width = `${rShare}%`;
  refs.meterD.textContent = label ? `${c.D.split(" ").at(-1)} ${dShare.toFixed(1)}% ${label}` : "";
  refs.meterR.textContent = label ? `${c.R.split(" ").at(-1)} ${rShare.toFixed(1)}%` : "";

  if (summary.hasResults) {
    const pr = Number(race.results?.pctReporting) || state.results?.races?.[race.id]?.sos?.pctReporting || 0;
    refs.results.textContent = `Votes counted: ${c.D} ${summary.d.toLocaleString()} · ${c.R} ${summary.r.toLocaleString()}` + (pr ? ` · ${pr}% of precincts reporting` : "");
    refs.results.hidden = false;
  } else {
    refs.results.hidden = true;
  }
  renderSignals(race, refs.signals);
  refs.note.textContent = race.note || "";
  refs.note.hidden = !race.note;

  // Map fills
  refs.paths
    .attr("fill", (f) => {
      const i = countyInfo(race.id, f.id);
      if (!i) return RAMP.even;
      if (i.res && (i.res[0] + i.res[1]) > 0) return colorFor(i.resM);
      return colorFor(i.proj ?? i.base);
    })
    .classed("pending-result", (f) => {
      const i = countyInfo(race.id, f.id);
      return !!i && i.anyResults && !(i.res && (i.res[0] + i.res[1]) > 0);
    })
    .attr("aria-label", (f) => {
      const i = countyInfo(race.id, f.id);
      return i ? `${i.name} County: projected ${formatMargin(i.proj ?? i.base)}` : null;
    });

  if (summary.hasResults) refs.mode.textContent = "Shaded by reported votes · faded counties have no returns yet and show my projection";
  else if (sm === null) refs.mode.textContent = "No projection yet · shaded by the 2024 presidential result";
  else refs.mode.textContent = `Shaded by my projection: ${formatMargin(sm)} statewide (a ${formatMargin(sm - statewideBaselineMargin(state.baseline))} shift from 2024)`;

  // Table view, largest counties first.
  const rows = Object.entries(state.baseline.counties).sort((a, b) => b[1][3] - a[1][3]);
  refs.tbody.replaceChildren(...rows.map(([fips]) => {
    const i = countyInfo(race.id, fips);
    return h("tr", {},
      h("td", {}, i.name),
      h("td", { class: "r num" }, formatMargin(i.base)),
      h("td", { class: "r num" }, formatMargin(i.proj)),
      h("td", { class: "r num" }, i.res ? `${formatMargin(i.resM)} (${i.res[2] ?? 0}%)` : "—"));
  }));
}

/* ---------------- Signals: polls, markets, official returns ---------------- */

function sourceLine(status, label, href) {
  const bits = [];
  bits.push(href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label) : label);
  if (status?.updatedAt) bits.push(` · updated ${relativeTime(status.updatedAt)}`);
  const line = h("div", { class: "sig-src" }, bits);
  if (status && status.ok === false) {
    line.append(h("div", { class: "sig-warn" }, `⚠ Source unavailable since ${relativeTime(status.errorSince)} — showing last good data`));
  }
  return line;
}

const lastName = (n) => String(n || "").trim().split(/\s+/).pop();

function pollSignal(race) {
  const p = state.polls?.races?.[race.id]?.wikipedia;
  const status = state.polls?.sources?.wikipedia;
  const avg = p?.average;
  const body = avg
    ? [h("div", { class: "sig-value num" }, formatMargin(avg.margin)),
       h("div", { class: "sig-detail num" }, `${lastName(race.candidates.D)} ${avg.D.toFixed(1)} · ${lastName(race.candidates.R)} ${avg.R.toFixed(1)} · ${avg.pollCount} pollster${avg.pollCount === 1 ? "" : "s"}, latest ${avg.latestPoll}`)]
    : [h("div", { class: "sig-value muted" }, "—"), h("div", { class: "sig-detail" }, "No trusted polls yet")];
  return h("div", { class: "signal" }, h("div", { class: "sig-label" }, "Polling average"), ...body,
    sourceLine(status, "Trusted polls via Wikipedia", p?.page));
}

function marketSignal(race) {
  const slot = state.markets?.races?.[race.id] || {};
  const rows = [];
  for (const [key, label] of [["kalshi", "Kalshi"], ["polymarket", "Polymarket"]]) {
    const m = slot[key];
    const status = state.markets?.sources?.[key];
    if (!m) { rows.push(h("div", { class: "sig-row" }, h("span", {}, label), h("span", { class: "muted" }, "—"))); continue; }
    const fav = m.probD >= m.probR ? "D" : "R";
    rows.push(h("div", { class: "sig-row" },
      h("span", {}, label),
      h("span", { class: "num" }, `${lastName(race.candidates[fav])} ${fav === "D" ? m.probD : m.probR}%`)));
    rows.push(sourceLine(status, m.market, m.url));
  }
  return h("div", { class: "signal" }, h("div", { class: "sig-label" }, "Market odds to win"), ...rows);
}

function returnsSignal(race) {
  const r = state.results?.races?.[race.id]?.sos;
  const status = state.results?.sources?.sos;
  const { manualCount } = mergedCounties(race, state.results);
  let body;
  if (r?.available && r.totalVotes > 0) {
    body = [
      h("div", { class: "sig-value num" }, `${r.pctReporting}% in`),
      h("div", { class: "sig-detail num" }, `${lastName(race.candidates.D)} ${r.candidates.D.pct}% · ${lastName(race.candidates.R)} ${r.candidates.R.pct}% · ${r.totalVotes.toLocaleString()} votes`),
    ];
  } else {
    body = [h("div", { class: "sig-value muted" }, "Not reporting"), h("div", { class: "sig-detail" }, "Returns start after polls close at 7 PM CT on Nov 3")];
  }
  if (manualCount) body.push(h("div", { class: "sig-detail" }, `${manualCount} count${manualCount === 1 ? "y" : "ies"} entered manually`));
  return h("div", { class: "signal" }, h("div", { class: "sig-label" }, "Official returns"), ...body,
    sourceLine(status, "Texas Secretary of State", status?.url));
}

function renderSignals(race, el) {
  el.replaceChildren(
    h("div", { class: "sig-head" }, "Other signals — not part of my projection"),
    h("div", { class: "sig-grid" }, pollSignal(race), marketSignal(race), returnsSignal(race)));
}

function renderFeed() {
  const ol = document.getElementById("feed");
  const feed = (state.data.feed || []).slice(0, 40);
  if (!feed.length) {
    ol.replaceChildren(h("li", { class: "empty" }, h("span", {}), "No projections posted yet."));
    return;
  }
  ol.replaceChildren(...feed.map((e) => h("li", {},
    h("time", { datetime: e.t, title: new Date(e.t).toLocaleString() }, relativeTime(e.t)),
    h("span", {}, e.text))));
}

function render() {
  renderTicker();
  const races = state.data.races || [];
  const key = races.map((r) => r.id).join("|");
  const container = document.getElementById("races");
  if (key !== state.raceKey) {
    state.cards.clear();
    container.replaceChildren(...races.map((race) => {
      const built = buildCard(race);
      state.cards.set(race.id, built);
      return built.card;
    }));
    state.raceKey = key;
  }
  for (const race of races) updateCard(race, state.cards.get(race.id));
  renderFeed();
  updateClock();
}

async function init() {
  try {
    [state.baseline, state.topo] = await Promise.all([
      fetchJSON("data/baseline-2024.json"),
      fetchJSON("data/tx-counties.topo.json"),
    ]);
  } catch (err) {
    document.getElementById("races").replaceChildren(h("p", {}, "Could not load map data. Please refresh."));
    throw err;
  }
  await poll();
  let timer = setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    clearInterval(timer);
    if (!document.hidden) { poll(); timer = setInterval(poll, POLL_MS); }
  });
  setInterval(updateClock, 30000);
}

init();
