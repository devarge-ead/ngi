/**
 * Aggregate detected analysis tables into the batch structure used by the
 * UI. Each unique Sample ID becomes a batch whose keys are Sample Names and
 * whose values are concentrations.
 *
 * Result shape:
 *   { batches, order, duplicates }
 *     batches: { [sampleId]: { [sampleName]: concOrNull } }
 *     order: sample IDs in first-appearance order (tab order)
 *     duplicates: repeated Sample Name entries found while aggregating
 */
export function buildBatches(tables) {
  const batches = {};
  const order = [];
  const duplicates = [];

  for (const table of tables) {
    for (const row of table.rows) {
      if (!row.id) continue;
      if (!(row.id in batches)) {
        batches[row.id] = {};
        order.push(row.id);
      }
      if (row.name in batches[row.id]) {
        duplicates.push({ id: row.id, name: row.name });
      }
      batches[row.id][row.name] = row.conc;
    }
  }

  return { batches, order, duplicates };
}