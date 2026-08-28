/**
 * Tests for sample normalization and dosage-form detection.
 */
import {
  normalizeSampleName,
  detectDosageForm,
} from "./samples.js";

Deno.test("normalizeSampleName maps aliases to canonical keys", () => {
  const cases = [
    ["AGIZ", "AGIZ"],
    ["ağız", "AGIZ"],
    ["mouth", "AGIZ"],
    ["Mouthpiece", "AGIZ"],
    ["BOGAZ", "BOGAZ"],
    ["boğaz", "BOGAZ"],
    ["THROAT", "BOGAZ"],
    ["PRESEPERATOR", "PRESEPARATOR"],
    ["presep", "PRESEPARATOR"],
    ["presep.", "PRESEPARATOR"],
    ["stage_1", "STAGE 1"],
    ["stage1", "STAGE 1"],
    ["stage 8", "STAGE 8"],
    ["MOC", "STAGE 8"],
    ["unknown_test", "UNKNOWN TEST"], // unknown passes through cleaned
  ];
  for (const [input, expected] of cases) {
    const got = normalizeSampleName(input);
    if (got !== expected) {
      throw new Error(`normalize(${JSON.stringify(input)}) -> ${got}, expected ${expected}`);
    }
  }
  console.log("normalize OK");
});

function makeSamples(extra = {}) {
  return {
    AGIZ: 1,
    BOGAZ: 2,
    "STAGE 8": 3,
    "STAGE 7": 4,
    "STAGE 6": 5,
    "STAGE 5": 6,
    "STAGE 4": 7,
    "STAGE 3": 8,
    "STAGE 2": 9,
    "STAGE 1": 10,
    ...extra,
  };
}

Deno.test("detectDosageForm -> DPI when PRESEPARATOR present", () => {
  const r = detectDosageForm(makeSamples({ PRESEPARATOR: 11 }));
  if (r.form !== "DPI") throw new Error(`expected DPI, got ${JSON.stringify(r)}`);
  console.log("DPI OK");
});

Deno.test("detectDosageForm -> MDI when PRESEPARATOR absent, rest present", () => {
  const r = detectDosageForm(makeSamples());
  if (r.form !== "MDI") throw new Error(`expected MDI, got ${JSON.stringify(r)}`);
  console.log("MDI OK");
});

Deno.test("detectDosageForm -> missing when a non-PRESEP sample is absent", () => {
  const samples = makeSamples();
  delete samples["STAGE 3"];
  const r = detectDosageForm(samples);
  if (r.form !== null) throw new Error(`expected null form, got ${JSON.stringify(r)}`);
  if (!r.missing.includes("STAGE 3")) throw new Error(`missing should include STAGE 3: ${r.missing}`);
  console.log("missing OK:", JSON.stringify(r));
});