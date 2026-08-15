import { describe, expect, it } from "vitest";
import { CameraSim, SCENARIOS, type CameraParams } from "./camera";
import { coreBuilt, loadCore, type Core } from "./core";
import { mulberry32 } from "./prng";
import { makeTestFile, simulateTransfer } from "./simulate";

const built = coreBuilt();
const core: Core | null = built ? await loadCore() : null;

/** A physically perfect camera: what snap() sees is exactly the screen. */
const PERFECT: CameraParams = {
  ...SCENARIOS.steady,
  name: "perfect",
  camPx: 1152,
  frameFraction: 0.85,
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

/** Cheaper-than-preset camera for the transfer tests: near-clean optics at a
 * modest sensor size (still above the decoder's ~820px span floor). */
const BENCH: CameraParams = {
  ...PERFECT,
  name: "bench",
  camPx: 1000,
  frameFraction: 0.88,
  scanIntervalMs: 80,
  scanJitter: 0.2,
  exposureMs: 4,
  readoutMs: 4,
  screenResponseMs: 4,
  shakePxPerSec: 25,
  maxTiltDeg: 2,
  defocusSigma: 0.4,
  noiseSigma: 3,
  contrast: 0.9,
};

function makeCam(c: Core, params: CameraParams, rng: () => number = mulberry32(7)): CameraSim {
  const sender = new c.TileSender(makeTestFile(2048), "sim.bin", "application/octet-stream");
  const frames: Uint8Array[] = [];
  const frameRgba = (frame: number): Uint8Array => {
    while (frames.length <= frame) frames.push(new Uint8Array(sender.next_frame()));
    return frames[frame];
  };
  return new CameraSim(params, frameRgba, 8, rng);
}

function recognized(c: Core, rgba: Uint8Array, w: number, h: number): boolean {
  const receiver = new c.TileReceiver();
  try {
    return (JSON.parse(receiver.push_frame(rgba, w, h)) as { recognized: boolean }).recognized;
  } finally {
    receiver.free();
  }
}

describe.skipIf(!built)("optical pipeline", () => {
  it("a clean capture is recognized by the production decoder", () => {
    const cam = makeCam(core!, PERFECT);
    // Mid-frame capture, no transition anywhere near the exposure window.
    const { rgba, capture } = cam.snap(62);
    expect(recognized(core!, rgba, capture.width, capture.height)).toBe(true);
  });

  it("an exposure straddling a frame change produces an undecodable ghost", () => {
    const cam = makeCam(core!, { ...PERFECT, name: "ghosty", exposureMs: 40 });
    // Frame boundary at 125 ms (8 fps); window [105, 145] mixes both ~50/50.
    const { rgba, capture } = cam.snap(145);
    expect(recognized(core!, rgba, capture.width, capture.height)).toBe(false);
  });

  it("heavy defocus makes the frame unreadable", () => {
    const cam = makeCam(core!, { ...PERFECT, name: "blurry", defocusSigma: 6 });
    const { rgba, capture } = cam.snap(62);
    expect(recognized(core!, rgba, capture.width, capture.height)).toBe(false);
  });

  it("survives handheld-level camera tilt", () => {
    // rng ≈ 1 forces the tilt to its maximum.
    const cam = makeCam(core!, { ...PERFECT, name: "tilted", maxTiltDeg: 6 }, () => 0.999);
    const { rgba, capture } = cam.snap(62);
    expect(recognized(core!, rgba, capture.width, capture.height)).toBe(true);
  });

  it("sensor noise and glare degrade but don't immediately kill decoding", () => {
    const cam = makeCam(core!, { ...PERFECT, name: "noisy", noiseSigma: 4, contrast: 0.85 });
    const { rgba, capture } = cam.snap(62);
    expect(recognized(core!, rgba, capture.width, capture.height)).toBe(true);
  });
});

describe.skipIf(!built)("simulateTransfer (lossless: pure coding overhead)", () => {
  it("round-trips the file bit-exactly through the shipped codec", () => {
    const file = makeTestFile(64 * 1024);
    const r = simulateTransfer(core!, { name: "8fps", fps: 8 }, SCENARIOS.lossless, file, 1);
    expect(r.ok).toBe(true);
    expect(r.needed).toBe(7); // ceil(65536 / symbol size)
    expect(r.overhead).toBeGreaterThanOrEqual(1);
    expect(r.overhead).toBeLessThan(1.3); // RaptorQ needs barely more than k
  });
});

describe.skipIf(!built)("simulateTransfer (through the camera)", () => {
  it("is deterministic for a fixed seed", () => {
    const file = makeTestFile(2048);
    const a = simulateTransfer(core!, { name: "8fps", fps: 8 }, BENCH, file, 123, { timeoutMs: 30_000 });
    const b = simulateTransfer(core!, { name: "8fps", fps: 8 }, BENCH, file, 123, { timeoutMs: 30_000 });
    expect(a).toEqual(b);
  });

  it("completes a transfer on near-clean optics, bit-exact", () => {
    const file = makeTestFile(2048);
    const r = simulateTransfer(core!, { name: "8fps", fps: 8 }, BENCH, file, 5, { timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    expect(r.recognized).toBeGreaterThan(0);
  });

  it("completes a transfer handheld, with some scans failing", () => {
    const file = makeTestFile(2048);
    const r = simulateTransfer(core!, { name: "8fps", fps: 8 }, SCENARIOS.handheld, file, 5, {
      timeoutMs: 120_000,
    });
    expect(r.ok).toBe(true);
    expect(r.recognized).toBeLessThan(r.scans); // an imperfect camera drops frames
  });

  it("times out instead of hanging when the camera can never decode", () => {
    const dead: CameraParams = { ...BENCH, name: "dead", contrast: 0 };
    const file = makeTestFile(1024);
    const r = simulateTransfer(core!, { name: "8fps", fps: 8 }, dead, file, 1, { timeoutMs: 2_000 });
    expect(r.ok).toBe(false);
    expect(r.ms).toBe(2_000);
    expect(r.goodputBps).toBe(0);
    expect(r.recognized).toBe(0);
  });

  it("handles a tiny file", () => {
    const tiny = makeTestFile(100);
    const r = simulateTransfer(core!, { name: "8fps", fps: 8 }, BENCH, tiny, 1, { timeoutMs: 60_000 });
    expect(r.ok).toBe(true);
    expect(r.needed).toBe(1);
  });
});

if (!built) {
  it("wasm pkg not built — run `npm run build:wasm` to enable the simulator tests", () => {
    expect(built).toBe(false);
  });
}
