/**
 * Mass Median Aerodynamic Diameter (MMAD) and, more generally, the cut-off
 * diameter at an arbitrary probit target (e.g. probit 4 or 6 for GSD).
 *
 * The probit target is converted to a cumulative mass percentage, the two
 * mass-table rows bracketing that percentage are fitted (x=Probit,
 * y=log10(Cut-off Diameter)), and the diameter is recovered as 10^y.
 */
import { linearFit } from "./regression.js";
import { cumPctFromProbit } from "./calculations.js";

/**
 * @param {Object} opts
 * @param {Array}  opts.rows         mass-table rows with { logCutoff, probit }
 * @param {number} [opts.probitTarget=5] the probit at which to read the diameter
 * @returns {number|"LOD"|"NA"} diameter in μm, LOD if below smallest stage,
 *                              "NA" if it cannot be computed.
 */
export function calculateMMAD({ rows, probitTarget = 5 }) {
  const usable = rows
    .filter(
      (r) =>
        r.logCutoff !== null &&
        r.probit !== null &&
        isFinite(r.logCutoff) &&
        isFinite(r.probit),
    )
    .slice()
    .sort((a, b) => a.probit - b.probit);

  if (usable.length < 2) return "NA";

  const targetCumPct = cumPctFromProbit(probitTarget);

  // Find two consecutive rows whose probit brackets the target probit.
  let low = null;
  let high = null;
  for (let i = 0; i < usable.length - 1; i++) {
    const a = usable[i];
    const b = usable[i + 1];
    if (probitTarget >= a.probit && probitTarget <= b.probit) {
      low = a;
      high = b;
      break;
    }
  }
  if (!low || !high || low === high) {
    // Target outside the measured range.
    if (probitTarget <= usable[0].probit) {
      low = usable[0];
      high = usable[1];
    } else {
      low = usable[usable.length - 2];
      high = usable[usable.length - 1];
    }
  }

  // Fit x=Probit, y=log10(Cut-off).
  const fit = linearFit([low.probit, high.probit], [low.logCutoff, high.logCutoff]);
  const logCd = fit.slope * probitTarget + fit.intercept;
  const diam = Math.pow(10, logCd);

  // Below the smallest measured cut-off diameter (Stage 8) => LOD.
  const minCutoff = Math.min(...usable.map((r) => Math.pow(10, r.logCutoff)));
  if (diam < minCutoff) return "LOD";

  return diam;
}