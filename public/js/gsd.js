/**
 * Geometric Standard Deviation (GSD).
 *
 * Fits the rows whose probit lies within [4, 6] using x=log10(Cut-off),
 * y=Probit. Returns the fit (slope, intercept, R^2) plus GSD and n.
 *
 * GSD:
 *  - If R^2 is NA or < 0.95 -> "NA".
 *  - Else if at least one row has probit in (6,7): GSD = D60 / MMAD
 *  - Else: GSD = MMAD / D40
 * where D60/D40 are the cut-off diameters at probit 6 / 4 (via MMAD helper).
 */
import { linearFit } from "./regression.js";
import { calculateMMAD } from "./mmad.js";

const NA = "NA";

/**
 * @param {Object} opts
 * @param {Array}  opts.rows  mass-table rows with { logCutoff, probit }
 * @param {number} opts.mmad   MMAD value (diameter at probit 5)
 * @returns {{ gsd: number|string, n: number, slope: number, intercept: number, r2: number|string }}
 */
export function calculateGSD({ rows, mmad }) {
  const inRange = (r) =>
    r.probit !== null && isFinite(r.probit) && r.probit >= 4 && r.probit <= 6;
  const fitRows = rows.filter(inRange);

  const n = fitRows.length;

  if (n < 2) {
    return { gsd: NA, n, slope: NaN, intercept: NaN, r2: NA };
  }

  const fit = linearFit(
    fitRows.map((r) => r.logCutoff),
    fitRows.map((r) => r.probit),
  );

  const r2 = n === 2 ? 1 : fit.r2;

  if (r2 === NA || r2 < 0.95) {
    return { gsd: NA, n, slope: fit.slope, intercept: fit.intercept, r2 };
  }

  // R^2 is fine: decide direction based on whether any row has probit in (6,7).
  const hasUpper = rows.some((r) => r.probit > 6 && r.probit < 7);
  const d60 = calculateMMAD({ rows, probitTarget: 6 });
  const d40 = calculateMMAD({ rows, probitTarget: 4 });

  let gsd;
  if (hasUpper) {
    gsd = typeof d60 === "number" && mmad > 0 ? d60 / mmad : NA;
  } else {
    gsd = typeof d40 === "number" && d40 > 0 ? mmad / d40 : NA;
  }

  return { gsd, n, slope: fit.slope, intercept: fit.intercept, r2 };
}