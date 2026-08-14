import { describe, expect, it } from "vitest";
import { packetIndices, robustSolitonCDF } from "./soliton";
import { mulberry32 } from "./prng";

describe("prng", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it("stays in [0, 1)", () => {
    const rnd = mulberry32(999);
    for (let i = 0; i < 10_000; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("robust soliton CDF", () => {
  it("is monotonically non-decreasing and ends at 1", () => {
    for (const k of [1, 2, 3, 10, 100, 1000, 4096]) {
      const cdf = robustSolitonCDF(k);
      expect(cdf.length).toBe(k);
      for (let i = 1; i < k; i++) {
        expect(cdf[i]).toBeGreaterThanOrEqual(cdf[i - 1]);
      }
      expect(cdf[k - 1]).toBe(1);
    }
  });

  it("gives k=1 a guaranteed degree of 1", () => {
    const cdf = robustSolitonCDF(1);
    expect(cdf[0]).toBe(1);
  });

  it("produces mostly low degrees but some high ones", () => {
    const k = 1000;
    const cdf = robustSolitonCDF(k);
    let low = 0;
    let high = 0;
    for (let seed = 0; seed < 2000; seed++) {
      const degree = packetIndices(seed, k, cdf).length;
      if (degree <= 3) low++;
      if (degree > 10) high++;
    }
    // Soliton mass concentrates on degree 2 but keeps a heavy-ish tail —
    // both matter for the peeling decoder to keep making progress.
    expect(low).toBeGreaterThan(1000);
    expect(high).toBeGreaterThan(10);
  });
});

describe("packetIndices", () => {
  it("is deterministic per seed", () => {
    const cdf = robustSolitonCDF(500);
    for (let seed = 0; seed < 50; seed++) {
      expect(packetIndices(seed, 500, cdf)).toEqual(packetIndices(seed, 500, cdf));
    }
  });

  it("returns distinct in-range indices", () => {
    const k = 300;
    const cdf = robustSolitonCDF(k);
    for (let seed = 0; seed < 500; seed++) {
      const indices = packetIndices(seed, k, cdf);
      expect(indices.length).toBeGreaterThanOrEqual(1);
      expect(new Set(indices).size).toBe(indices.length);
      for (const idx of indices) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(k);
        expect(Number.isInteger(idx)).toBe(true);
      }
    }
  });

  it("covers every source block across many seeds", () => {
    const k = 100;
    const cdf = robustSolitonCDF(k);
    const covered = new Set<number>();
    for (let seed = 0; seed < 2000 && covered.size < k; seed++) {
      for (const idx of packetIndices(seed, k, cdf)) covered.add(idx);
    }
    expect(covered.size).toBe(k);
  });
});
