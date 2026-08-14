import { LTEncoder } from "../lib/lt";
import { crc32 } from "../lib/crc32";
import { serializeDataPacket, serializeMetaPacket } from "../lib/packet";
import { packetIndices, robustSolitonCDF } from "../lib/soliton";

/**
 * A sender strategy decides everything the sender controls: block size, frame
 * rate, which packet each frame carries, and (for protocol-change experiments)
 * the degree distribution. Strategies build QR texts with the production
 * serialization path, so anything that wins in sim is wire-real.
 */
export interface StrategyContext {
  data: Uint8Array;
  /** Deterministic PRNG for the trial — all strategy randomness must use it. */
  rng: () => number;
}

export interface SenderPlan {
  k: number;
  /** QR text displayed during frame n. Must be a pure function of n. */
  frameText(frame: number): string;
}

export interface Strategy {
  name: string;
  fps: number;
  blockSize: number;
  /**
   * Custom degree distribution — a protocol change applied to BOTH ends
   * (the simulator hands it to the decoder too). Omit for wire-compatible
   * strategies deployable against today's receiver.
   */
  cdf?: (k: number) => Float64Array;
  plan(ctx: StrategyContext): SenderPlan;
}

interface Session {
  encoder: LTEncoder;
  metaText: string;
  seedBase: number;
  fileId: number;
}

function makeSession(ctx: StrategyContext, blockSize: number, cdf?: (k: number) => Float64Array): Session {
  const fileId = Math.floor(ctx.rng() * 0xffffffff) >>> 0;
  const encoder = new LTEncoder(ctx.data, blockSize, cdf?.(Math.max(1, Math.ceil(ctx.data.length / blockSize))));
  const metaText = serializeMetaPacket({
    fileId,
    k: encoder.k,
    blockSize,
    fileSize: ctx.data.length,
    crc: crc32(ctx.data),
    name: "sim.bin",
    mime: "application/octet-stream",
  });
  return { encoder, metaText, seedBase: Math.floor(ctx.rng() * 0xffffffff) >>> 0, fileId };
}

function dataText(s: Session, seed: number): string {
  seed = seed >>> 0;
  return serializeDataPacket({
    fileId: s.fileId,
    k: s.encoder.k,
    blockSize: s.encoder.blockSize,
    fileSize: s.encoder.fileSize,
    seed,
    payload: s.encoder.encode(seed),
  });
}

export interface BaselineOpts {
  blockSize?: number;
  fps?: number;
  metaInterval?: number;
  name?: string;
}

/** What the shipped sender does today: sequential seeds, meta every Nth frame. */
export function baseline(opts: BaselineOpts = {}): Strategy {
  const { blockSize = 256, fps = 8, metaInterval = 8 } = opts;
  return {
    name: opts.name ?? `baseline b${blockSize} @${fps}fps meta/${metaInterval}`,
    fps,
    blockSize,
    plan(ctx) {
      const s = makeSession(ctx, blockSize);
      return {
        k: s.encoder.k,
        frameText: (frame) =>
          frame % metaInterval === metaInterval - 1 ? s.metaText : dataText(s, s.seedBase + frame),
      };
    },
  };
}

/**
 * Meta frames are pure overhead once the receiver has seen one. Send them
 * densely at the start (so late joiners lock on fast), sparsely afterwards.
 */
export function metaFrontLoaded(opts: BaselineOpts & { warmupFrames?: number } = {}): Strategy {
  const { blockSize = 256, fps = 8, warmupFrames = 32 } = opts;
  const isMeta = (frame: number): boolean =>
    frame < warmupFrames ? frame % 4 === 3 : frame % 32 === 31;
  return {
    name: opts.name ?? `meta-frontloaded b${blockSize} @${fps}fps`,
    fps,
    blockSize,
    plan(ctx) {
      const s = makeSession(ctx, blockSize);
      return {
        k: s.encoder.k,
        frameText: (frame) => (isMeta(frame) ? s.metaText : dataText(s, s.seedBase + frame)),
      };
    },
  };
}

/**
 * Degree-1 seeds covering every block, found by brute-force seed search
 * (wire-compatible: the receiver just sees ordinary seeds). Sending each
 * block once before switching to fountain packets removes the LT overhead
 * entirely on clean channels while keeping fountain robustness under loss.
 */
const degreeOneCache = new Map<string, number[]>();

export function degreeOneSeeds(k: number, cdf: Float64Array, cacheKey = `k${k}`): number[] {
  const cached = degreeOneCache.get(cacheKey);
  if (cached) return cached;
  const seeds = new Array<number>(k).fill(-1);
  let remaining = k;
  for (let seed = 1; remaining > 0; seed++) {
    if (seed > 200_000_000) throw new Error("degree-1 seed search did not converge");
    const indices = packetIndices(seed, k, cdf);
    if (indices.length === 1 && seeds[indices[0]] < 0) {
      seeds[indices[0]] = seed;
      remaining--;
    }
  }
  degreeOneCache.set(cacheKey, seeds);
  return seeds;
}

export function systematicFirst(opts: BaselineOpts = {}): Strategy {
  const { blockSize = 256, fps = 8, metaInterval = 8 } = opts;
  return {
    name: opts.name ?? `systematic-first b${blockSize} @${fps}fps`,
    fps,
    blockSize,
    plan(ctx) {
      const s = makeSession(ctx, blockSize);
      const k = s.encoder.k;
      const sys = degreeOneSeeds(k, robustSolitonCDF(k));
      // Frames: meta every Nth as baseline; data slots first walk the
      // systematic pass, then continue as a plain fountain.
      return {
        k,
        frameText: (frame) => {
          if (frame % metaInterval === metaInterval - 1) return s.metaText;
          const dataIdx = frame - Math.floor(frame / metaInterval);
          if (dataIdx < k) return dataText(s, sys[dataIdx]);
          return dataText(s, s.seedBase + frame);
        },
      };
    },
  };
}

/**
 * Naive carousel: loop the k degree-1 packets forever, no fountain coding.
 * The classic strawman — under loss its completion time has a brutal
 * coupon-collector tail. Included as a lower bound to keep the sim honest.
 */
export function carousel(opts: BaselineOpts = {}): Strategy {
  const { blockSize = 256, fps = 8, metaInterval = 8 } = opts;
  return {
    name: opts.name ?? `carousel b${blockSize} @${fps}fps`,
    fps,
    blockSize,
    plan(ctx) {
      const s = makeSession(ctx, blockSize);
      const k = s.encoder.k;
      const sys = degreeOneSeeds(k, robustSolitonCDF(k));
      return {
        k,
        frameText: (frame) => {
          if (frame % metaInterval === metaInterval - 1) return s.metaText;
          const dataIdx = frame - Math.floor(frame / metaInterval);
          return dataText(s, sys[dataIdx % k]);
        },
      };
    },
  };
}

/** Baseline with a re-tuned robust-soliton distribution on both ends. */
export function solitonTuned(c: number, delta: number, opts: BaselineOpts = {}): Strategy {
  const { blockSize = 256, fps = 8, metaInterval = 8 } = opts;
  const cdf = (k: number): Float64Array => robustSolitonCDF(k, c, delta);
  return {
    name: opts.name ?? `soliton c=${c} δ=${delta} b${blockSize} @${fps}fps`,
    fps,
    blockSize,
    cdf,
    plan(ctx) {
      const s = makeSession(ctx, blockSize, cdf);
      return {
        k: s.encoder.k,
        frameText: (frame) =>
          frame % metaInterval === metaInterval - 1 ? s.metaText : dataText(s, s.seedBase + frame),
      };
    },
  };
}

/** The default comparison set the CLI runs. */
export function defaultStrategies(): Strategy[] {
  return [
    baseline({ blockSize: 128 }),
    baseline({ blockSize: 256 }),
    baseline({ blockSize: 512 }),
    baseline({ blockSize: 256, fps: 4 }),
    baseline({ blockSize: 256, fps: 12 }),
    metaFrontLoaded({ blockSize: 256 }),
    systematicFirst({ blockSize: 256 }),
    carousel({ blockSize: 256 }),
    solitonTuned(0.1, 0.05, { blockSize: 256 }),
  ];
}
