/**
 * Tests for MMAD / general cut-off-at-probit.
 */
import { calculateMMAD } from "./mmad.js";

function row(logCutoff, probit) {
  return { logCutoff, probit };
}

// Increasing probit rows with decreasing diameter (fine -> coarse).
function makeRows() {
  return [
    row(-0.5, 2),   // log(0.316)
    row(-0.2, 3),   // log(0.63)
    row(0.2, 4),    // log(1.58)
    row(0.5, 5),    // log(3.16) ~ MMAD
    row(0.8, 6),    // log(6.3)
    row(1.1, 7),    // log(12.6)
  ];
}

Deno.test("MMAD at probit 5 lands near the expected diameter", () => {
  const rows = makeRows();
  const mmad = calculateMMAD({ rows, probitTarget: 5 });
  if (typeof mmad !== "number") throw new Error("MMAD not numeric: " + mmad);
  if (Math.abs(mmad - 3.16) > 1.1) throw new Error("MMAD ~ " + mmad + ", expected ~3.16");
  console.log("MMAD OK:", mmad.toFixed(3));
});

Deno.test("MMAD returns LOD when target probit is below the measured range", () => {
  // Lowest probit in the rows is 3; targeting probit 1 extrapolates below the
  // smallest cut-off (Stage 8), so the result must be LOD.
  const rows = [row(0.0, 3), row(0.3, 4), row(0.6, 5)];
  const res = calculateMMAD({ rows, probitTarget: 1 });
  if (res !== "LOD") throw new Error("expected LOD, got " + res);
  console.log("MMAD LOD OK");
});

Deno.test("MMAD diameter increases with higher probit (coarser)", () => {
  const rows = makeRows();
  const t6 = calculateMMAD({ rows, probitTarget: 6 });
  const t4 = calculateMMAD({ rows, probitTarget: 4 });
  if (typeof t6 !== "number" || typeof t4 !== "number") {
    throw new Error("t6/t4 expected numeric: " + t6 + ", " + t4);
  }
  if (t6 <= t4) throw new Error("diameter should increase with probit: t6=" + t6 + " t4=" + t4);
  console.log("MMAD t4/t6 OK:", t4.toFixed(3), t6.toFixed(3));
});