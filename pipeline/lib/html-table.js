// Just enough HTML table parsing for Wikipedia polling tables, with no dependencies.
// Handles quoted attributes containing ">", nested tables, rowspan/colspan, <sup> footnotes and entities.

const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b(?:[^>"']|"[^"]*"|'[^']*')*\/?>/g;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", minus: "−", plusmn: "±", thinsp: " " };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function attr(tagText, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tagText);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3]) : null;
}

const BLOCK = new Set(["br", "p", "div", "table", "tr", "td", "th", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "section"]);

/** Plain text of an HTML fragment: drops <sup> footnotes, <style>/<script>, hidden sort keys. */
export function textOf(fragment) {
  let s = fragment
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<sup\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/sup>/gi, "")
    .replace(/<span\b(?:[^>"']|"[^"]*"|'[^']*')*display:\s*none(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/span>/gi, "")
    .replace(TAG, (tag, name) => (BLOCK.has(name.toLowerCase()) ? " " : ""));
  return decodeEntities(s).replace(/[\s ]+/g, " ").trim();
}

/** Find top-level <table> elements in a fragment (nested tables stay inside their parent). */
export function findTables(html) {
  const tables = [];
  let depth = 0, start = -1, m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) {
    if (m[1].toLowerCase() !== "table") continue;
    const closing = m[0][1] === "/";
    if (!closing) {
      if (depth === 0) start = m.index;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) tables.push(html.slice(start, m.index + m[0].length));
    }
  }
  return tables;
}

/**
 * Parse a table into a grid of { text, html } cells with rowspan/colspan expanded.
 * Rows of nested tables are ignored.
 */
export function parseTable(tableHtml) {
  const rows = [];
  let depth = 0, row = null, cell = null, m;
  TAG.lastIndex = 0;
  const closeCell = (end) => {
    if (cell && row) { cell.html = tableHtml.slice(cell.start, end); row.push(cell); }
    cell = null;
  };
  while ((m = TAG.exec(tableHtml))) {
    const name = m[1].toLowerCase();
    const closing = m[0][1] === "/";
    if (name === "table") { depth += closing ? -1 : 1; continue; }
    if (depth !== 1) continue;
    if (name === "tr") {
      closeCell(m.index);
      if (!closing) { row = []; rows.push(row); } else row = null;
    } else if (name === "td" || name === "th") {
      closeCell(m.index);
      if (!closing && row) {
        cell = { tag: name, start: m.index + m[0].length, rowspan: Number(attr(m[0], "rowspan")) || 1, colspan: Number(attr(m[0], "colspan")) || 1 };
      }
    }
  }
  closeCell(tableHtml.length);

  // Expand spans into a rectangular grid.
  const grid = [];
  const pending = []; // pending[col] = { cell, left }
  rows.forEach((cells, r) => {
    const out = [];
    let col = 0;
    const next = () => { while (pending[col]?.left > 0) { out[col] = pending[col].cell; pending[col].left--; col++; } };
    for (const c of cells) {
      next();
      const value = { tag: c.tag, html: c.html, text: textOf(c.html) };
      for (let k = 0; k < Math.min(c.colspan, 50); k++) {
        out[col] = value;
        if (c.rowspan > 1) pending[col] = { cell: value, left: Math.min(c.rowspan, 500) - 1 };
        col++;
      }
    }
    next();
    grid[r] = out;
  });
  return grid;
}

/** The HTML between a heading with the given id and the next heading of the same or higher level. */
export function sectionById(html, id) {
  const re = new RegExp(`<h([1-6])\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "i");
  const m = re.exec(html);
  if (!m) return null;
  const level = Number(m[1]);
  const rest = html.slice(m.index);
  const end = new RegExp(`<h[1-${level}]\\b`, "i").exec(rest.slice(m[0].length));
  return end ? rest.slice(0, m[0].length + end.index) : rest;
}
