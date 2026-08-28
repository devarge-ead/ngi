/**
 * Sample name normalization and dosage-form detection (MDI vs DPI).
 *
 * OCR results may spell the same sample differently (language, punctuation,
 * or OCR noise). Every recognized sample name is mapped to a canonical key
 * used throughout the calculations.
 */

const PRESEPARATOR = "PRESEPARATOR";

// Stages ordered from the finest (Stage 8 / MOC) down to Stage 1.
const STAGE_ORDER = [
  "STAGE 8",
  "STAGE 7",
  "STAGE 6",
  "STAGE 5",
  "STAGE 4",
  "STAGE 3",
  "STAGE 2",
  "STAGE 1",
];

// Samples present in both MDI and DPI (all except PRESEPARATOR).
const COMMON_SAMPLES = ["AGIZ", "BOGAZ", ...STAGE_ORDER];

// Full set required for a valid measurement (DPI includes PRESEPARATOR).
const ALL_SAMPLES = ["AGIZ", "BOGAZ", PRESEPARATOR, ...STAGE_ORDER];

/** Canonical -> allowed OCR spellings (canonical itself matches implicitly). */
const CANONICAL_TO_ALIASES = {
  AGIZ: ["MOUTH", "AĞIZ", "MOUTHPIECE"],
  BOGAZ: ["THROAT", "BOĞAZ"],
  PRESEPARATOR: ["PRESEPERATOR", "PRESEP", "PRESEP."],
  "STAGE 1": ["STAGE_1", "STAGE1", "STAGE 01"],
  "STAGE 2": ["STAGE_2", "STAGE2", "STAGE 02"],
  "STAGE 3": ["STAGE_3", "STAGE3", "STAGE 03"],
  "STAGE 4": ["STAGE_4", "STAGE4", "STAGE 04"],
  "STAGE 5": ["STAGE_5", "STAGE5", "STAGE 05"],
  "STAGE 6": ["STAGE_6", "STAGE6", "STAGE 06"],
  "STAGE 7": ["STAGE_7", "STAGE7", "STAGE 07"],
  "STAGE 8": ["STAGE_8", "STAGE8", "STAGE 08", "MOC"],
};

/** Collapse OCR noise (case, Turkish chars, separators, spaces). */
function clean(name) {
  return String(name)
    .toLocaleUpperCase("tr-TR")
    .replace(/[._\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Fold Turkish dotted/dotless distinctions onto ASCII letters.
    .replace(/İ/g, "I")
    .replace(/I/g, "I")
    .replace(/ı/g, "I")
    .replace(/Ğ/g, "G")
    .replace(/Ş/g, "S")
    .replace(/Ü/g, "U")
    .replace(/Ç/g, "C")
    .replace(/Ö/g, "O");
}

/**
 * Map a raw OCR sample name to its canonical key. Unknown names are returned
 * cleaned but unchanged (so they are not confused with the stages).
 */
function normalizeSampleName(name) {
  if (name === undefined || name === null) return "";
  const c = clean(name);
  if (c in CANONICAL_TO_ALIASES) return c;
  for (const [canon, aliases] of Object.entries(CANONICAL_TO_ALIASES)) {
    if (aliases.some((a) => clean(a) === c)) return canon;
  }
  return c;
}

/**
 * Detect whether a batch is DPI (PRESEPARATOR present), MDI (PRESEPARATOR
 * absent but every common sample present), or has missing results. Returns:
 *   { form: "DPI" } | { form: "MDI" } | { form: null, missing: string[] }
 */
function detectDosageForm(samples) {
  const present = new Set(Object.keys(samples).map(normalizeSampleName));

  // PRESEPARATOR absence itself is the marker for MDI, so it is not treated
  // as a missing common sample.
  const missingCommon = COMMON_SAMPLES.filter((s) => !present.has(normalizeSampleName(s)));

  if (missingCommon.length === 0) {
    return { form: present.has(PRESEPARATOR) ? "DPI" : "MDI" };
  }
  return { form: null, missing: missingCommon };
}

export {
  PRESEPARATOR,
  STAGE_ORDER,
  COMMON_SAMPLES,
  ALL_SAMPLES,
  CANONICAL_TO_ALIASES,
  clean,
  normalizeSampleName,
  detectDosageForm,
};