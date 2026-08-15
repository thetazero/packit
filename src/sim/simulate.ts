import type { TileSender } from "../wasm/pkg/packit_core";
import { CameraSim, type CameraParams, type Capture } from "./camera";
import type { Core } from "./core";
import { mulberry32 } from "./prng";

/**
 * Simulates one transfer end to end through the shipped codec: the wasm
 * TileSender renders the frames the app would display, the camera model
 * synthesizes what the sensor sees at each scan instant, and the pixels go
 * straight into the wasm TileReceiver — the receiver's exact code path with
 * synthetic pixels in place of a webcam.
 */
export interface SenderConfig {
  name: string;
  /** Display frame rate — the one transfer knob the sender exposes. */
  fps: number;
}

export interface TrialResult {
  /** Completed before timeout and the reassembled bytes match the input. */
  ok: boolean;
  /** Wall-clock ms from first displayed frame to decode+meta complete. */
  ms: number;
  /** File bytes per second of wall-clock time (0 if not completed). */
  goodputBps: number;
  /** Camera scan attempts, and how many the decoder recognized as a frame. */
  scans: number;
  recognized: number;
  /** Unique fountain packets consumed, and the minimum the file needs. */
  packets: number;
  needed: number;
  /** packets / needed — the fountain reception overhead. */
  overhead: number;
}

interface TileStatus {
  recognized: boolean;
  packets: number;
  needed: number;
  haveMeta: boolean;
  done: boolean;
}

export interface SimulateOptions {
  timeoutMs?: number;
  /** Called with every synthesized capture — for dumping frames to disk. */
  onCapture?: (capture: Capture, tMs: number, recognized: boolean) => void;
}

/** Sequential frame generation (the sender is stateful), cached by index. */
class FrameSource {
  private readonly frames = new Map<number, Uint8Array>();
  private next = 0;

  constructor(private readonly sender: TileSender) {}

  get(frame: number): Uint8Array {
    while (this.next <= frame) {
      this.frames.set(this.next++, new Uint8Array(this.sender.next_frame()));
      if (this.frames.size > 8) {
        const oldest = this.frames.keys().next().value!;
        this.frames.delete(oldest);
      }
    }
    const img = this.frames.get(frame);
    if (!img) throw new Error(`sender frame ${frame} already evicted`);
    return img;
  }
}

export function simulateTransfer(
  core: Core,
  config: SenderConfig,
  camera: CameraParams,
  data: Uint8Array,
  seed: number,
  opts: SimulateOptions = {},
): TrialResult {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const rng = mulberry32(seed >>> 0);
  const frameMs = 1000 / config.fps;

  const sender = new core.TileSender(data, "sim.bin", "application/octet-stream");
  const receiver = new core.TileReceiver();
  try {
    const frames = new FrameSource(sender);
    let status: TileStatus = { recognized: false, packets: 0, needed: 0, haveMeta: false, done: false };
    let scans = 0;
    let recognized = 0;
    let doneAt = -1;

    const push = (rgba: Uint8Array, w: number, h: number): void => {
      status = JSON.parse(receiver.push_frame(rgba, w, h)) as TileStatus;
      if (status.recognized) recognized++;
    };

    if (camera.lossless) {
      const maxFrames = Math.ceil(timeoutMs / frameMs);
      for (let frame = 0; frame < maxFrames && doneAt < 0; frame++) {
        scans++;
        push(frames.get(frame), 1024, 1024);
        if (status.done) doneAt = (frame + 1) * frameMs;
      }
    } else {
      const cam = new CameraSim(camera, (frame) => frames.get(frame), config.fps, rng);
      let t = 0;
      while (t < timeoutMs && doneAt < 0) {
        t += camera.scanIntervalMs * (1 + camera.scanJitter * (2 * rng() - 1));
        scans++;
        const { rgba, capture } = cam.snap(t);
        push(rgba, capture.width, capture.height);
        opts.onCapture?.(capture, t, status.recognized);
        if (status.done) doneAt = t;
      }
    }

    const file = status.done ? receiver.take_file() : undefined;
    const ok = file !== undefined && bytesEqual(file, data);
    const ms = doneAt >= 0 ? doneAt : timeoutMs;
    return {
      ok,
      ms,
      goodputBps: ok ? data.length / (ms / 1000) : 0,
      scans,
      recognized,
      packets: status.packets,
      needed: status.needed,
      overhead: status.needed > 0 ? status.packets / status.needed : 0,
    };
  } finally {
    sender.free();
    receiver.free();
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface TrialSummary {
  sender: string;
  camera: string;
  trials: number;
  completionRate: number;
  medianMs: number;
  p10Ms: number;
  p90Ms: number;
  medianGoodputBps: number;
  meanOverhead: number;
  /** Fraction of scan attempts the decoder recognized. */
  scanSuccessRate: number;
}

/** Run n independent trials (fresh PRNG stream each) and aggregate. */
export function runTrials(
  core: Core,
  config: SenderConfig,
  camera: CameraParams,
  data: Uint8Array,
  trials: number,
  baseSeed = 1,
  timeoutMs?: number,
): TrialSummary {
  const results: TrialResult[] = [];
  for (let i = 0; i < trials; i++) {
    results.push(simulateTransfer(core, config, camera, data, baseSeed + i * 7919, { timeoutMs }));
  }
  const completed = results.filter((r) => r.ok);
  const times = completed.map((r) => r.ms).sort((a, b) => a - b);
  const goodputs = completed.map((r) => r.goodputBps).sort((a, b) => a - b);
  const totalScans = results.reduce((a, r) => a + r.scans, 0);
  const totalRecognized = results.reduce((a, r) => a + r.recognized, 0);
  return {
    sender: config.name,
    camera: camera.name,
    trials,
    completionRate: completed.length / trials,
    medianMs: quantile(times, 0.5),
    p10Ms: quantile(times, 0.1),
    p90Ms: quantile(times, 0.9),
    medianGoodputBps: quantile(goodputs, 0.5),
    meanOverhead: mean(completed.map((r) => r.overhead)),
    scanSuccessRate: totalScans > 0 ? totalRecognized / totalScans : 0,
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
