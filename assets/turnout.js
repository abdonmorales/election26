// Turnout card: early-vote totals, a pace chart against past elections, and a county map.
// Turnout is not partisan, so it uses its own single-hue (teal) scale, never red/blue.

import { h, relativeTime } from "./common.js";

const TEAL = ["#e3f3f0", "#b8e2da", "#86cbbe", "#55b0a0", "#2f9081", "#1b6f63", "#0e4f46"];
const TURNOUT_BINS = [10, 20, 30, 40, 50, 60]; // % of registered voters
const SERIES = [
  { year: 2026, label: "2026", cls: "s2026" },
  { year: 2024, label: "2024 (presidential)", cls: "s2024" },
  { year: 2022, label: "2022 (midterm)", cls: "s2022" },
];
const EARLY_VOTING = "Oct 19–30";

const fmt = (n) => Number(n || 0).toLocaleString();
const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
const daysBefore = (date, electionDate) => Math.round((Date.parse(`${electionDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);

export function turnoutColor(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "var(--surface-2)";
  let i = TURNOUT_BINS.findIndex((edge) => pct < edge);
  if (i === -1) i = TURNOUT_BINS.length;
  return TEAL[i];
}

let built = null;

function build(root, ctx) {
  const refs = {};
  refs.stats = h("div", { class: "to-stats" });
  refs.chart = h("div", { class: "to-chart" });
  refs.chartTip = h("div", { class: "tooltip", role: "status" });
  refs.mapWrap = h("div", { class: "map-wrap to-map" });
  refs.mapTip = h("div", { class: "tooltip", role: "status" });
  refs.mapNote = h("div", { class: "map-mode" });
  refs.src = h("div", { class: "sig-src" });
  refs.tbody = h("tbody");
  refs.chart.append(refs.chartTip);
  refs.mapWrap.append(refs.mapTip);

  root.replaceChildren(
    h("div", { class: "card-head" }, h("h2", { id: "turnout-h" }, "Turnout"), h("span", { class: "chip" }, `Early voting ${EARLY_VOTING}`)),
    refs.stats,
    h("div", { class: "to-grid" },
      h("figure", { class: "to-fig" },
        h("figcaption", {}, "Early votes as a share of registered voters, by days before Election Day"),
        refs.chart,
        h("div", { class: "legend to-legend" }, SERIES.map((s) => h("span", { class: `to-key ${s.cls}` }, h("i", { "aria-hidden": "true" }), s.label)))),
      h("figure", { class: "to-fig" },
        h("figcaption", {}, "Turnout by county (% of registered voters)"),
        refs.mapWrap,
        h("div", { class: "legend" },
          h("span", { class: "scale", "aria-hidden": "true" }, TEAL.map((c) => h("i", { style: `background:${c}` }))),
          h("span", {}, "0%  →  60%+ (steps of 10)")),
        refs.mapNote)),
    h("details", { class: "table-view" },
      h("summary", {}, "View county turnout as a table"),
      h("div", { class: "tbl-scroll" },
        h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "County"), h("th", { class: "r" }, "Registered"), h("th", { class: "r" }, "Early in person"), h("th", { class: "r" }, "Mail"), h("th", { class: "r" }, "Early total"), h("th", { class: "r" }, "Turnout"))),
          refs.tbody))),
    refs.src,
  );

  // County map (same projection as the race maps).
  const { topo } = ctx;
  const counties = topojson.feature(topo, topo.objects.counties);
  const outline = topojson.mesh(topo, topo.objects.counties, (a, b) => a === b);
  const W = 600, H = 560;
  const path = d3.geoPath(d3.geoConicConformal().parallels([27.5, 35]).rotate([100, 0]).fitSize([W, H], counties));
  const svg = d3.select(refs.mapWrap).insert("svg", ":first-child").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", "Texas county turnout map");
  refs.paths = svg.append("g").selectAll("path").data(counties.features).join("path")
    .attr("class", "county").attr("d", path).attr("tabindex", 0)
    .on("pointerenter pointermove focus", (ev, f) => mapTip(ev, f, refs))
    .on("pointerleave blur", () => refs.mapTip.classList.remove("on"));
  svg.append("path").attr("class", "state-outline").attr("d", path(outline));
  return refs;
}

/** Per-county numbers: election-day totals once the results feed has them, otherwise early votes. */
function countyRows(ctx) {
  const ev = ctx.turnout?.races?.statewide?.earlyvoting;
  const ed = ctx.turnout?.races?.statewide?.sos;
  const rows = {};
  for (const [fips, row] of Object.entries(ctx.baseline.counties)) {
    const e = ev?.available ? ev.counties[fips] : null;
    const d = ed?.available ? ed.counties[fips] : null;
    const registered = d?.[0] || e?.[0] || 0;
    const votes = d ? d[1] : e ? e[3] : null;
    rows[fips] = { name: row[0], registered, early: e, final: d, pct: registered && votes !== null ? (votes / registered) * 100 : null };
  }
  return rows;
}

function mapTip(ev, f, refs) {
  const r = built.rows?.[f.id];
  if (!r) return;
  const lines = [["Registered", fmt(r.registered)]];
  if (r.early) lines.push(["Early in person", fmt(r.early[1])], ["Mail", fmt(r.early[2])], ["Early total", fmt(r.early[3])]);
  if (r.final) lines.push(["Ballots cast", fmt(r.final[1])]);
  lines.push(["Turnout", r.pct === null ? "—" : `${r.pct.toFixed(1)}%`]);
  refs.mapTip.replaceChildren(h("b", {}, `${r.name} County`), ...lines.map(([k, v]) => h("div", { class: "row" }, h("span", {}, k), h("span", { class: "num" }, v))));
  place(refs.mapTip, refs.mapWrap, ev);
}

function place(tip, wrap, ev) {
  const box = wrap.getBoundingClientRect();
  let x, y;
  if (ev.type === "focus") { const r = ev.target.getBoundingClientRect(); x = r.left + r.width / 2 - box.left; y = r.top - box.top; }
  else { x = ev.clientX - box.left; y = ev.clientY - box.top; }
  tip.classList.add("on");
  tip.style.left = `${Math.max(0, Math.min(box.width - tip.offsetWidth, x + 14))}px`;
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 12)}px`;
}

/* ---------------- Stats ---------------- */

function stat(label, value, detail) {
  return h("div", { class: "to-stat" }, h("div", { class: "sig-label" }, label), h("div", { class: "to-value num" }, value), detail ? h("div", { class: "sig-detail num" }, detail) : null);
}

/** Early-vote share at the same number of days before the election in a past year. */
function benchmarkAt(bench, days) {
  const pts = bench.history.filter((p) => p.daysBefore >= days);
  return pts.length ? pts[pts.length - 1] : null;
}

function renderStats(refs, ctx) {
  const ev = ctx.turnout?.races?.statewide?.earlyvoting;
  const ed = ctx.turnout?.races?.statewide?.sos;
  const tiles = [];
  if (ev?.available && ev.total > 0) {
    const days = daysBefore(ev.asOf, ev.electionDate || "2026-11-03");
    tiles.push(stat("Early votes cast", fmt(ev.total), `${ev.turnoutPct}% of ${fmt(ev.registeredVoters)} registered · through ${shortDate(ev.asOf)}`));
    tiles.push(stat("In person / by mail", `${fmt(ev.inPerson)} / ${fmt(ev.mail)}`, ev.history.at(-1)?.inPersonDay ? `${fmt(ev.history.at(-1).inPersonDay)} voted in person on ${shortDate(ev.asOf)}` : null));
    // The 2022 midterm is the closer comparison for 2026, so it comes first.
    const comps = (ctx.benchmarks?.elections || []).slice().sort((a, b) => a.year - b.year).map((b) => {
      const p = benchmarkAt(b, days);
      if (!p || !p.total) return null;
      const diff = ((ev.total - p.total) / p.total) * 100;
      return { year: b.year, change: `${diff >= 0 ? "+" : "−"}${Math.abs(diff).toFixed(0)}% vs ${b.year}`, then: `${b.year}: ${fmt(p.total)} (${p.pct}%)` };
    }).filter(Boolean);
    tiles.push(stat(`Pace, ${days} days out`, comps.map((c) => c.change).join(" · ") || "—",
      comps.length ? `Same point in ${comps.map((c) => c.then).join(" · ")}` : null));
  } else {
    tiles.push(stat("Early votes cast", "—", `Waiting for the Secretary of State to post 2026 early-voting totals (early voting ${EARLY_VOTING}).`));
  }
  if (ed?.available && ed.ballotsCast > 0) {
    const last = ctx.benchmarks?.elections?.find((b) => b.year === 2022)?.final;
    tiles.push(stat("Total ballots counted", fmt(ed.ballotsCast), `${ed.turnoutPct}% of ${fmt(ed.registeredVoters)} registered${last ? ` · 2022 final: ${last.turnoutPct}%` : ""}`));
  } else {
    const finals = (ctx.benchmarks?.elections || []).filter((b) => b.final).map((b) => `${b.year}: ${b.final.turnoutPct}%`).join(" · ");
    tiles.push(stat("Final turnout", "Nov 3", finals ? `Past finals — ${finals}` : null));
  }
  refs.stats.replaceChildren(...tiles);
}

/* ---------------- Pace chart ---------------- */

function seriesData(ctx) {
  const out = [];
  for (const b of ctx.benchmarks?.elections || []) {
    out.push({ ...SERIES.find((s) => s.year === b.year), points: b.history.map((p) => ({ x: p.daysBefore, y: p.pct, total: p.total, date: p.date })) });
  }
  const ev = ctx.turnout?.races?.statewide?.earlyvoting;
  if (ev?.available && ev.history.length) {
    out.unshift({ ...SERIES[0], points: ev.history.map((p) => ({ x: daysBefore(p.date, ev.electionDate || "2026-11-03"), y: p.pct, total: p.total, date: p.date })) });
  }
  return out.filter((s) => s.label);
}

function renderChart(refs, ctx) {
  const series = seriesData(ctx);
  refs.chart.querySelector("svg")?.remove();
  if (!series.length) return;
  // Draw at the container's real width so axis text stays readable on phones.
  const W = Math.max(300, Math.min(700, refs.chart.clientWidth || 600));
  const H = W < 480 ? 220 : 280, m = { t: 12, r: 28, b: 30, l: 40 };
  const START = 17; // in-person early voting starts 15 days out; earlier points are mail ballots only
  const maxY = Math.max(10, Math.ceil(d3.max(series.flatMap((s) => s.points.map((p) => p.y))) / 10) * 10);
  const x = d3.scaleLinear().domain([START, 0]).range([m.l, W - m.r]);
  const y = d3.scaleLinear().domain([0, maxY]).range([H - m.b, m.t]);
  const svg = d3.select(refs.chart).insert("svg", ":first-child").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
    .attr("aria-label", "Line chart of cumulative early-vote turnout by days before Election Day for 2026, 2024 and 2022");
  svg.append("g").attr("class", "to-grid-lines").selectAll("line").data(y.ticks(5)).join("line")
    .attr("x1", m.l).attr("x2", W - m.r).attr("y1", (d) => y(d)).attr("y2", (d) => y(d));
  svg.append("g").attr("class", "to-axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickValues(W < 480 ? [15, 10, 5, 0] : [15, 12, 9, 6, 3, 0]).tickFormat((d) => (d === 0 ? "E-Day" : `${d} days`)).tickSize(0).tickPadding(10));
  svg.append("g").attr("class", "to-axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat((d) => `${d}%`).tickSize(0).tickPadding(6));
  const line = d3.line().x((p) => x(p.x)).y((p) => y(p.y)).curve(d3.curveMonotoneX);
  const visible = (s) => s.points.filter((p) => p.x <= START);
  // Draw history first so 2026 sits on top.
  for (const s of series.slice().reverse()) {
    svg.append("path").attr("class", `to-line ${s.cls}`).attr("d", line(visible(s)));
    const last = visible(s).at(-1);
    if (last && s.year === 2026) svg.append("circle").attr("class", `to-dot ${s.cls}`).attr("cx", x(last.x)).attr("cy", y(last.y)).attr("r", 4);
  }

  // Hover: nearest day, crosshair and a tooltip with every series at that point.
  const cross = svg.append("line").attr("class", "to-cross").attr("y1", m.t).attr("y2", H - m.b).style("opacity", 0);
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const [px] = d3.pointer(ev);
      const day = Math.max(0, Math.min(START, Math.round(x.invert(px))));
      cross.attr("x1", x(day)).attr("x2", x(day)).style("opacity", 1);
      const rows = series.map((s) => {
        const p = s.points.filter((q) => q.x >= day).at(-1);
        return p ? h("div", { class: "row" }, h("span", {}, h("i", { class: `to-swatch ${s.cls}` }), s.label), h("span", { class: "num" }, `${p.y}% · ${fmt(p.total)}`)) : null;
      }).filter(Boolean);
      refs.chartTip.replaceChildren(h("b", {}, day === 0 ? "Election Day" : `${day} days before Election Day`), ...rows);
      place(refs.chartTip, refs.chart, ev);
    })
    .on("pointerleave", () => { cross.style("opacity", 0); refs.chartTip.classList.remove("on"); });
}

/* ---------------- Map + table ---------------- */

function renderMap(refs, ctx) {
  built.rows = countyRows(ctx);
  const anyData = Object.values(built.rows).some((r) => r.pct !== null);
  refs.paths
    .attr("fill", (f) => turnoutColor(built.rows[f.id]?.pct))
    .attr("aria-label", (f) => { const r = built.rows[f.id]; return r ? `${r.name} County: ${r.pct === null ? "no data" : `${r.pct.toFixed(1)}% turnout`}` : null; });
  const ed = ctx.turnout?.races?.statewide?.sos;
  refs.mapNote.textContent = ed?.available && ed.ballotsCast > 0
    ? "Shaded by all ballots counted so far (early + Election Day)"
    : anyData ? "Shaded by early votes (in person + mail) so far" : "No 2026 turnout data yet";

  const rows = Object.entries(built.rows).sort((a, b) => b[1].registered - a[1].registered || a[1].name.localeCompare(b[1].name));
  refs.tbody.replaceChildren(...rows.map(([, r]) => h("tr", {},
    h("td", {}, r.name),
    h("td", { class: "r num" }, r.registered ? fmt(r.registered) : "—"),
    h("td", { class: "r num" }, r.early ? fmt(r.early[1]) : "—"),
    h("td", { class: "r num" }, r.early ? fmt(r.early[2]) : "—"),
    h("td", { class: "r num" }, r.early ? fmt(r.early[3]) : "—"),
    h("td", { class: "r num" }, r.pct === null ? "—" : `${r.pct.toFixed(1)}%`))));
}

function renderSource(refs, ctx) {
  const s = ctx.turnout?.sources || {};
  const lines = [];
  for (const [key, label] of [["earlyvoting", "Early voting: Texas SOS"], ["sos", "Election night: Texas SOS results"]]) {
    const st = s[key];
    if (!st) continue;
    lines.push(h("div", {},
      h("a", { href: st.url, target: "_blank", rel: "noopener noreferrer" }, label),
      st.updatedAt ? ` · updated ${relativeTime(st.updatedAt)}` : "",
      st.ok === false ? h("span", { class: "sig-warn" }, ` ⚠ unavailable since ${relativeTime(st.errorSince)}, showing last good data`) : null));
  }
  lines.push(h("div", {}, "Comparison curves: 2022 and 2024 SOS early-voting reports."));
  refs.src.replaceChildren(...lines);
}

export function renderTurnout(root, ctx) {
  if (!ctx.topo || !ctx.baseline) return;
  if (!built) {
    built = { refs: build(root, ctx) };
    let t;
    window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => renderChart(built.refs, built.ctx), 150); });
  }
  built.ctx = ctx;
  const { refs } = built;
  renderStats(refs, ctx);
  renderChart(refs, ctx);
  renderMap(refs, ctx);
  renderSource(refs, ctx);
}
