/**
 * Sample name normalization and dosage-form detection (Nebule vs MDI vs DPI).
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

// Every sample we recognize, in the order they appear on the result sheet
// (pre-measurement items first, stages, then the final filter).
const SAMPLE_ORDER = [
  "VOLUMETRIC",
  "SPACER",
  "CIHAZ",
  "NEBULIZATOR",
  "AGIZ",
  "BOGAZ",
  PRESEPARATOR,
  ...STAGE_ORDER,
  "FILTER",
];

/** Canonical -> allowed OCR spellings (canonical itself matches implicitly). */
const CANONICAL_TO_ALIASES = {
  VOLUMETRIC: ["VOLUMETRIK", "VOLUM", "VOL"],
  SPACER: ["SPACE"],
  CIHAZ: ["DEVICE"],
  NEBULIZATOR: ["NEBUL", "NEBULE", "NEBULIZATER"],
  AGIZ: ["MOUTH", "AĞIZ", "MOUTHPIECE"],
  BOGAZ: ["THROAT", "BOĞAZ"],
  PRESEPARATOR: ["PRESEPERATOR", "PRESEP", "PRESEP."],
  "STAGE 1": ["STAGE_1", "STAGE1", "STAGE-1", "STAGE 01", "STAGE-01"],
  "STAGE 2": ["STAGE_2", "STAGE2", "STAGE-2", "STAGE 02", "STAGE-02"],
  "STAGE 3": ["STAGE_3", "STAGE3", "STAGE-3", "STAGE 03", "STAGE-03"],
  "STAGE 4": ["STAGE_4", "STAGE4", "STAGE-4", "STAGE 04", "STAGE-04"],
  "STAGE 5": ["STAGE_5", "STAGE5", "STAGE-5", "STAGE 05", "STAGE-05"],
  "STAGE 6": ["STAGE_6", "STAGE6", "STAGE-6", "STAGE 06", "STAGE-06"],
  "STAGE 7": ["STAGE_7", "STAGE7", "STAGE-7", "STAGE 07", "STAGE-07"],
  "STAGE 8": ["STAGE_8", "STAGE8", "STAGE-8", "STAGE 08", "STAGE-08"],
  FILTER: ["FILTRE"],
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
 * Find which canonical sample (or one of its aliases) appears anywhere
 * inside `text` as a substring — the column it appears in does not matter.
 * Longest patterns are tried first so a longer name always wins over a
 * shorter alias of a different sample. Stages are matched as "STAGE <n>"
 * with n in 1..8 (the trailing (?!\d) keeps "STAGE 12" from matching
 * "STAGE 1"). Returns the canonical name, or null when nothing matches.
 */
function findSampleInText(text) {
  const c = clean(text);
  if (!c) return null;

  const stage = c.match(/STAGE\s*_?\s*0?\s*([1-8])(?!\d)/);
  if (stage) return `STAGE ${stage[1]}`;

  let best = null;
  let bestLen = 0;
  for (const [canon, aliases] of Object.entries(CANONICAL_TO_ALIASES)) {
    if (canon.startsWith("STAGE ")) continue;
    for (const a of [canon, ...aliases]) {
      const pat = clean(a);
      if (pat.length > bestLen && c.includes(pat)) {
        best = canon;
        bestLen = pat.length;
      }
    }
  }
  return best;
}

/**
 * Detect the dosage form of a batch:
 *   - NEBULIZATOR present -> "Nebule"
 *   - otherwise PRESEPARATOR present -> "DPI"
 *   - otherwise -> "MDI"
 * If any common sample (AGIZ, BOGAZ, stages) is missing, no form is
 * determined and the missing ones are reported instead.
 * Returns:
 *   { form: "Nebule" | "DPI" | "MDI" } | { form: null, missing: string[] }
 */
function detectDosageForm(samples) {
  const present = new Set(Object.keys(samples).map(normalizeSampleName));

  // Optional-pair conflicts: at most one of each pair may appear.
  const conflicts = OPTIONAL_PAIRS
    .filter(([a, b]) => present.has(a) && present.has(b))
    .map(([a, b]) => `${a} and ${b} cannot both be present`);

  // PRESEPARATOR absence itself is the marker for MDI, so it is not treated
  // as a missing common sample.
  const missingCommon = COMMON_SAMPLES.filter((s) => !present.has(normalizeSampleName(s)));

  if (missingCommon.length === 0) {
    let form;
    if (present.has("NEBULIZATOR")) form = "Nebule";
    else form = present.has(PRESEPARATOR) ? "DPI" : "MDI";
    return { form, conflicts };
  }
  return { form: null, missing: missingCommon, conflicts };
}

export {
  PRESEPARATOR,
  STAGE_ORDER,
  COMMON_SAMPLES,
  ALL_SAMPLES,
  SAMPLE_ORDER,
  CANONICAL_TO_ALIASES,
  clean,
  normalizeSampleName,
  findSampleInText,
  detectDosageForm,
  FLOW_RATE_OPTIONS,
  FLOW_RATE_DEFAULTS,
};

/** Fixed flow rate choices (L/min) per dosage form. */
const FLOW_RATE_OPTIONS = {
  MDI: [28.3, 30.0],
  DPI: [40.0, 60.0, 80.0, 100.0],
  Nebule: [15.0, 30.0],
};

/** Flow rate selected by default (L/min) per dosage form. */
const FLOW_RATE_DEFAULTS = {
  MDI: 28.3,
  DPI: 100.0,
  Nebule: 15.0,
};

// Optional sample pairs: at most one of each pair may be present, and their
// absence is acceptable (VOLUMETRIC/SPACER and CIHAZ/NEBULIZATOR are
// alternative device/spacer setups, never used together).
const OPTIONAL_PAIRS = [
  ["VOLUMETRIC", "SPACER"],
  ["CIHAZ", "NEBULIZATOR"],
];