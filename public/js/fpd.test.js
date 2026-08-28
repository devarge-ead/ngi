/**
 * Tests for Fine Particle Dose (FPD).
 */
import { calculateFPD } from "./fpd.js";

// row helper: log10(cutoff) + cumulative-mass-derived probit.
function row(logCutoff, probit, cumPct) {
  return { logCutoff, probit, cumPct, cutoff: Math.pow(10, logCutoff) };
}

// A monotonic dataset that should be valid (many cumPct>1 rows).
function makeRows() {
  return [
    row(-0.47, 2.5, 0.5),
    row(-0.2, 3.2, 4),
    row(0.2, 4.0, 16),
    row(0.5, 5.0, 50),
    row(0.8, 6.0, 84),
    row(1.1, 7.0, 97),
  ];
}

Deno.test("FPD returns a number above the pre-rule and computes %FPD", () => {
  const rows = makeRows();
  const res = calculateFPD({
    rows,
    threshold: 5,
    stage1Cum: 100,
    deliveredDose: 120,
  });
  if (typeof res.fpd !== "number") throw new Error("fpd not numeric: " + JSON.stringify(res));
  if (typeof res.fpdPct !== "number") throw new Error("fpdPct not numeric");
  // At threshold 5 μm (log10=0.699): bracketed rows ~0.5..0.8, probit near 6.
  if (res.fpd <= 0 || res.fpd > 100) throw new Error("fpd out of plausible range: " + res.fpd);
  if (res.fpdPct < 0) throw new Error("fpdPct negative");
  console.log("FPD OK:", JSON.stringify(res));
});

Deno.test("FPD returns LOD when pre-rule fails (<=2 rows cumPct>1)", () => {
  const rows = [
    row(0.2, 4, 3),
    row(0.5, 5, 8),
    row(0.8, 6, 12),
  ];
  // Only 2 rows have cumPct>1 (3 is counted once... actually 2 boundary: cumPct>1). rows 3,8,12 all >1 => 3 rows. Reduce to 2.
  const rows2 = [row(0.2, 4, 0.9), row(0.5, 5, 5), row(0.8, 6, 10)];
  const res = calculateFPD({ rows: rows2, threshold: 3, stage1Cum: 100, deliveredDose: 100 });
  if (res.fpd !== "LOD" || res.fpdPct !== "LOD") {
    throw new Error("expected LOD, got " + JSON.stringify(res));
  }
  console.log("FPD pre-rule LOD OK");
});

Deno.test("FPD returns LOD when the fitted cumulative percentage is <2", () => {
  // 4+ rows have cumPct>1 (passing the pre-rule), but the probit values used
  // in the fit are all low, so the interpolated cumulative % at a small
  // threshold stays below 2%.
  const rows = [
    row(-0.5, 2.1, 0.6),
    row(-0.2, 2.2, 1.5),
    row(0.1, 2.3, 3),
    row(0.4, 2.4, 6),
    row(1.0, 7.0, 90),
  ];
  const res = calculateFPD({ rows, threshold: 0.5, stage1Cum: 100, deliveredDose: 100 });
  if (res.fpd !== "LOD") throw new Error("expected LOD, got " + JSON.stringify(res));
  console.log("FPD <2% LOD OK");
});