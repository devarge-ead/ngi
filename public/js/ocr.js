/**
 * OCR service wrapper around ppu-paddle-ocr/web.
 * The service setup follows the reference snippet exactly.
 *
 * The heavy package is imported dynamically (only when getService() runs) so
 * that the pure parsing helpers in ./ocr-parse.js stay free of any network or
 * native dependency and can be unit-tested without loading the OCR SDK.
 */
import { toDetections } from "./ocr-parse.js";

const BASE = new URL("models/", document.baseURI).href;

let servicePromise = null;

/**
 * Lazily create and initialize the OCR service exactly once.
 * Model files are served from /models by the Deno static server, or from the
 * `models/` directory on GitHub Pages. BASE is resolved relative to the page
 * so it works whether the site is hosted at the domain root or a sub-path.
 */
export function getService() {
  if (!servicePromise) {
    servicePromise = (async () => {
      const { PaddleOcrService } = await import("ppu-paddle-ocr/web");
      const service = new PaddleOcrService({
        model: {
          detection: `${BASE}/PP-OCRv6_tiny_det.onnx`,
          recognition: `${BASE}/PP-OCRv6_tiny_rec.onnx`,
          charactersDictionary: `${BASE}/ppocrv6_tiny_dict.txt`,
        },
      });
      await service.initialize();
      return service;
    })();
  }
  return servicePromise;
}

/**
 * Run OCR on a canvas and return the full result plus normalized detections.
 */
export async function runOcr(canvas) {
  const service = await getService();
  const result = await service.recognize(canvas);
  return { result, detections: toDetections(result) };
}

// Re-export the pure parsing helpers for convenience.
export { coerceBounds, toDetections } from "./ocr-parse.js";