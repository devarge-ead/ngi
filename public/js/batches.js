/**
 * Build the single analysis batch from the topmost detected table. The
 * sample is matched inside the row's full text (any column may carry it);
 * the value comes from the Conc. column (already parsed by tableParser).
 *
 * Result shape:
 *   { samples, duplicates }
 *     samples: { [canonicalSampleName]: concOrNull }
 *     duplicates: canonical sample names seen in more than one row
 */
import { findSampleInText } from "./samples.js";

export function buildBatches(tables) {
  const samples = {};
  const duplicates = [];
  const table = Array.isArray(tables) ? tables[0] : null;
  if (!table) return { samples, duplicates };

  for (const row of table.rows) {
    const canon = findSampleInText(row.name);
    if (!canon) continue;
    if (canon in samples) duplicates.push(canon);
    samples[canon] = row.conc;
  }

  return { samples, duplicates };
}