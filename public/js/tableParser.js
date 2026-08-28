/**
 * Table detection purely from the spatial layout of OCR text boxes.
 * PaddleOCR reports only text bounding boxes (no ruling lines), so a
 * table is recovered by clustering boxes into rows (by vertical center,
 * which tolerates the overlapping boxes PaddleOCR produces for adjacent
 * lines) and aligning cells into columns by their header x-ranges.
 */

const HDR_NAME = /name/i;
const HDR_ID = /id/i;
const HDR_CONC = /conc/i;

const centerX = (c) => c.x + (c.w ?? (c.right - c.x)) / 2;
const centerY = (b) => b.y + b.h / 2;

/**
 * Cluster boxes into rows using vertical centers. PaddleOCR boxes for
 * adjacent lines overlap vertically (box height > line pitch), so a plain
 * y-overlap test merges real rows together. Grouping by center with a
 * tolerance derived from the median box height separates them cleanly
 * while still merging wrapped/segmented cells of the same physical row.
 */
function clusterRows(boxes) {
  const heights = boxes.map((b) => b.h || 1).sort((a, b) => a - b);
  const med = heights[Math.floor(heights.length / 2)] || 1;
  const tol = Math.max(med * 0.62, 8);

  const sorted = [...boxes].sort((a, b) => centerY(a) - centerY(b));
  const rows = [];
  let current = [];
  let currentY = 0;

  for (const b of sorted) {
    const cy = centerY(b);
    if (current.length === 0) {
      current = [b];
      currentY = cy;
      continue;
    }
    if (Math.abs(cy - currentY) <= tol) {
      current.push(b);
      currentY = (currentY * (current.length - 1) + cy) / current.length;
    } else {
      rows.push(current);
      current = [b];
      currentY = cy;
    }
  }
  if (current.length) rows.push(current);

  return rows
    .map((r) => [...r].sort((a, b) => a.x - b.x))
    .filter((r) => r.length);
}

/** Wrap a clustered row of boxes into cell-like entries with x/right bounds. */
function buildCells(row) {
  return row.map((b) => ({
    x: b.x,
    right: b.x + b.w,
    bottom: b.y + b.h,
    text: b.text,
  }));
}

function boundsOf(list) {
  return {
    x: Math.min(...list.map((c) => c.x)),
    right: Math.max(...list.map((c) => c.right)),
  };
}

/** x-range of cells matching a predicate, else null. */
function rangeOf(cells, fn) {
  const hits = cells.filter(fn);
  return hits.length ? boundsOf(hits) : null;
}

const isName = (s) => HDR_NAME.test(s);
const isId = (s) => HDR_ID.test(s);
const isNum = (s) => HDR_CONC.test(s);

/** Determine whether a row is an analysis header row. */
function isHeaderRow(cells) {
  const has = (fn) => cells.some((c) => fn(c.text));
  return has(isName) && has(isId) && has(isNum);
}

/**
 * Resolve the Sample Name / Sample ID / Conc. column x-ranges from a header
 * row. Each header token is matched by a distinct keyword so "Sample Name"
 * is never swallowed by the "Sample ID" range. Returns null if any missing.
 */
function resolveColumns(cells) {
  const name = rangeOf(cells, (c) => isName(c.text));
  const id = rangeOf(cells, (c) => isId(c.text));
  const conc = rangeOf(cells, (c) => isNum(c.text));
  if (!name || !id || !conc) return null;

  // Small tolerance so a data cell stays in its own column even with a bit
  // of OCR jitter, but never wide enough to swallow the neighbour column.
  const span = Math.max(name.right - name.x, id.right - id.x, conc.right - conc.x);
  const tol = Math.max(7, span * 0.09);
  return { name, id, conc, tol };
}
/**
 * Assign each data cell to a column only when its center falls inside that
 * column's x-range. Middle/interstitial columns (Ret. Time, Area, plate
 * count) fall outside all three ranges and are ignored.
 */
function rowToRecord(dataCells, columns) {
  const rec = { name: "", id: "", conc: "" };
  const cols = [columns.name, columns.id, columns.conc];

  for (const c of dataCells) {
    const cxx = centerX(c);
    const hits = cols.filter(
      (col) => cxx >= col.x - columns.tol && cxx <= col.right + columns.tol,
    );
    if (!hits.length) continue;
    const key = hits[0] === columns.name ? "name" : hits[0] === columns.id ? "id" : "conc";
    rec[key] = (rec[key] ? rec[key] + " " : "") + c.text;
  }
  return rec;
}

/** Convert a raw concentration string to a number, tolerating commas. */
export function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw)
    .trim()
    .replace(/,/g, ".")
    .replace(/[a-z%<>()=]/gi, "")
    .trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert normalized detections into detected analysis tables.
 * Returns an array of { rows }, each row being { name, id, conc }.
 */
export function detectTables(detections) {
  const rows = clusterRows(detections);
  const tables = [];
  let i = 0;

  while (i < rows.length) {
    const headerCells = buildCells(rows[i]);
    if (!isHeaderRow(headerCells)) {
      i++;
      continue;
    }

    const columns = resolveColumns(headerCells);
    if (!columns) {
      i++;
      continue;
    }

    const tableLeft = Math.min(columns.name.x, columns.id.x, columns.conc.x) - columns.tol;
    const tableRight =
      Math.max(columns.name.right, columns.id.right, columns.conc.right) + columns.tol;

    const table = { rows: [] };
    let j = i + 1;
    let captured = false;

    for (; j < rows.length; j++) {
      const nextCells = buildCells(rows[j]);
      if (isHeaderRow(nextCells)) break;

      // Keep only cells inside the table span, then map to columns.
      const bounded = nextCells.filter(
        (c) => centerX(c) >= tableLeft && centerX(c) <= tableRight,
      );
      const rec = rowToRecord(bounded, columns);

      if (rec && rec.id) {
        captured = true;
        table.rows.push({
          name: rec.name.trim(),
          id: rec.id.trim(),
          conc: toNumber(rec.conc),
        });
        continue;
      }
      if (captured) break; // reached a non-data region (footer) after data
      // Before any data was captured: still scanning toward the data rows.
    }

    if (table.rows.length) tables.push(table);
    i = j;
  }

  return tables;
}