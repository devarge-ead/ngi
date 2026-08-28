/**
 * Fine Particle Dose (FPD) for a given particle-size threshold.
 *
 * Pre-rule: if the number of mass-table rows whose cumulative mass
 * percentage is > 1% is 2 or fewer, both FPD and %FPD are LOD.
 */
import { linearFit } from "./regression.js";
import { cumPctFromProbit } from "./calculations.js";

/**
 * @param {Object} opts
 * @param {Array}  opts.rows          mass-table rows with { logCutoff, probit, cumPct }
 * @param {number} opts.threshold     particle size threshold in μm (e.g. 1.5, 3.0, 5.0)
 * @param {number} opts.stage1Cum     cumulative mass at Stage 1 (total mass)
 * @param {number} opts.deliveredDose delivered dose (total)
 * @returns {{ fpd: number|string, fpdPct: number|string }}
 */
export function calculateFPD({ rows, threshold, stage1Cum, deliveredDose }) {
  // Pre-rule: too few points => LOD.
  const valid = rows.filter((r) => r.cumPct > 1);
  if (valid.length <= 2) {
    return { fpd: "LOD", fpdPct: "LOD" };
  }

  // Find the two consecutive rows bracketing the threshold on the
  // log10(Cut-off Diameter) axis.
  const usable = rows
    .filter((r) => r.logCutoff !== null && r.probit !== null && isFinite(r.logCutoff))
    .slice()
    .sort((a, b) => a.logCutoff - b.logCutoff);

  if (usable.length < 2) return { fpd: "LOD", fpdPct: "LOD" };

  const logThr = Math.log10(threshold);
  let low = null;
  let high = null;
  for (let i = 0; i < usable.length - 1; i++) {
    const a = usable[i];
    const b = usable[i + 1];
    if (logThr >= a.logCutoff && logThr <= b.logCutoff) {
      low = a;
      high = b;
      break;
    }
  }
  if (!low || !high || low === high) return { fpd: "LOD", fpdPct: "LOD" };

  // Fit x=log10(Cut-off), y=Probit on the two bracketing rows.
  const fit = linearFit([low.logCutoff, high.logCutoff], [low.probit, high.probit]);
  const probitAt = fit.slope * logThr + fit.intercept;
  const cumPct = cumPctFromProbit(probitAt);

  if (cumPct < 2) return { fpd: "LOD", fpdPct: "LOD" };

  const fpd = stage1Cum * (cumPct / 100);
  const fpdPct = deliveredDose > 0 ? (fpd / deliveredDose) * 100 : 0;
  return { fpd, fpdPct };
}