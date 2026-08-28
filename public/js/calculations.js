/**
 * NGI (Next Generation Impactor) calculations for inhaler testing.
 * All formulas follow the specification provided by the user.
 */
import { STAGE_ORDER } from "./samples.js";

/**
 * Stage parameters used to derive the cut-off diameter from the flow rate.
 * Stage 1 has no parameters: its cut-off diameter is not computed.
 * keyed by stage number (2..8).
 */
const STAGE_PARAMS = {
  8: { x: 0.67, multiplier: 0.34 },
  7: { x: 0.6, multiplier: 0.55 },
  6: { x: 0.53, multiplier: 0.94 },
  5: { x: 0.47, multiplier: 1.66 },
  4: { x: 0.5, multiplier: 2.82 },
  3: { x: 0.52, multiplier: 4.46 },
  2: { x: 0.54, multiplier: 8.06 },
};

/**
 * Cut-off diameter for a stage in μm:
 *   q = (60 / FLOW_RATE) ^ x
 *   cut-off = q * multiplier
 * Returns null for Stage 1 (no formula).
 */
export function cutoffDiameter(stage, flowRate) {
  const stageNum = Number(String(stage).replace(/\D/g, "")) || NaN;
  if (stageNum === 1) return null;
  const p = STAGE_PARAMS[stageNum];
  if (!p || !(flowRate > 0)) return null;
  const q = Math.pow(60 / flowRate, p.x);
  return q * p.multiplier;
}

/**
 * Standard-normal CDF (Φ) via the Abramowitz-Stegun 26.2.17 approximation.
 * Returns P(Z <= z) in [0, 1].
 */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327; // 1/sqrt(2*pi)
  const poly =
    t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const phi = d * Math.exp(-0.5 * z * z);
  return z >= 0 ? 1 - phi * poly : phi * poly;
}

/**
 * Inverse standard-normal CDF (NORM.S.INV) via Peter Acklam's rational
 * approximation. Returns the z-score for a probability in (0,1).
 */
function normSInv(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;

  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  let x;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  // One Newton-Raphson refinement step for accuracy.
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x * 0.5);
  return x - u;
}

/**
 * Probit for a cumulative mass percentage:
 *   NORM.S.INV(CUMULATIVE_MASS_PERCENTAGE / 100) + 5
 */
export function probitFromCumPct(cumPct) {
  return normSInv(cumPct / 100) + 5;
}

/**
 * Inverse: cumulative mass percentage from a probit value.
 *   percentage = NORM.S.DIST(probit - 5) * 100
 */
export function cumPctFromProbit(probit) {
  return normCdf(probit - 5) * 100;
}

/**
 * Mass table (Stage 8 -> Stage 1). Each entry:
 *   { stage, mass, cumMass, cumPct, cutoff, logCutoff, probit }
 * mass comes straight from OCR concentrations. cumMass accumulates from
 * Stage 8 down to Stage 1 (Stage 1 -> total). cumPct = cumMass/total*100.
 */
export function buildMassTable(samplesByCanonical, flowRate) {
  const total = STAGE_ORDER.reduce(
    (acc, s) => acc + (typeof samplesByCanonical[s] === "number" ? samplesByCanonical[s] : 0),
    0,
  );

  let cum = 0;
  return STAGE_ORDER.map((stage) => {
    const mass =
      typeof samplesByCanonical[stage] === "number" ? samplesByCanonical[stage] : 0;
    cum += mass;
    const cutoff = cutoffDiameter(stage, flowRate);
    const cumPct = total > 0 ? (cum / total) * 100 : 0;
    return {
      stage,
      mass,
      cumMass: cum,
      cumPct,
      cutoff,
      logCutoff: cutoff !== null ? Math.log10(cutoff) : null,
      probit: probitFromCumPct(cumPct),
    };
  });
}

/** Delivered Dose = sum of all sample concentrations. */
export function deliveredDose(samplesByCanonical) {
  return Object.keys(samplesByCanonical).reduce(
    (acc, k) => acc + (typeof samplesByCanonical[k] === "number" ? samplesByCanonical[k] : 0),
    0,
  );
}

export { STAGE_PARAMS, normCdf, normSInv };