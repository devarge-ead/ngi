/**
 * Shared linear-regression helper (ordinary least squares).
 * Used by the FPD / MMAD / GSD modules.
 */
export function linearFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN, n };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;

  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
    sumYY += y * y;
  }

  const meanX = sumX / n;
  const meanY = sumY / n;

  // Centered sums for numerical stability.
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  const slope = sxx === 0 ? NaN : sxy / sxx;
  const intercept = meanY - slope * meanX;

  let r2 = NaN;
  if (syy > 0 && sxx > 0) {
    r2 = (sxy * sxy) / (sxx * syy);
  }

  return { slope, intercept, r2, n };
}