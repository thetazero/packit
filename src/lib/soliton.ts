import { mulberry32 } from "./prng";

/**
 * Robust soliton degree distribution for LT codes, returned as a CDF over
 * degrees 1..k (index d-1 holds P(degree <= d)).
 */
export function robustSolitonCDF(k: number, c = 0.03, delta = 0.5): Float64Array {
  const cdf = new Float64Array(k);
  if (k === 1) {
    cdf[0] = 1;
    return cdf;
  }
  const R = Math.max(1, c * Math.log(k / delta) * Math.sqrt(k));
  const pivot = Math.min(k, Math.max(1, Math.round(k / R)));
  let total = 0;
  const p = new Float64Array(k);
  for (let d = 1; d <= k; d++) {
    const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
    let tau = 0;
    if (d < pivot) tau = R / (d * k);
    else if (d === pivot) tau = (R * Math.log(R / delta)) / k;
    p[d - 1] = rho + Math.max(0, tau);
    total += p[d - 1];
  }
  let acc = 0;
  for (let d = 0; d < k; d++) {
    acc += p[d] / total;
    cdf[d] = acc;
  }
  cdf[k - 1] = 1; // guard against float drift
  return cdf;
}

function sampleDegree(cdf: Float64Array, u: number): number {
  // Binary search for the first index with cdf >= u.
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * The set of source-block indices a packet with the given seed XORs together.
 * Deterministic: sender and receiver call this with identical (seed, k, cdf).
 */
export function packetIndices(seed: number, k: number, cdf: Float64Array): number[] {
  const rnd = mulberry32(seed);
  const degree = sampleDegree(cdf, rnd());
  const chosen = new Set<number>();
  while (chosen.size < degree) {
    chosen.add(Math.floor(rnd() * k));
  }
  return [...chosen];
}
