/**
 * Pure helpers to normalize the raw ppu-paddle-ocr result into a flat list of
 * { text, x, y, w, h } detections. This module has NO heavyweight or network
 * dependency so it can be unit-tested in isolation (see ocr.test.js).
 */

/**
 * Normalize a raw box from the OCR engine into a { x, y, w, h }
 * axis-aligned rectangle (pixel coordinates). Accepts:
 *   - a Point-style object { x, y, width, height } (ppu-paddle-ocr Box)
 *   - a 4-corner point array [[x1,y1],[x2,y2],...]
 *   - a flat number array [x1, y1, x2, y2] or [x, y]
 */
export function coerceBounds(box) {
  if (!box) return null;

  let x;
  let y;
  let w;
  let h;

  if (typeof box === "object" && !Array.isArray(box)) {
    // ppu-paddle-ocr Box: { x, y, width, height }.
    if (
      typeof box.x === "number" &&
      typeof box.y === "number" &&
      (typeof box.width === "number" || typeof box.height === "number")
    ) {
      x = box.x;
      y = box.y;
      w = typeof box.width === "number" ? box.width : 0;
      h = typeof box.height === "number" ? box.height : 0;
      return { x, y, w, h };
    }
    if (Array.isArray(box.x) && Array.isArray(box.y)) {
      // Sometimes boxes come as { x: number[], y: number[] }.
      const xs = box.x;
      const ys = box.y;
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
    }
    return null;
  }

  if (!Array.isArray(box)) return null;

  let xs;
  let ys;

  if (typeof box[0] === "number") {
    // Flat array of numbers.
    if (box.length === 4) {
      // Assume [x1, y1, x2, y2].
      xs = [box[0], box[2]];
      ys = [box[1], box[3]];
    } else if (box.length === 2) {
      xs = [box[0], box[0]];
      ys = [box[1], box[1]];
    } else {
      return null;
    }
  } else {
    // Array of [x, y] points.
    const pts2 = box.filter(
      (p) => p && Array.isArray(p) && p.length >= 2 && typeof p[0] === "number",
    );
    if (pts2.length < 2) return null;
    xs = pts2.map((p) => p[0]);
    ys = pts2.map((p) => p[1]);
  }

  x = Math.min(...xs);
  y = Math.min(...ys);
  w = Math.max(...xs) - x;
  h = Math.max(...ys) - y;
  return { x, y, w, h };
}

function carryDetection(list, text, rawBox) {
  if (text === undefined || text === null) return;
  const box = coerceBounds(rawBox);
  const label = String(text).trim();
  if (label) {
    list.push({ text: label, ...(box || { x: 0, y: 0, w: 0, h: 0 }) });
  }
}

/**
 * Convert an arbitrary recognize() response into a normalized
 * array of { text, x, y, w, h } detections.
 *
 * Handles every shape returned by ppu-paddle-ocr@6:
 *   - PaddleOcrResult:          { text, lines: RecognitionResult[][], confidence }
 *   - FlattenedPaddleOcrResult: { text, results: RecognitionResult[], confidence }
 *   - DetectResult:             { boxes: Box[] }
 *   - a plain array of results
 *
 * RecognitionResult = { text, box: Box, confidence }, where Box = { x, y, width, height }.
 */
export function toDetections(result) {
  const dets = [];

  // ppu-paddle-ocr groups the recognized words by line.
  if (result && result.lines && Array.isArray(result.lines)) {
    for (const line of result.lines) {
      if (!Array.isArray(line)) continue;
      for (const item of line) {
        if (item && typeof item === "object") {
          carryDetection(dets, item.text, item.box);
        }
      }
    }
    return dets;
  }

  // Flattened result.
  if (result && Array.isArray(result.results)) {
    for (const item of result.results) {
      if (item && typeof item === "object") {
        carryDetection(dets, item.text, item.box);
      }
    }
    return dets;
  }

  // Detection-only result (no text labels available).
  if (result && Array.isArray(result.boxes)) {
    for (const box of result.boxes) {
      carryDetection(dets, box.text, box);
    }
    return dets;
  }

  // Plain array of boxed items.
  if (Array.isArray(result)) {
    for (const item of result) {
      if (item && typeof item === "object") {
        carryDetection(
          dets,
          item.text ?? item.texts ?? item.label,
          item.box ?? item.bbox ?? item.points ?? item.rect,
        );
      }
    }
    return dets;
  }

  return dets;
}