/**
 * Tests for NGI calculations: cut-off, probit (and inverse), mass table.
 */
import {
  cutoffDiameter,
  probitFromCumPct,
  cumPctFromProbit,
  buildMassTable,
  deliveredDose,
} from "./calculations.js";

Deno.test("cutoffDiameter at flow=60 gives multiplier (q=1)", () => {
  // At 60 L/min, (60/60)=1, so q=1 and cut-off = multiplier.
  const cases = [
    [8, 0.34],
    [7, 0.55],
    [6, 0.94],
    [5, 1.66],
    [4, 2.82],
    [3, 4.46],
    [2, 8.06],
  ];
  for (const [stage, mult] of cases) {
    const got = cutoffDiameter(stage, 60);
    if (Math.abs(got - mult) > 1e-9) {
      throw new Error(`cutoff(stage ${stage}, 60) -> ${got}, expected ${mult}`);
    }
  }
  console.log("cutoff(60) OK");
});

Deno.test("cutoffDiameter stage 1 is null, invalid flow is null", () => {
  if (cutoffDiameter(1, 60) !== null) throw new Error("stage1 should be null");
  if (cutoffDiameter(8, 0) !== null) throw new Error("flow 0 should be null");
  if (cutoffDiameter(8, -5) !== null) throw new Error("negative flow should be null");
  console.log("cutoff edge OK");
});

Deno.test("probit <=> cumulative percentage round-trip", () => {
  for (const pct of [1, 5, 16, 50, 84, 95, 99]) {
    const probit = probitFromCumPct(pct);
    const back = cumPctFromProbit(probit);
    if (Math.abs(back - pct) > 0.05) {
      throw new Error(`round trip pct=${pct} -> probit=${probit.toFixed(4)} -> ${back.toFixed(4)}`);
    }
  }
  console.log("probit round-trip OK");
});

Deno.test("probit values at known percentiles", () => {
  // p=50 -> z=0 -> probit 5; p=84.13 -> z~1 -> probit~6.
  if (Math.abs(probitFromCumPct(50) - 5) > 1e-4) throw new Error("p50 probit != 5");
  if (Math.abs(probitFromCumPct(84.13) - 6) > 0.02) throw new Error("p84 probit != ~6");
  console.log("probit known OK");
});

Deno.test("buildMassTable accumulates and reaches 100% at Stage 1", () => {
  const samples = {
    AGIZ: 10,
    BOGAZ: 20,
    PRESEPARATOR: 30,
    "STAGE 8": 1,
    "STAGE 7": 2,
    "STAGE 6": 3,
    "STAGE 5": 4,
    "STAGE 4": 5,
    "STAGE 3": 6,
    "STAGE 2": 7,
    "STAGE 1": 8,
  };
  const rows = buildMassTable(samples, 60);
  if (rows.length !== 8) throw new Error("expected 8 rows");
  if (rows[0].stage !== "STAGE 8") throw new Error("row0 should be STAGE 8");
  if (rows[7].stage !== "STAGE 1") throw new Error("row7 should be STAGE 1");
  // Total mass = 1+2+3+4+5+6+7+8 = 36
  if (Math.abs(rows[7].cumMass - 36) > 1e-9) throw new Error(`cumMass at stage1 ${rows[7].cumMass}`);
  if (Math.abs(rows[7].cumPct - 100) > 1e-9) throw new Error(`cumPct stage1 ${rows[7].cumPct}`);
  if (rows[7].cutoff !== null) throw new Error("stage1 cutoff should be null");
  if (rows[0].logCutoff === null) throw new Error("stage8 logCutoff should be set");
  console.log("mass table OK:", JSON.stringify(rows.map((r) => r.stage)));
});

Deno.test("deliveredDose sums all sample concentrations", () => {
  const samples = { AGIZ: 1, BOGAZ: 2, OTHER: 3 };
  if (deliveredDose(samples) !== 6) throw new Error("delivered dose wrong");
  console.log("delivered dose OK");
});