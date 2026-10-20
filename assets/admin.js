import { h, projectionSentence, bannerMessages, relativeTime, STATUS_LABELS, suggestedMargin, formatMargin, marketProbR } from "./common.js";

const FILE_PATH = "data/projections.json";
const SESSION_KEY = "tx26.session";
const API = "https://api.github.com";

const S = {
  session: null,   // { token, owner, repo, branch, login }
  sha: null,       // blob sha of the file we loaded (optimistic concurrency)
  original: null,  // data as loaded, for change detection
  data: null,      // working copy
  baseline: null,  // county names for results parsing
  polls: null,     // data/polls.json (for the suggested margin)
  markets: null,   // data/markets.json
};

const $ = (id) => document.getElementById(id);

/* ---------------- GitHub API ---------------- */

async function gh(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${S.session.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(body?.message || `GitHub returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const repoPath = () => `/repos/${encodeURIComponent(S.session.owner)}/${encodeURIComponent(S.session.repo)}`;

function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function loadFile() {
  const file = await gh(`${repoPath()}/contents/${FILE_PATH}?ref=${encodeURIComponent(S.session.branch)}`);
  S.sha = file.sha;
  S.original = JSON.parse(decodeBase64(file.content));
  S.data = structuredClone(S.original);
  normalize(S.data);
}

/* ---------------- Sign in / out ---------------- */

function defaultsFromLocation() {
  const host = location.hostname;
  if (host.endsWith(".github.io")) {
    const owner = host.slice(0, -".github.io".length);
    const seg = location.pathname.split("/").filter(Boolean)[0];
    const repo = seg && !seg.endsWith(".html") ? seg : `${owner}.github.io`;
    return { owner, repo, branch: "main" };
  }
  return { owner: "abdonmorales", repo: "election26", branch: "main" };
}

async function signIn(session) {
  S.session = session;
  const repo = await gh(repoPath());
  if (!repo.permissions?.push) {
    throw new Error("This token can read the repository but cannot write to it. Give it Contents: Read and write.");
  }
  let login = "";
  try { login = (await gh("/user")).login; } catch { /* fine-grained tokens without account access */ }
  S.session.login = login;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(S.session));
  await loadFile();
}

function signOut() {
  sessionStorage.removeItem(SESSION_KEY);
  S.session = S.data = S.original = S.sha = null;
  $("token").value = "";
  $("editor").hidden = true;
  $("login-card").hidden = false;
  $("who").textContent = "";
  renderPreviewTicker();
}

/* ---------------- Data model ---------------- */

function normalize(d) {
  d.banner ??= { custom: "", showAuto: true };
  d.feed ??= [];
  for (const r of d.races || []) {
    r.candidates ??= { R: "", D: "" };
    r.projection ??= { status: "pending", winner: "", margin: 0 };
    r.results ??= { pctReporting: 0, counties: {} };
    r.results.counties ??= {};
    r.note ??= "";
  }
}

const isDirty = () => JSON.stringify(S.data) !== JSON.stringify(normalized(S.original));
function normalized(d) { const c = structuredClone(d); normalize(c); return c; }

function changed() {
  const dirty = isDirty();
  $("dirty-chip").textContent = dirty ? "Unsaved changes" : "Saved";
  $("dirty-chip").className = dirty ? "chip R" : "chip";
  renderPreviewTicker();
}

function renderPreviewTicker() {
  const el = $("preview-ticker");
  const msgs = S.data ? bannerMessages(S.data) : [];
  el.replaceChildren(h("div", { class: "ticker-item on" },
    h("span", { class: "tag" }, "PREVIEW"),
    msgs.length ? msgs.join("   •   ") : "Projections coming soon — stay tuned."));
}

/* ---------------- Race editor ---------------- */

function raceEditor(race) {
  const p = race.projection;
  const id = race.id;
  const preview = h("div", { class: "preview" });
  const marginNum = h("input", { type: "number", min: 0, max: 100, step: 0.5, value: p.margin, "aria-label": "Margin in points" });
  const marginRange = h("input", { type: "range", min: 0, max: 30, step: 0.5, value: Math.min(30, p.margin), "aria-label": "Margin slider" });
  const winnerCtl = h("div", { class: "seg-ctl", role: "radiogroup", "aria-label": "Projected winner" });
  const statusCtl = h("div", { class: "seg-ctl", role: "radiogroup", "aria-label": "Status" });
  const winnerBlock = h("div", {});

  const nameD = h("input", { maxlength: 60, value: race.candidates.D });
  const nameR = h("input", { maxlength: 60, value: race.candidates.R });

  function refresh() {
    const s = projectionSentence(race);
    preview.replaceChildren(h("span", { class: "tag" }, "TOP BAR"), s || "(nothing shown for this race)");
    winnerBlock.hidden = !(p.status === "projection" || p.status === "called");
    for (const inp of winnerCtl.querySelectorAll("input")) {
      inp.nextElementSibling.textContent = `${race.candidates[inp.value] || inp.value} (${inp.value})`;
    }
    changed();
  }

  for (const st of ["pending", "tossup", "projection", "called"]) {
    statusCtl.append(h("label", {},
      h("input", { type: "radio", name: `status-${id}`, value: st, checked: p.status === st,
        onchange: () => { p.status = st; if ((st === "projection" || st === "called") && !p.winner) setWinner("R"); refresh(); } }),
      h("span", {}, STATUS_LABELS[st])));
  }
  function setWinner(w) {
    p.winner = w;
    for (const inp of winnerCtl.querySelectorAll("input")) inp.checked = inp.value === w;
  }
  for (const w of ["D", "R"]) {
    winnerCtl.append(h("label", {},
      h("input", { type: "radio", name: `winner-${id}`, value: w, checked: p.winner === w, onchange: () => { setWinner(w); refresh(); } }),
      h("span", {}, w)));
  }
  function setMargin(v, from) {
    v = Math.max(0, Math.min(100, Math.round((Number(v) || 0) * 10) / 10));
    p.margin = v;
    if (from !== marginNum) marginNum.value = v;
    if (from !== marginRange) marginRange.value = Math.min(30, v);
    refresh();
  }
  marginNum.addEventListener("input", () => setMargin(marginNum.value, marginNum));
  marginRange.addEventListener("input", () => setMargin(marginRange.value, marginRange));
  nameD.addEventListener("input", () => { race.candidates.D = nameD.value.trim(); refresh(); });
  nameR.addEventListener("input", () => { race.candidates.R = nameR.value.trim(); refresh(); });

  const note = h("input", { maxlength: 200, value: race.note, placeholder: "Optional context shown under the race" });
  note.addEventListener("input", () => { race.note = note.value; changed(); });

  // Results
  const csv = h("textarea", { spellcheck: "false", placeholder: "County, Republican votes, Democratic votes, % reporting\nHarris, 512000, 640000, 65\nTravis, 150000, 420000, 80" });
  csv.value = resultsToCSV(race);
  const parseOut = h("div", { class: "parse-out" });
  const pctIn = h("input", { type: "number", min: 0, max: 100, step: 1, value: race.results.pctReporting });
  pctIn.addEventListener("input", () => { race.results.pctReporting = Math.max(0, Math.min(100, Number(pctIn.value) || 0)); changed(); });

  function applyCSV() {
    const { counties, errors } = parseResults(csv.value);
    race.results.counties = counties;
    const n = Object.keys(counties).length;
    parseOut.textContent = `${n} count${n === 1 ? "y" : "ies"} loaded.` + (errors.length ? ` Skipped: ${errors.slice(0, 6).join("; ")}${errors.length > 6 ? "…" : ""}` : "");
    parseOut.className = "parse-out" + (errors.length ? " msg err" : "");
    changed();
  }

  const nudges = h("div", { class: "nudges" },
    [-1, -0.5, 0.5, 1].map((d) => h("button", { class: "btn sm", type: "button", onclick: () => setMargin(p.margin + d) }, d > 0 ? `+${d}` : `${d}`)),
    [3, 5, 8, 10].map((v) => h("button", { class: "btn sm ghost", type: "button", onclick: () => setMargin(v) }, `+${v}`)));
  winnerBlock.append(
    h("h3", {}, "Projected winner"), winnerCtl,
    h("h3", {}, "Margin (points)"), h("div", { class: "margin-ctl" }, marginRange, marginNum), nudges);

  // Fills the form from the suggestion. Nothing is published until you click Publish.
  function applySuggestion(value) {
    const m = Math.round(Math.abs(value) * 2) / 2;
    if (m === 0) {
      p.status = "tossup";
    } else {
      if (p.status !== "called") p.status = "projection";
      setWinner(value > 0 ? "R" : "D");
    }
    for (const inp of statusCtl.querySelectorAll("input")) inp.checked = inp.value === p.status;
    setMargin(m);
  }

  refresh();

  return h("section", { class: "card" },
    h("h2", {}, race.title),
    h("div", { class: "row-2" },
      h("label", {}, "Democrat", nameD),
      h("label", {}, "Republican", nameR)),
    h("h3", {}, "Status"), statusCtl,
    suggestionBox(race, applySuggestion),
    h("div", {}, winnerBlock),
    preview,
    h("label", { class: "stack" }, "Note", note),
    h("details", {},
      h("summary", { class: "help" }, "Emergency override: county results"),
      h("p", { class: "help" }, "Official returns load automatically from the Texas Secretary of State. Only use this if that feed is down or wrong: paste one county per line (name or FIPS, Republican votes, Democratic votes, % reporting). Pasted counties replace the automatic numbers for those counties until you clear them."),
      csv,
      h("div", { class: "nudges" },
        h("button", { class: "btn sm", type: "button", onclick: applyCSV }, "Apply results"),
        h("button", { class: "btn sm ghost", type: "button", onclick: () => { csv.value = ""; applyCSV(); } }, "Clear results")),
      parseOut,
      h("label", { class: "stack" }, "Statewide expected vote in (%)", pctIn)),
  );
}

/* ---------------- Suggested margin ---------------- */

function suggestionBox(race, apply) {
  const s = suggestedMargin(S.polls, S.markets, race.id);
  if (!s) return h("div", { class: "suggest" }, h("span", { class: "help" }, "No polling or market data yet for a suggestion."));
  const pR = marketProbR(S.markets, race.id);
  const parts = [];
  if (s.poll !== null) parts.push(`polls ${formatMargin(s.poll)}`);
  if (s.market !== null) parts.push(`markets ${formatMargin(s.market)} (R ${Math.round(pR)}% to win)`);
  return h("div", { class: "suggest" },
    h("div", {},
      h("div", { class: "suggest-label" }, "Suggested margin"),
      h("div", { class: "suggest-value num" }, formatMargin(s.value)),
      h("div", { class: "help" }, `${parts.join(" · ")} — ${s.basis}`)),
    h("button", { class: "btn sm", type: "button", onclick: () => apply(s.value),
      title: "Fill in the form with this margin. You still need to click Publish." }, "Use this"));
}

/* ---------------- Results CSV ---------------- */

function countyIndex() {
  const byName = new Map();
  for (const [fips, row] of Object.entries(S.baseline.counties)) {
    byName.set(row[0].toLowerCase().replace(/[^a-z]/g, ""), fips);
  }
  return byName;
}

function parseResults(text) {
  const byName = countyIndex();
  const counties = {};
  const errors = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, "").trim());
    if (cols.length < 3) { errors.push(`"${line.slice(0, 24)}"`); continue; }
    const key = cols[0];
    const nums = cols.slice(1, 4).map((c) => Number(c.replace(/[,%\s]/g, "")));
    if (Number.isNaN(nums[0]) || Number.isNaN(nums[1])) {
      if (!/county|name/i.test(key)) errors.push(`"${key.slice(0, 24)}"`);
      continue;
    }
    let fips = null;
    if (/^\d{5}$/.test(key) && S.baseline.counties[key]) fips = key;
    else if (/^\d{1,3}$/.test(key)) fips = `48${key.padStart(3, "0")}`;
    else fips = byName.get(key.toLowerCase().replace(/county$/i, "").replace(/[^a-z]/g, ""));
    if (!fips || !S.baseline.counties[fips]) { errors.push(`unknown county "${key.slice(0, 24)}"`); continue; }
    const pct = Number.isNaN(nums[2]) || nums[2] === undefined ? 0 : Math.max(0, Math.min(100, nums[2]));
    counties[fips] = [Math.max(0, Math.round(nums[0])), Math.max(0, Math.round(nums[1])), pct];
  }
  return { counties, errors };
}

function resultsToCSV(race) {
  return Object.entries(race.results.counties || {})
    .map(([fips, [r, d, pct]]) => `${S.baseline.counties[fips]?.[0] ?? fips}, ${r}, ${d}, ${pct ?? 0}`)
    .join("\n");
}

/* ---------------- Feed ---------------- */

function renderFeedList() {
  const ol = $("feed-list");
  ol.replaceChildren(...S.data.feed.map((e, i) => h("li", {},
    h("time", { datetime: e.t }, relativeTime(e.t)),
    h("span", {}, e.text),
    h("button", { class: "btn sm ghost", type: "button", "aria-label": "Delete entry",
      onclick: () => { S.data.feed.splice(i, 1); renderFeedList(); changed(); } }, "Delete"))));
}

/* ---------------- Publish ---------------- */

function autoFeedEntries(now) {
  const entries = [];
  const before = normalized(S.original);
  for (const race of S.data.races) {
    const prev = before.races.find((r) => r.id === race.id);
    const s = projectionSentence(race);
    if (s && s !== (prev ? projectionSentence(prev) : null)) entries.push({ t: now, race: race.id, text: s });
  }
  const custom = S.data.banner.custom.trim();
  if (custom && custom !== (before.banner.custom || "").trim()) entries.push({ t: now, text: custom });
  return entries;
}

async function publish() {
  const btn = $("publish");
  const msg = $("publish-msg");
  if (!isDirty()) { msg.textContent = "Nothing to publish."; msg.className = "msg"; return; }
  btn.disabled = true;
  msg.textContent = "Publishing…"; msg.className = "msg";
  try {
    const now = new Date().toISOString();
    const out = structuredClone(S.data);
    out.feed = [...autoFeedEntries(now), ...out.feed].slice(0, 200);
    out.updatedAt = now;
    const summary = out.races.map((r) => projectionSentence(r)).filter(Boolean)[0];
    const message = $("commit-msg").value.trim() || `Update projections${summary ? `: ${summary}` : ""}`;
    const res = await gh(`${repoPath()}/contents/${FILE_PATH}`, {
      method: "PUT",
      body: JSON.stringify({
        message: message.slice(0, 200),
        content: encodeBase64(JSON.stringify(out, null, 2) + "\n"),
        sha: S.sha,
        branch: S.session.branch,
      }),
    });
    S.sha = res.content.sha;
    S.original = out;
    S.data = structuredClone(out);
    normalize(S.data);
    $("commit-msg").value = "";
    renderEditor();
    msg.textContent = `Published ${new Date().toLocaleTimeString()} — live on the site in about a minute.`;
    msg.className = "msg ok";
  } catch (err) {
    if (err.status === 409 || err.status === 422) {
      msg.textContent = "The file changed on GitHub since you loaded it (another device?). Click “Discard & reload” and re-apply your change.";
    } else if (err.status === 401) {
      msg.textContent = "Your token was rejected or expired. Sign out and sign in again.";
    } else {
      msg.textContent = `Publish failed: ${err.message}`;
    }
    msg.className = "msg err";
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- Render ---------------- */

function renderEditor() {
  $("login-card").hidden = true;
  $("editor").hidden = false;
  $("who").textContent = `${S.session.login ? "@" + S.session.login + " · " : ""}${S.session.owner}/${S.session.repo}@${S.session.branch}`;

  $("banner-custom").value = S.data.banner.custom || "";
  $("banner-auto").checked = S.data.banner.showAuto !== false;

  $("race-editors").replaceChildren(...S.data.races.map((race) => raceEditor(race)));
  renderFeedList();
  changed();
}

function wire() {
  const d = defaultsFromLocation();
  $("owner").value = d.owner; $("repo").value = d.repo; $("branch").value = d.branch;

  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const m = $("login-msg");
    m.textContent = "Checking token…"; m.className = "msg";
    try {
      await signIn({ token: $("token").value.trim(), owner: $("owner").value.trim(), repo: $("repo").value.trim(), branch: $("branch").value.trim() });
      $("token").value = "";
      m.textContent = "";
      renderEditor();
    } catch (err) {
      S.session = null;
      m.textContent = err.status === 401 ? "GitHub rejected that token." : err.status === 404 ? "Repository or branch not found for this token." : err.message;
      m.className = "msg err";
    }
  });

  $("banner-custom").addEventListener("input", (e) => { S.data.banner.custom = e.target.value; changed(); });
  $("banner-auto").addEventListener("change", (e) => { S.data.banner.showAuto = e.target.checked; changed(); });
  $("feed-add").addEventListener("click", () => {
    const t = $("feed-text").value.trim();
    if (!t) return;
    S.data.feed.unshift({ t: new Date().toISOString(), text: t.slice(0, 280) });
    $("feed-text").value = "";
    renderFeedList(); changed();
  });
  $("publish").addEventListener("click", publish);
  $("reload").addEventListener("click", async () => {
    if (isDirty() && !confirm("Discard unsaved changes?")) return;
    try { await loadFile(); renderEditor(); $("publish-msg").textContent = "Reloaded latest from GitHub."; $("publish-msg").className = "msg"; }
    catch (err) { $("publish-msg").textContent = err.message; $("publish-msg").className = "msg err"; }
  });
  $("logout").addEventListener("click", () => {
    if (S.data && isDirty() && !confirm("You have unsaved changes. Sign out anyway?")) return;
    signOut();
  });
  window.addEventListener("beforeunload", (e) => { if (S.data && isDirty()) e.preventDefault(); });
}

async function init() {
  // Refuse to run inside a frame (meta CSP cannot set frame-ancestors on GitHub Pages).
  if (window.top !== window.self) {
    document.body.textContent = "The projection desk cannot be embedded.";
    return;
  }
  wire();
  renderPreviewTicker();
  S.baseline = await (await fetch("data/baseline-2024.json")).json();
  const load = (f) => fetch(`data/${f}?t=${Date.now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  [S.polls, S.markets] = await Promise.all([load("polls.json"), load("markets.json")]);
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (saved) {
    try { await signIn(JSON.parse(saved)); renderEditor(); }
    catch { sessionStorage.removeItem(SESSION_KEY); S.session = null; }
  }
}

init();
