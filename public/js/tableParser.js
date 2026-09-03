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
 * Unit orientation vector of a box, pointing from its center to the
 * midpoint of its right edge. Axis-aligned boxes (the current shape
 * produced by toDetections/coerceBounds) yield a purely horizontal
 * vector (1, 0). If a future box shape ever carries a rotation angle
 * (in radians), it is honored automatically.
 */
function dirOf(b) {
  if (typeof b.angle === "number") {
    return { x: Math.cos(b.angle), y: Math.sin(b.angle) };
  }
  return { x: 1, y: 0 };
}

/**
 * Candidate pre-filter: two boxes may only chain if their orientation
 * vectors are roughly aligned (within ~25 degrees). This is NOT the
 * row-membership decision — it merely discards absurd pairings before
 * scoring. Final membership is decided globally in clusterRows.
 */
const DIR_COS_MIN = 0.9;

function similarDir(a, b) {
  const da = dirOf(a);
  const db = dirOf(b);
  return da.x * db.x + da.y * db.y >= DIR_COS_MIN;
}

/**
 * Half-ray/AABB intersection (slab method). The ray starts at `origin`,
 * travels along unit vector `d` and only counts from distance `tStart`
 * onwards (i.e. beyond the current box's right edge). Returns the entry
 * distance of the first hit, or null if the ray misses the box.
 */
function rayHit(origin, d, tStart, box) {
  const min = { x: box.x, y: box.y };
  const max = { x: box.x + (box.w || 0), y: box.y + (box.h || 0) };
  let tmin = tStart;
  let tmax = Infinity;
  for (const axis of ["x", "y"]) {
    if (Math.abs(d[axis]) < 1e-9) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
    } else {
      let t1 = (min[axis] - origin[axis]) / d[axis];
      let t2 = (max[axis] - origin[axis]) / d[axis];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

/** Best-fit (total least squares) line direction of box centers. */
function fitLineDir(centers) {
  const cx = centers.reduce((s, c) => s + c.x, 0) / centers.length;
  const cy = centers.reduce((s, c) => s + c.y, 0) / centers.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const c of centers) {
    const vx = c.x - cx;
    const vy = c.y - cy;
    sxx += vx * vx;
    syy += vy * vy;
    sxy += vx * vy;
  }
  // Principal eigenvector of the 2x2 covariance [[sxx,sxy],[sxy,syy]].
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { x: Math.cos(theta), y: Math.sin(theta), cx, cy };
}

/**
 * Quality of a candidate chain: lower is better.
 *
 *   rmsDev / meanH — root-mean-square perpendicular deviation of the box
 *                    centers from the chain's best-fit line, normalized by
 *                    mean box height. RMS stays robust when one box merely
 *                    jitters vertically (real OCR rows are never perfectly
 *                    straight) yet still blows up when a foreign box is
 *                    swallowed.
 *   3 / len        — length term: longer chains explaining the same
 *                    geometry beat fragmented subsets, whose best-fit
 *                    residual is artificially small (2-point fits are
 *                    exact by construction).
 */
const LEN_WEIGHT = 3;

function chainScore(chain, sorted) {
  if (chain.length < 2) return Infinity; // singletons resolved last
  const centers = chain.map((i) => ({
    x: sorted[i].x + sorted[i].w / 2,
    y: sorted[i].y + sorted[i].h / 2,
  }));
  const { x: dxu, y: dyu, cx, cy } = fitLineDir(centers);
  let dev2 = 0;
  let hSum = 0;
  for (let k = 0; k < chain.length; k++) {
    const b = sorted[chain[k]];
    const vx = centers[k].x - cx;
    const vy = centers[k].y - cy;
    const perp = dyu * vx - dxu * vy;
    dev2 += perp * perp;
    hSum += b.h || 1;
  }
  const meanH = Math.max(hSum / chain.length, 1);
  const rmsDev = Math.sqrt(dev2 / chain.length);
  return rmsDev / meanH + LEN_WEIGHT / chain.length;
}

/**
 * Cluster boxes into rows. Two phases:
 *
 * Phase 1 — hypothesis generation: every box seeds a greedy rightward
 * march along its orientation vector (center → right-edge midpoint);
 * the nearest similar-oriented box struck by the ray is chained and the
 * march continues from it. Chains may overlap: a grazing ray (e.g. a
 * horizontal ray clipping the tail of a tilted row below) produces a
 * corrupted candidate rather than an accepted grouping.
 *
 * Phase 2 — global resolution: candidates are scored by collinearity
 * (best-fit line deviation, orientation spread) and processed best
 * first. Each chain claims the longest unclaimed prefix of itself, so
 * a corrupted tail is simply cut off and clean rows win their boxes.
 * Boxes claimed by no chain become singleton rows.
 *
 * Rows are returned top-to-bottom (min y), each row ordered left-to-right.
 */
export function clusterRows(boxes, { maxGap = Infinity } = {}) {
  const sorted = [...boxes].sort((a, b) => a.x - b.x);

  // Phase 1: candidate chains.
  const chains = [];
  for (let s = 0; s < sorted.length; s++) {
    const chain = [s];
    const inChain = new Set(chain);
    let cur = sorted[s];
    for (;;) {
      const d = dirOf(cur);
      const origin = { x: cur.x + cur.w / 2, y: cur.y + cur.h / 2 };
      // Distance from the center to the right-edge midpoint along d.
      const tStart = (cur.w / 2) * d.x;

      let best = -1;
      let bestT = Infinity;
      for (let i = 0; i < sorted.length; i++) {
        if (inChain.has(i)) continue;
        const cand = sorted[i];
        if (!similarDir(cur, cand)) continue;
        const t = rayHit(origin, d, tStart, cand);
        if (t === null) continue;
        if (t - tStart > maxGap) continue;
        if (t < bestT) {
          bestT = t;
          best = i;
        }
      }
      if (best < 0) break;
      inChain.add(best);
      chain.push(best);
      cur = sorted[best];
    }
    chains.push(chain);
  }

  // Phase 2: score and resolve overlaps.
  const scored = chains
    .map((c) => ({ c, score: chainScore(c, sorted) }))
    .sort((a, b) => a.score - b.score || b.c.length - a.c.length);

  const claimed = new Set();
  const rows = [];
  for (const { c } of scored) {
    // Claim the longest unclaimed prefix of the chain; a corrupted tail
    // (boxes already won by a better row) is cut off here.
    let end = 0;
    while (end < c.length && !claimed.has(c[end])) end++;
    if (end === 0) continue;
    for (let k = 0; k < end; k++) claimed.add(c[k]);
    rows.push(c.slice(0, end).map((i) => sorted[i]));
  }

  // Boxes claimed by no chain become their own (singleton) rows.
  for (let i = 0; i < sorted.length; i++) {
    if (!claimed.has(i)) rows.push([sorted[i]]);
  }

  // Restore page reading order (top-to-bottom) for detectTables, which
  // expects headers to precede their data rows.
  rows.sort((a, b) => Math.min(...a.map((r) => r.y)) - Math.min(...b.map((r) => r.y)));

  return rows;
}

/**
 * Merge horizontally adjacent texts within each row whose boxes are
 * closer than a height-aware distance threshold.
 *
 * For each row independently (left-to-right), the gap between the left
 * box's right edge and the right box's left edge is compared against
 * `threshold = max(GAP_RATIO * meanHeight, MIN_MERGE_GAP)`. When the gap
 * is within the threshold the two boxes are merged into one: their texts
 * are concatenated and their bounding boxes are united (min x/y, max
 * right/bottom). Rows are returned in the same shape and order; the
 * input is not mutated.
 */
const GAP_RATIO = 0.6;
const MIN_MERGE_GAP = 2;

export function mergeNearbyTexts(rows, { gapRatio = GAP_RATIO, minGap = MIN_MERGE_GAP } = {}) {
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const merged = [];
    for (let i = 0; i < row.length; i++) {
      const b = row[i];
      const prev = merged.length > 0 ? merged[merged.length - 1] : null;
      if (prev !== null) {
        const gap = b.x - (prev.x + prev.w);
        const threshold = Math.max(gapRatio * ((prev.h + b.h) / 2), minGap);
        if (gap <= threshold) {
          const x = Math.min(prev.x, b.x);
          const y = Math.min(prev.y, b.y);
          const right = Math.max(prev.x + prev.w, b.x + b.w);
          const bottom = Math.max(prev.y + prev.h, b.y + b.h);
          merged[merged.length - 1] = {
            ...prev,
            text: prev.text + ' ' + b.text,
            x,
            y,
            w: right - x,
            h: bottom - y,
          };
          continue;
        }
      }
      merged.push({ ...b });
    }
    out.push(merged);
  }
  return out;
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

/**
 * Keep only the analysis-relevant rows: the first header row (Sample
 * Name / Sample ID / Conc.) and, below it, only rows whose combined
 * cell texts contain a sample name we are looking for (AGIZ, BOGAZ,
 * PRESEPARATOR, STAGE 1-8 — with their known OCR spellings).
 *
 * Returns [headerRow, ...matchingSampleRows]; rows above the header and
 * non-sample rows below it are dropped. If no header row is found the
 * input is returned unchanged (fallback so column resolution can still
 * try). The input is not mutated.
 */
const SAMPLE_NAME_RE =
  /AGIZ|AĞIZ|MOUTH|BOGAZ|BOĞAZ|THROAT|PRESEP|STAGE\s*_?\s*0?\s*[1-8]/i;

function rowMatchesSample(row) {
  let text = "";
  for (let i = 0; i < row.length; i++) text += row[i].text;
  return SAMPLE_NAME_RE.test(text);
}

export function filterSampleRows(rows) {
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (isHeaderRow(buildCells(rows[i]))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return rows;

  const out = [rows[headerIdx]];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    if (rowMatchesSample(rows[i])) out.push(rows[i]);
  }
  return out;
}

/**
 * Repair rows whose adjacent cells were falsely merged by
 * mergeNearbyTexts (texts of two or more columns detected as one box).
 *
 * The true column count is the maximum row length; rows with that many
 * items are considered solid and are left untouched. For each deficient
 * row, every cell is compared against the solid rows: cells aligned with
 * exactly one solid cell are fine, cells aligned with k > 1 solid cells
 * were merged from k columns and are split at the exact midpoints of the
 * aligned solid cells' box edges (median across all solid rows).
 */
export function fixFalseMerges(rows) {
  if (!rows.length) return rows;
  const maxCols = Math.max(...rows.map((r) => r.length));
  if (maxCols <= 1) return rows;
  if (rows.every((r) => r.length === maxCols)) return rows;

  const solid = rows.filter((r) => r.length === maxCols);
  if (!solid.length) return rows;

  const out = [];
  for (const row of rows) {
    if (row.length === maxCols) {
      out.push(row);
      continue;
    }

    const rebuilt = [];
    for (const cell of row) {
      const left = cell.x;
      const right = cell.x + cell.w;
      const centerTol = Math.max(2, cell.w * 0.05);

      // Solid cells aligned with this cell (x-center inside its span).
      const aligned = [];
      for (const srow of solid) {
        const hits = srow.filter(
          (b) => centerX(b) >= left - centerTol && centerX(b) <= right + centerTol,
        );
        if (hits.length) aligned.push(hits);
      }
      if (!aligned.length || aligned.every((hits) => hits.length === 1)) {
        rebuilt.push({ ...cell });
        continue;
      }

      // k = number of columns falsely merged into this cell.
      const k = Math.max(...aligned.map((hits) => hits.length));
      if (k < 2) {
        rebuilt.push({ ...cell });
        continue;
      }

      // Split points: for each adjacent column pair, the midpoint between
      // the left cell's right edge and the right cell's left edge,
      // median across all solid rows that aligned with this cell.
      const splitPts = [];
      for (let c = 1; c < k; c++) {
        const mids = [];
        for (const hits of aligned) {
          if (hits.length < k) continue;
          const ordered = [...hits].sort((a, b) => a.x - b.x);
          mids.push((ordered[c - 1].x + ordered[c - 1].w + ordered[c].x) / 2);
        }
        if (!mids.length) break;
        mids.sort((a, b) => a - b);
        splitPts.push(mids[Math.floor(mids.length / 2)]);
      }
      if (splitPts.length !== k - 1) {
        rebuilt.push({ ...cell });
        continue;
      }

      // Split the merged text at the characters corresponding to the split
      // points. Per-character x is not available, so character centers are
      // laid out proportionally across the merged box's width; each chunk
      // is cut at the character whose center is nearest its split point.
      const text = cell.text;
      const n = text.length;
      const charCenter = (i) => left + ((right - left) * (i + 0.5)) / n;
      const cutIdx = [];
      for (const p of splitPts) {
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < n; i++) {
          const d = Math.abs(charCenter(i) - p);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        if (!cutIdx.length || best > cutIdx[cutIdx.length - 1]) {
          cutIdx.push(best);
        }
      }
      if (cutIdx.length !== splitPts.length) {
        rebuilt.push({ ...cell });
        continue;
      }

      // Slice the cell box at the split points and emit one box per chunk.
      const bounds = [left, ...splitPts, right];
      const edges = [0, ...cutIdx, n];
      for (let c = 0; c < k; c++) {
        const cx = bounds[c];
        const cright = bounds[c + 1];
        const chunk = text.slice(edges[c], edges[c + 1]).trim();
        if (!chunk) continue;
        rebuilt.push({
          ...cell,
          text: chunk,
          x: cx,
          w: cright - cx,
        });
      }
    }

    rebuilt.sort((a, b) => a.x - b.x);
    out.push(rebuilt);
  }
  return out;
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
  let rows = clusterRows(detections);
  console.log("[OCR] Rows", rows);
  rows = mergeNearbyTexts(rows);
  rows = filterSampleRows(rows);
  rows = fixFalseMerges(rows);
  console.log("[OCR] Final Rows", rows);
  const tables = [];
  let i = 0;

  while (i < rows.length) {
    const headerCells = buildCells(rows[i]);
    if (!isHeaderRow(headerCells)) {
      i++;
      continue;
    }
    if (globalThis.__DEBUG_OCR__) {
      console.log("[OCR] Header Cells", headerCells);
    }

    // With rows normalized by fixFalseMerges, every row's cell at the
    // same index belongs to the same column. Map the relevant columns
    // (Sample Name / Sample ID / Conc.) straight to header indices.
    const nameIdx = headerCells.findIndex((c) => isName(c.text));
    const idIdx = headerCells.findIndex((c) => isId(c.text));
    const concIdx = headerCells.findIndex((c) => isNum(c.text));
    if (nameIdx === -1 || idIdx === -1 || concIdx === -1) {
      i++;
      continue;
    }

    const table = { rows: [] };
    let j = i + 1;
    let captured = false;

    for (; j < rows.length; j++) {
      const nextCells = buildCells(rows[j]);
      if (isHeaderRow(nextCells)) break;

      const cellAt = (idx) => (idx < nextCells.length ? nextCells[idx].text : "");
      const rec = {
        name: cellAt(nameIdx),
        id: cellAt(idIdx),
        conc: cellAt(concIdx),
      };

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