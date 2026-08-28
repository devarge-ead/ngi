/**
 * Smoke test for the table detection + batch grouping logic.
 * Uses synthetic OCR boxes laid out as a real printed analysis table,
 * WITHOUT any border lines (PaddleOCR only yields text boxes).
 * Run with: deno test public/js/tableParser.test.js
 */
import { detectTables, toNumber } from "./tableParser.js";
import { buildBatches } from "./batches.js";

function box(x, y, w, h, text) {
  return { x, y, w, h, text };
}

function makeRows() {
  // Two batches sharing one header: Batch A (B123) and Batch B (B456).
  // Layout: y=100 header, then 4 data rows with a header y-gap.
  return [
    box(20, 16, 70, 14, "Sample Name"),
    box(120, 16, 50, 14, "Sample ID"),
    box(220, 16, 40, 14, "Conc."),

    // Batch A
    box(20, 50, 70, 14, "A1"),
    box(120, 50, 50, 14, "B123"),
    box(220, 50, 40, 14, "98.4"),
    box(20, 74, 70, 14, "A2"),
    box(120, 74, 50, 14, "B123"),
    box(220, 74, 40, 14, "101.2"),
    box(20, 98, 70, 14, "A3"),
    box(120, 98, 50, 14, "B123"),
    box(220, 98, 40, 14, "99.7"),

    // Batch B
    box(20, 122, 70, 14, "C1"),
    box(120, 122, 50, 14, "X99"),
    box(220, 122, 40, 14, "48.2"),
    box(20, 146, 70, 14, "C2"),
    box(120, 146, 50, 14, "X99"),
    box(220, 146, 40, 14, "50.1"),
  ];
}

Deno.test("detectTables finds the header and groups rows", () => {
  const tables = detectTables(makeRows());
  if (tables.length !== 1) throw new Error(`Expected 1 table, got ${tables.length}`);
  const table = tables[0];
  if (table.rows.length !== 5) throw new Error(`Expected 5 rows, got ${table.rows.length}`);
  if (table.rows[0].id !== "B123" || table.rows[3].id !== "X99") {
    throw new Error(`Unexpected ids: ${JSON.stringify(table.rows)}`);
  }
  if (table.rows[0].conc !== 98.4) throw new Error("conc parse failed");
  console.log("detectTables OK:", JSON.stringify(table.rows));
});

Deno.test("buildBatches groups by Sample ID", () => {
  const tables = detectTables(makeRows());
  const { batches, order } = buildBatches(tables);
  if (order.length !== 2) throw new Error(`Expected 2 batches, got ${order.length}`);
  if (JSON.stringify(batches["B123"]) !== JSON.stringify(
    { A1: 98.4, A2: 101.2, A3: 99.7 },
  )) throw new Error("B123 wrong: " + JSON.stringify(batches["B123"]));
  if (JSON.stringify(batches["X99"]) !== JSON.stringify({ C1: 48.2, C2: 50.1 })) {
    throw new Error("X99 wrong: " + JSON.stringify(batches["X99"]));
  }
  console.log("buildBatches OK:", JSON.stringify(batches));
});

Deno.test("toNumber parsing", () => {
  const cases = [
    ["98.4", 98.4],
    ["101,2", 101.2],
    ["99,70", 99.7],
    ["> 0.50", 0.5],
    ["abc", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    const got = toNumber(input);
    if (got !== expected) throw new Error(`toNumber(${JSON.stringify(input)}) -> ${got}`);
  }
  console.log("toNumber OK");
});

// ---------------------------------------------------------------------------
// Regression: the real OCR layout from a printed inhaler analysis report.
// The header contains interstitial columns (Ret. Time, Area, plate count)
// between Sample ID and Conc., boxes overlap vertically across rows, and a
// footer ("Average"...) follows the data. Only Sample Name / Sample ID /
// Conc. from the data rows should survive, and Conc. must be clean.
// ---------------------------------------------------------------------------

function realLayout() {
  const b = (text, x, y, w, h) => ({ text, x, y, w, h });

  return [
    // Header row (centers ~102-116)
    b("Title", 256, 85, 77, 36),
    b("Sample Name", 551, 85, 213, 31),
    b("Sample ID", 828, 96, 163, 30),
    b("Ret. Time", 1013, 92, 156, 34),
    b("Area", 1230, 92, 85, 34),
    b("Tailing FactorTheoretical Plate#", 1360, 85, 451, 37),
    b("Conc.", 1845, 86, 98, 31),

    // Data row 1
    b("AN 24 7789 EMT 10.Icd", 94, 134, 399, 36),
    b("AGIZ", 614, 131, 92, 35),
    b("2404DU078", 822, 129, 185, 34),
    b("4.21", 1051, 127, 79, 36),
    b("57568", 1222, 126, 103, 35),
    b("1.37", 1464, 122, 79, 36),
    b("3192", 1629, 122, 89, 35),
    b("0.960", 1844, 122, 99, 36),

    // Data row 2
    b("AN 24 7789", 93, 171, 212, 36),
    b("EMT", 300, 171, 93, 31),
    b("11.Icd", 397, 170, 95, 34),
    b("BOGAZ", 597, 166, 129, 36),
    b("2404DU078", 822, 164, 185, 35),
    b("4.21", 1049, 159, 84, 41),
    b("35155", 1220, 161, 107, 35),
    b("1.34", 1463, 158, 82, 37),
    b("3160", 1626, 154, 93, 41),
    b("1.758", 1845, 154, 98, 36),

    // Wrapped data row: name/parts on one row, conc drifts to next line
    b("AN 24 7789", 94, 245, 211, 35),
    b("STAGE 1", 584, 243, 97, 35),
    b("2404DU078", 822, 237, 185, 35),
    b("4.22", 1049, 235, 85, 37),
    b("26069", 1222, 235, 103, 34),
    b("1.39", 1464, 229, 83, 38),
    b("3165", 1626, 229, 92, 36),
    b("0.435", 1844, 245, 98, 36),

    // Footer region: Average row (numeric cells only, labels far left)
    b("Average", 219, 320, 135, 31),
    b("4.21", 1051, 321, 85, 37),
    b("41398", 1224, 321, 104, 35),
    b("1.38", 1466, 321, 83, 37),
    b("3278", 1630, 321, 92, 36),
    b("1.171", 1844, 320, 99, 35),
  ];
}

Deno.test("detectTables extracts clean rows from real layout", () => {
  const tables = detectTables(realLayout());
  if (tables.length !== 1) throw new Error(`Expected 1 table, got ${tables.length}`);

  const rows = tables[0].rows;
  if (rows.length !== 3) {
    throw new Error(`Expected 3 data rows, got ${rows.length}: ${JSON.stringify(rows)}`);
  }
  // Row 1: name AGIZ, id 2404DU078, conc 0.960
  if (rows[0].name !== "AGIZ") throw new Error(`row0 name: ${rows[0].name}`);
  if (rows[0].id !== "2404DU078") throw new Error(`row0 id: ${rows[0].id}`);
  if (rows[0].conc !== 0.960) throw new Error(`row0 conc: ${rows[0].conc}`);

  // Row 2
  if (rows[1].name !== "BOGAZ") throw new Error(`row1 name: ${rows[1].name}`);
  if (rows[1].id !== "2404DU078") throw new Error(`row1 id: ${rows[1].id}`);
  if (rows[1].conc !== 1.758) throw new Error(`row1 conc: ${rows[1].conc}`);

  // Row 3 (wrapped: name/parts and conc recovered into one physical row)
  if (rows[2].name !== "STAGE 1") throw new Error(`row2 name: ${rows[2].name}`);
  if (rows[2].id !== "2404DU078") throw new Error(`row2 id: ${rows[2].id}`);
  if (rows[2].conc !== 0.435) throw new Error(`row2 conc: ${rows[2].conc}`);

  console.log("real layout OK:", JSON.stringify(rows));
});