import { LTDecoder } from "../lib/lt";
import { parsePacket } from "../lib/packet";
import { mulberry32 } from "../lib/prng";
import { CameraSim, type CameraParams, type Capture } from "./camera";
import type { Strategy } from "./strategy";

/**
 * Simulates one transfer end to end: the strategy drives the display, the
 * camera model synthesizes what the sensor sees at each scan instant, jsQR
 * decides whether that image is readable, and the production parse + LT
 * decoder consume whatever gets through — the receiver's exact code path with
 * synthetic pixels in place of a webcam.
 */
export interface TrialResult {
  /** Completed before timeout and the reassembled bytes match the input. */
  ok: boolean;
  /** Wall-clock ms from first displayed frame to decode+meta complete. */
  ms: number;
  /** File bytes per second of wall-clock time (0 if not completed). */
  goodputBps: number;
  /** Camera scan attempts, and how many produced a decoded QR. */
  scans: number;
  decodes: number;
  /** Successful decodes of an already-seen data packet (camera re-reads). */
  duplicates: number;
  /** Unique data packets the decoder consumed before finishing. */
  uniqueDataPackets: number;
  /** uniqueDataPackets / k — the fountain-code reception overhead. */
  overhead: number;
  k: number;
}

export interface SimulateOptions {
  timeoutMs?: number;
  /** Called with every synthesized capture — for dumping frames to disk. */
  onCapture?: (capture: Capture, tMs: number, decoded: boolean) => void;
}

export function simulateTransfer(
  strategy: Strategy,
  camera: CameraParams,
  data: Uint8Array,
  seed: number,
  opts: SimulateOptions = {},
): TrialResult {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const rng = mulberry32(seed >>> 0);
  const plan = strategy.plan({ data, rng });
  const frameMs = 1000 / strategy.fps;

  let decoder: LTDecoder | null = null;
  let metaSeen = false;
  let assembled: Uint8Array | null = null;
  let scans = 0;
  let decodes = 0;
  let doneAt = -1;

  const handleText = (text: string): void => {
    const packet = parsePacket(text);
    if (!packet) return; // decoder returned garbage (e.g. misread) — real receivers drop it too
    decodes++;
    if (!decoder) {
      decoder = new LTDecoder(packet.k, packet.blockSize, packet.fileSize, strategy.cdf?.(packet.k));
    }
    if (packet.type === "meta") metaSeen = true;
    else decoder.addPacket(packet.seed, packet.payload);
    if (decoder.done && metaSeen && assembled === null) assembled = decoder.assemble();
  };

  if (camera.lossless) {
    const maxFrames = Math.ceil(timeoutMs / frameMs);
    for (let frame = 0; frame < maxFrames && doneAt < 0; frame++) {
      scans++;
      handleText(plan.frameText(frame));
      if (assembled) doneAt = (frame + 1) * frameMs;
    }
  } else {
    const cam = new CameraSim(camera, plan.frameText, strategy.fps, rng);
    let t = 0;
    while (t < timeoutMs && doneAt < 0) {
      t += camera.scanIntervalMs * (1 + camera.scanJitter * (2 * rng() - 1));
      scans++;
      const { text, capture } = cam.scan(t);
      opts.onCapture?.(capture, t, text !== null);
      if (text !== null) handleText(text);
      if (assembled) doneAt = t;
    }
  }

  // TS can't see the closure assignments above, so re-widen the types here.
  const d = decoder as LTDecoder | null;
  const out = assembled as Uint8Array | null;
  const ok = out !== null && bytesEqual(out, data);
  const ms = doneAt >= 0 ? doneAt : timeoutMs;
  return {
    ok,
    ms,
    goodputBps: ok ? data.length / (ms / 1000) : 0,
    scans,
    decodes,
    duplicates: d?.duplicates ?? 0,
    uniqueDataPackets: d?.packetsUsed ?? 0,
    overhead: d ? d.packetsUsed / d.k : 0,
    k: plan.k,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface TrialSummary {
  strategy: string;
  camera: string;
  trials: number;
  completionRate: number;
  medianMs: number;
  p10Ms: number;
  p90Ms: number;
  medianGoodputBps: number;
  meanOverhead: number;
  /** Fraction of scan attempts that produced a decoded QR. */
  scanSuccessRate: number;
}

/** Run n independent trials (fresh PRNG stream each) and aggregate. */
export function runTrials(
  strategy: Strategy,
  camera: CameraParams,
  data: Uint8Array,
  trials: number,
  baseSeed = 1,
  timeoutMs?: number,
): TrialSummary {
  const results: TrialResult[] = [];
  for (let i = 0; i < trials; i++) {
    results.push(simulateTransfer(strategy, camera, data, baseSeed + i * 7919, { timeoutMs }));
  }
  const completed = results.filter((r) => r.ok);
  const times = completed.map((r) => r.ms).sort((a, b) => a - b);
  const goodputs = completed.map((r) => r.goodputBps).sort((a, b) => a - b);
  const totalScans = results.reduce((a, r) => a + r.scans, 0);
  const totalDecodes = results.reduce((a, r) => a + r.decodes, 0);
  return {
    strategy: strategy.name,
    camera: camera.name,
    trials,
    completionRate: completed.length / trials,
    medianMs: quantile(times, 0.5),
    p10Ms: quantile(times, 0.1),
    p90Ms: quantile(times, 0.9),
    medianGoodputBps: quantile(goodputs, 0.5),
    meanOverhead: mean(completed.map((r) => r.overhead)),
    scanSuccessRate: totalScans > 0 ? totalDecodes / totalScans : 0,
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Deterministic pseudo-random test payload. */
export function makeTestFile(size: number, seed = 42): Uint8Array {
  const rng = mulberry32(seed);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = Math.floor(rng() * 256);
  return out;
}
