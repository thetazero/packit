import { describe, expect, it } from "vitest";
import { mulberry32 } from "../lib/prng";
import { packetIndices, robustSolitonCDF } from "../lib/soliton";
import { CameraSim, SCENARIOS, type CameraParams } from "./camera";
import { baseline, degreeOneSeeds, solitonTuned, systematicFirst } from "./strategy";
import { makeTestFile, simulateTransfer } from "./simulate";

/** A physically perfect camera: what scan() sees is exactly the screen. */
const PERFECT: CameraParams = {
  ...SCENARIOS.steady,
  name: "perfect",
  camPx: 560,
  exposureMs: 1,
  readoutMs: 0,
  screenResponseMs: 0,
  shakePxPerSec: 0,
  maxTiltDeg: 0,
  defocusSigma: 0,
  focusHuntSigma: 0,
  focusHuntEnter: 0,
  noiseSigma: 0,
  contrast: 1,
};

function makeCam(params: CameraParams, rng: () => number = mulberry32(7)): {
  cam: CameraSim;
  texts: (frame: number) => string;
} {
  const strategy = baseline();
  const plan = strategy.plan({ data: makeTestFile(2048), rng: mulberry32(1) });
  const cam = new CameraSim(params, plan.frameText, strategy.fps, rng);
  return { cam, texts: plan.frameText };
}

describe("optical pipeline", () => {
  it("a clean capture decodes via jsQR to the exact displayed packet text", () => {
    const { cam, texts } = makeCam(PERFECT);
    // Mid-frame capture, no transition anywhere near the exposure window.
    const { text } = cam.scan(62);
    expect(text).toBe(texts(0));
  });

  it("an exposure straddling a frame change produces an undecodable ghost", () => {
    const ghosty = { ...PERFECT, name: "ghosty", exposureMs: 40 };
    const { cam, texts } = makeCam(ghosty);
    expect(texts(0)).not.toBe(texts(1));
    // Frame boundary at 125 ms (8 fps); window [105, 145] mixes both ~50/50.
    const { text } = cam.scan(145);
    expect(text).toBeNull();
  });

  it("heavy defocus makes the code unreadable", () => {
    const blurry = { ...PERFECT, name: "blurry", defocusSigma: 6 };
    const { cam } = makeCam(blurry);
    expect(cam.scan(62).text).toBeNull();
  });

  it("survives handheld-level camera tilt", () => {
    const tilted = { ...PERFECT, name: "tilted", maxTiltDeg: 6 };
    // rng ≈ 1 forces the tilt to its maximum.
    const { cam, texts } = makeCam(tilted, () => 0.999);
    expect(cam.scan(62).text).toBe(texts(0));
  });

  it("sensor noise and glare degrade but don't immediately kill decoding", () => {
    const noisy = { ...PERFECT, name: "noisy", noiseSigma: 3, contrast: 0.9 };
    const { cam, texts } = makeCam(noisy);
    expect(cam.scan(62).text).toBe(texts(0));
  });
});

describe("degree-one seed search", () => {
  it("finds a wire-valid degree-1 seed for every block", () => {
    const k = 40;
    const cdf = robustSolitonCDF(k);
    const seeds = degreeOneSeeds(k, cdf);
    expect(seeds).toHaveLength(k);
    seeds.forEach((seed, block) => {
      expect(packetIndices(seed, k, cdf)).toEqual([block]);
    });
  });
});

describe("simulateTransfer (lossless: pure coding overhead)", () => {
  const file = makeTestFile(16 * 1024);

  it("round-trips the file bit-exactly through the real codec", () => {
    const r = simulateTransfer(baseline(), SCENARIOS.lossless, file, 1);
    expect(r.ok).toBe(true);
    expect(r.k).toBe(64);
    expect(r.overhead).toBeGreaterThanOrEqual(1);
    expect(r.overhead).toBeLessThan(1.6); // typical LT reception overhead
  });

  it("systematic-first needs exactly k data packets", () => {
    const r = simulateTransfer(systematicFirst(), SCENARIOS.lossless, file, 1);
    expect(r.ok).toBe(true);
    expect(r.uniqueDataPackets).toBe(r.k);
    const base = simulateTransfer(baseline(), SCENARIOS.lossless, file, 1);
    expect(r.ms).toBeLessThanOrEqual(base.ms);
  });

  it("a re-tuned soliton distribution round-trips on both ends", () => {
    const r = simulateTransfer(solitonTuned(0.1, 0.05), SCENARIOS.lossless, file, 3);
    expect(r.ok).toBe(true);
  });
});

describe("simulateTransfer (through the camera)", () => {
  it("is deterministic for a fixed seed", () => {
    const file = makeTestFile(1024);
    const a = simulateTransfer(baseline(), SCENARIOS.steady, file, 123, { timeoutMs: 30_000 });
    const b = simulateTransfer(baseline(), SCENARIOS.steady, file, 123, { timeoutMs: 30_000 });
    expect(a).toEqual(b);
  });

  it("completes a transfer on the steady preset, bit-exact", () => {
    const file = makeTestFile(2048);
    const r = simulateTransfer(baseline(), SCENARIOS.steady, file, 5, { timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    expect(r.decodes).toBeGreaterThan(0);
  });

  it("completes a transfer handheld, with some scans failing", () => {
    const file = makeTestFile(2048);
    const r = simulateTransfer(baseline(), SCENARIOS.handheld, file, 5, { timeoutMs: 120_000 });
    expect(r.ok).toBe(true);
    expect(r.decodes).toBeLessThan(r.scans); // an imperfect camera drops frames
  });

  it("times out instead of hanging when the camera can never decode", () => {
    const dead: CameraParams = { ...PERFECT, name: "dead", camPx: 256, contrast: 0 };
    const file = makeTestFile(1024);
    const r = simulateTransfer(baseline(), dead, file, 1, { timeoutMs: 2_000 });
    expect(r.ok).toBe(false);
    expect(r.ms).toBe(2_000);
    expect(r.goodputBps).toBe(0);
    expect(r.decodes).toBe(0);
  });

  it("handles a file smaller than one block", () => {
    const tiny = makeTestFile(100);
    const r = simulateTransfer(baseline(), SCENARIOS.steady, tiny, 1, { timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    expect(r.k).toBe(1);
  });
});
