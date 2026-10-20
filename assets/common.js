// Shared helpers used by both the public site and the admin dashboard.

export const PARTY = {
  R: { short: "R", name: "Republican" },
  D: { short: "D", name: "Democrat" },
};

export const STATUS_LABELS = {
  pending: "No projection yet",
  tossup: "Toss-up",
  projection: "Projection",
  called: "Race called",
};

// Signed margin convention used everywhere: positive = Republican lead, negative = Democratic lead.
export function signedMargin(projection) {
  if (!projection || projection.status === "pending") return null;
  if (projection.status === "tossup") return 0;
  const m = Math.abs(Number(projection.margin) || 0);
  return projection.winner === "D" ? -m : m;
}

export function formatMargin(signed, digits = 1) {
  if (signed === null || signed === undefined || Number.isNaN(signed)) return "—";
  if (Math.abs(signed) < 0.05) return "Even";
  const party = signed > 0 ? "R" : "D";
  return `${party}+${Math.abs(signed).toFixed(digits)}`;
}

// "+5 R" style, matching how projections are announced in the banner.
export function formatPlus(margin, party) {
  const m = Number(margin) || 0;
  return `+${Number.isInteger(m) ? m : m.toFixed(1)} ${party}`;
}

export function rating(signed) {
  if (signed === null) return "Pending";
  const a = Math.abs(signed);
  if (a < 0.05) return "Toss-up";
  const side = signed > 0 ? "R" : "D";
  if (a < 1) return `Tilt ${side}`;
  if (a < 5) return `Lean ${side}`;
  if (a < 10) return `Likely ${side}`;
  return `Safe ${side}`;
}

// The sentence that appears in the top bar for a race.
export function projectionSentence(race) {
  const p = race.projection || {};
  const c = race.candidates || {};
  switch (p.status) {
    case "projection":
      if (!p.winner) return null;
      return `I project ${c[p.winner]} to win by ${formatPlus(p.margin, p.winner)}`;
    case "called":
      if (!p.winner) return null;
      return `${race.title}: ${c[p.winner]} WINS — final projection ${formatPlus(p.margin, p.winner)}`;
    case "tossup":
      return `${race.title}: ${c.R} vs. ${c.D} — I rate this race a pure toss-up`;
    default:
      return null;
  }
}

export function bannerMessages(data) {
  const msgs = [];
  const custom = data?.banner?.custom?.trim();
  if (custom) msgs.push(custom);
  if (data?.banner?.showAuto !== false) {
    for (const race of data?.races || []) {
      const s = projectionSentence(race);
      if (s) msgs.push(s);
    }
  }
  return msgs;
}

// Diverging ramp, lightest (near even) to darkest (landslide). Bin edges in margin points.
export const BINS = [1, 5, 10, 20, 40];
export const RAMP = {
  R: ["#f4d6d1", "#eba79c", "#e07766", "#cc4a3a", "#a32e1f", "#6e1a10"],
  D: ["#d6e2f5", "#a3bfea", "#6f9ade", "#3f74c8", "#1f52a3", "#0e336f"],
  even: "#a8a8a3",
};

export function colorFor(signed) {
  if (signed === null || signed === undefined || Number.isNaN(signed)) return RAMP.even;
  const a = Math.abs(signed);
  if (a < 0.05) return RAMP.even;
  let i = BINS.findIndex((edge) => a < edge);
  if (i === -1) i = BINS.length;
  return (signed > 0 ? RAMP.R : RAMP.D)[i];
}

// County-level projection by uniform swing from the 2024 presidential baseline.
export function countyBaselineMargin(row) {
  const [, gop, dem, total] = row;
  return total ? ((gop - dem) / total) * 100 : 0;
}

export function statewideBaselineMargin(baseline) {
  const [gop, dem, total] = baseline.statewide;
  return ((gop - dem) / total) * 100;
}

export function projectedCountyMargin(row, swing) {
  const m = countyBaselineMargin(row) + swing;
  return Math.max(-99.9, Math.min(99.9, m));
}

export function resultMargin(res) {
  // res = [repVotes, demVotes, pctReporting]
  const [r, d] = res;
  const t = r + d;
  return t ? ((r - d) / t) * 100 : null;
}

export function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Tiny element builder that only ever sets text via textContent (no innerHTML with data).
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
