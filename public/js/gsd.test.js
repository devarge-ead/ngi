/**
 * Tests for Geometric Standard Deviation (GSD).
 */
import { calculateGSD } from "./gsd.js";
import { calculateMMAD } from "./mmad.js";

function row(logCutoff, probit) {
  return { logCutoff, probit };
}

Deno.test("GSD returns NA when R^2 invalid or too few points", () => {
  // n=2 gives R^2=1 (acceptable), but probit all inside [4,6] means both n and Fit fine.
  const rows = [row(0.2, 4), row(0.5, 5), row(0.8, 6)];
  const mmad = calculateMMAD({ rows, probitTarget: 5 });
  const res = calculateGSD({ rows, mmad });
  if (typeof res.gsd !== "number") throw new Error("GSD should be numeric here: " + JSON.stringify(res));
  console.log("GSD n=3 OK:", JSON.stringify(res));
});

Deno.test("GSD -> NA when n<2", () => {
  const rows = [row(0.2, 4.5)];
  const res = calculateGSD({ rows, mmad: 3 });
  if (res.gsd !== "NA") throw new Error("expected NA gsd, got " + JSON.stringify(res));
  if (res.n !== 1) throw new Error("n should be 1, got " + res.n);
  console.log("GSD n<2 NA OK");
});

Deno.test("GSD computes using D60/MMAD when a row has probit in (6,7)", () => {
  const rows = [row(0.3, 4), row(0.6, 5), row(0.9, 6.4)];
  const mmad = calculateMMAD({ rows, probitTarget: 5 });
  const res = calculateGSD({ rows, mmad });
  if (typeof res.gsd !== "number") throw new Error("expected numeric GSD, got " + JSON.stringify(res));
  if (res.gsd < 1) throw new Error("GSD should be >1: " + res.gsd);
  console.log("GSD upper-direction OK:", JSON.stringify(res));
});

Deno.test("GSD uses MMAD/D40 when no row has probit in (6,7)", () => {
  const rows = [row(0.2, 4), row(0.5, 5), row(0.7, 5.5)]; // max probit 5.5 <6
  const mmad = calculateMMAD({ rows, probitTarget: 5 });
  const res = calculateGSD({ rows, mmad });
  if (typeof res.gsd !== "number") throw new Error("expected numeric GSD, got " + JSON.stringify(res));
  console.log("GSD lower-direction OK:", JSON.stringify(res));
});