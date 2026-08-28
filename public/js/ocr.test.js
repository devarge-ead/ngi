/**
 * Unit tests for the OCR result normalizer, using the exact shapes the
 * ppu-paddle-ocr@6 recognize() returns. These do NOT import the heavy OCR
 * package; they only exercise coerceBounds/toDetections.
 * Run with: deno task test
 */
import { coerceBounds, toDetections } from "./ocr-parse.js";

// ppu-paddle-ocr RecognitionResult = { text, box: {x,y,width,height}, confidence }
function item(text, x, y, width, height) {
  return { text, box: { x, y, width, height }, confidence: 0.98 };
}

// Default (non-flattened) result: lines grouped by text line.
const groupedResult = {
  text: "Sample Name Sample ID Conc.\nA1 B123 98.4\nA2 B123 101.2",
  confidence: 0.97,
  lines: [
    [
      item("Sample Name", 20, 16, 70, 14),
      item("Sample ID", 120, 16, 50, 14),
      item("Conc.", 220, 16, 40, 14),
    ],
    [
      item("A1", 20, 50, 30, 14),
      item("B123", 120, 50, 46, 14),
      item("98.4", 222, 50, 36, 14),
    ],
  ],
};

// Flat (flatten: true) result.
const flatResult = {
  text: "Sample Name Sample ID Conc.",
  confidence: 0.96,
  results: [
    item("Sample Name", 20, 16, 70, 14),
    item("Sample ID", 120, 16, 50, 14),
    item("Conc.", 220, 16, 40, 14),
  ],
};

Deno.test("coerceBounds handles ppu-paddle-ocr Box object", () => {
  const b = coerceBounds({ x: 123, y: 45, width: 70, height: 14 });
  if (JSON.stringify(b) !== JSON.stringify({ x: 123, y: 45, w: 70, h: 14 })) {
    throw new Error("Box object coercion failed: " + JSON.stringify(b));
  }
  console.log("coerceBounds Box OK");
});

Deno.test("coerceBounds still handles flat arrays", () => {
  const b1 = coerceBounds([10, 20, 30, 40]);
  const b2 = coerceBounds([100, 200]);
  if (b1.x !== 10 || b1.y !== 20 || b1.w !== 20 || b1.h !== 20) {
    throw new Error("flat 4-array failed: " + JSON.stringify(b1));
  }
  if (b2.x !== 100 || b2.y !== 200 || b2.w !== 0 || b2.h !== 0) {
    throw new Error("flat 2-array failed: " + JSON.stringify(b2));
  }
  console.log("coerceBounds flat arrays OK");
});

Deno.test("toDetections flattens grouped (lines) result", () => {
  const dets = toDetections(groupedResult);
  if (dets.length !== 6) throw new Error(`Expected 6 detections, got ${dets.length}`);
  if (dets[0].text !== "Sample Name" || dets[0].w !== 70) {
    throw new Error("first detection wrong: " + JSON.stringify(dets[0]));
  }
  if (dets[4].x !== 120 || dets[4].text !== "B123") {
    throw new Error("row-2 id wrong: " + JSON.stringify(dets[4]));
  }
  console.log("toDetections grouped OK:", JSON.stringify(dets.map((d) => d.text)));
});

Deno.test("toDetections handles flat (results) result", () => {
  const dets = toDetections(flatResult);
  if (dets.length !== 3) throw new Error(`Expected 3, got ${dets.length}`);
  if (dets[2].text !== "Conc.") throw new Error("flat last wrong");
  console.log("toDetections flat OK");
});

Deno.test("empty/no-detect result yields empty array (no throw)", () => {
  const none = { text: "", confidence: 0, lines: [] };
  if (toDetections(none).length !== 0) throw new Error("empty result not empty");
  console.log("empty result OK");
});