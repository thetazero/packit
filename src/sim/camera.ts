import { projectFrame, type TrialGeometry } from "./render";

/**
 * Imperfect-camera model. Each scan attempt synthesizes the image a camera
 * would capture at that instant — integrating the display over the exposure
 * window (so exposures straddling a sender frame change produce ghosted
 * blends of two frames), with rolling-shutter row skew, LCD pixel-response
 * smearing, hand-shake motion blur, defocus (plus autofocus hunting
 * episodes), sensor noise, and glare-washed contrast. The pipeline runs per
 * RGB channel because the tile codec classifies tile *colors*; whether a
 * capture is readable is decided by the production wasm decoder on these
 * pixels, not a probability curve.
 */
export interface CameraParams {
  name: string;
  /** Bypass the optical pipeline: every frame decoded once. Measures pure coding overhead. */
  lossless?: boolean;
  /** Sensor crop resolution (square). */
  camPx: number;
  /** Fraction of the sensor width the 1024px frame spans (framing distance). */
  frameFraction: number;
  /** Mean wall-clock per scan attempt (capture + decode latency), ms. */
  scanIntervalMs: number;
  /** Uniform jitter on the scan interval, as a fraction. */
  scanJitter: number;
  /** Exposure (shutter) time, ms. Long exposures ghost across frame changes. */
  exposureMs: number;
  /** Rolling-shutter readout skew from first to last row, ms. */
  readoutMs: number;
  /** LCD pixel transition time — old and new frame blend during this ramp, ms. */
  screenResponseMs: number;
  /** Hand-shake speed in camera px/s; blur length = speed × exposure. */
  shakePxPerSec: number;
  /** Max camera tilt vs the screen, degrees (fixed per trial). */
  maxTiltDeg: number;
  /** Base defocus blur sigma, camera px. */
  defocusSigma: number;
  /** Extra sigma while the autofocus is hunting. */
  focusHuntSigma: number;
  /** Per-scan probability of entering / leaving an AF-hunt episode. */
  focusHuntEnter: number;
  focusHuntExit: number;
  /** Sensor noise sigma, gray levels. */
  noiseSigma: number;
  /** Contrast multiplier (<1 = glare / ambient light washing out the screen). */
  contrast: number;
}

/**
 * Scenario calibration is anchored to the decoder's real limits: the tile
 * codec needs the frame to span >= ~820 camera pixels (a 2px glyph block
 * needs ~1.6 sensor pixels — see the `downscale_limit` codec test), so the
 * sensor crops sit at 1024-1280px with the frame filling most of the view,
 * matching the app's 1280px scan resolution.
 */
export const SCENARIOS: Record<string, CameraParams> = {
  /** No optics at all — isolates the codec's pure coding overhead. */
  lossless: {
    name: "lossless",
    lossless: true,
    camPx: 0,
    frameFraction: 0,
    scanIntervalMs: 0,
    scanJitter: 0,
    exposureMs: 0,
    readoutMs: 0,
    screenResponseMs: 0,
    shakePxPerSec: 0,
    maxTiltDeg: 0,
    defocusSigma: 0,
    focusHuntSigma: 0,
    focusHuntEnter: 0,
    focusHuntExit: 1,
    noiseSigma: 0,
    contrast: 1,
  },
  /** Phone on a tripod, good light, fast sensor. */
  steady: {
    name: "steady",
    camPx: 1280,
    frameFraction: 0.8,
    scanIntervalMs: 80,
    scanJitter: 0.2,
    exposureMs: 6,
    readoutMs: 8,
    screenResponseMs: 6,
    shakePxPerSec: 25,
    maxTiltDeg: 2,
    defocusSigma: 0.5,
    focusHuntSigma: 2.0,
    focusHuntEnter: 0.003,
    focusHuntExit: 0.4,
    noiseSigma: 4,
    contrast: 0.9,
  },
  /** Handheld mid-range phone at a laptop screen — the default. */
  handheld: {
    name: "handheld",
    camPx: 1152,
    frameFraction: 0.8,
    scanIntervalMs: 110,
    scanJitter: 0.35,
    exposureMs: 12,
    readoutMs: 12,
    screenResponseMs: 8,
    shakePxPerSec: 130,
    maxTiltDeg: 6,
    defocusSigma: 0.6,
    focusHuntSigma: 2.5,
    focusHuntEnter: 0.012,
    focusHuntExit: 0.3,
    noiseSigma: 5,
    contrast: 0.85,
  },
  /**
   * Dim room: long exposure (more ghosting + motion blur), frequent AF
   * hunting, and the frame span sits just above the decoder's ~820px floor.
   */
  lowlight: {
    name: "lowlight",
    camPx: 1024,
    frameFraction: 0.85,
    scanIntervalMs: 160,
    scanJitter: 0.45,
    exposureMs: 24,
    readoutMs: 16,
    screenResponseMs: 10,
    shakePxPerSec: 140,
    maxTiltDeg: 8,
    defocusSigma: 0.9,
    focusHuntSigma: 3.0,
    focusHuntEnter: 0.03,
    focusHuntExit: 0.25,
    noiseSigma: 6,
    contrast: 0.75,
  },
};

/** Planar RGB float image: three camPx² planes (R, G, B). */
export interface Capture {
  rgb: Float32Array;
  width: number;
  height: number;
}

interface FrameWeight {
  frame: number;
  w: number;
}

export class CameraSim {
  private readonly geom: TrialGeometry;
  private readonly frameCache = new Map<number, Uint8Array>();
  private readonly frameMs: number;
  private focusHunting = false;

  constructor(
    private readonly p: CameraParams,
    /** RGBA pixels (1024×1024×4) the sender displays during frame n. */
    private readonly frameRgba: (frame: number) => Uint8Array,
    senderFps: number,
    private readonly rng: () => number,
  ) {
    this.frameMs = 1000 / senderFps;
    // Per-trial physical setup: how the user happens to hold the phone.
    this.geom = {
      camPx: p.camPx,
      spanPx: p.camPx * p.frameFraction * (0.95 + 0.1 * rng()),
      rotationRad: ((rng() * 2 - 1) * p.maxTiltDeg * Math.PI) / 180,
      white: 235,
      black: 25,
      bg: 15,
    };
  }

  /** Synthesize the image a capture ending at time t would produce. */
  capture(tMs: number): Capture {
    const { p } = this;
    const n = p.camPx;
    const plane = n * n;
    const img = new Float32Array(3 * plane);

    // Exposure integration, row by row (rolling shutter skews row timing).
    for (let y = 0; y < n; y++) {
      const rowT = tMs + p.readoutMs * (y / n);
      const weights = this.frameWeights(rowT);
      const row = y * n;
      for (const { frame, w } of weights) {
        const src = this.frameImage(frame);
        for (let c = 0; c < 3; c++) {
          const off = c * plane + row;
          for (let x = 0; x < n; x++) img[off + x] += w * src[off + x];
        }
      }
    }

    // Hand shake: linear motion blur over the exposure.
    const shake = p.shakePxPerSec * (0.4 + 1.2 * this.rng());
    const blurLen = (shake * p.exposureMs) / 1000;
    const angle = this.rng() * 2 * Math.PI;
    for (let c = 0; c < 3; c++) motionBlur(img.subarray(c * plane, (c + 1) * plane), n, n, blurLen, angle);

    // Defocus, with occasional autofocus-hunt episodes.
    if (this.focusHunting) {
      if (this.rng() < p.focusHuntExit) this.focusHunting = false;
    } else if (this.rng() < p.focusHuntEnter) {
      this.focusHunting = true;
    }
    const sigma =
      p.defocusSigma * (0.75 + 0.5 * this.rng()) + (this.focusHunting ? p.focusHuntSigma : 0);
    for (let c = 0; c < 3; c++) gaussianBlur(img.subarray(c * plane, (c + 1) * plane), n, n, sigma);

    // Sensor: glare-reduced contrast + shot/read noise (per channel, so
    // noise perturbs color classification too, not just brightness).
    for (let i = 0; i < img.length; i++) {
      const noise = (this.rng() + this.rng() - 1) * p.noiseSigma * 2.45;
      img[i] = 128 + (img[i] - 128) * p.contrast + noise;
    }
    return { rgb: img, width: n, height: n };
  }

  /** One scan attempt: capture at time t, quantized for the wasm decoder. */
  snap(tMs: number): { rgba: Uint8Array; capture: Capture } {
    const capture = this.capture(tMs);
    const plane = capture.width * capture.height;
    const rgba = new Uint8Array(plane * 4);
    for (let i = 0; i < plane; i++) {
      rgba[i * 4] = clamp255(capture.rgb[i]);
      rgba[i * 4 + 1] = clamp255(capture.rgb[plane + i]);
      rgba[i * 4 + 2] = clamp255(capture.rgb[2 * plane + i]);
      rgba[i * 4 + 3] = 255;
    }
    return { rgba, capture };
  }

  /**
   * Which sender frames contribute to a row exposed over
   * [rowT - exposureMs, rowT], and with what weight. Accounts for the LCD
   * pixel-response ramp: right after a frame change the screen still shows a
   * blend of the outgoing and incoming frame.
   */
  private frameWeights(rowT: number): FrameWeight[] {
    const { exposureMs, screenResponseMs } = this.p;
    const S = 6;
    const acc = new Map<number, number>();
    const add = (frame: number, w: number): void => {
      if (frame < 0) frame = 0;
      acc.set(frame, (acc.get(frame) ?? 0) + w);
    };
    for (let i = 0; i < S; i++) {
      const tau = Math.max(0, rowT - exposureMs * ((i + 0.5) / S));
      const frame = Math.floor(tau / this.frameMs);
      const sinceChange = tau - frame * this.frameMs;
      if (screenResponseMs > 0 && sinceChange < screenResponseMs && frame > 0) {
        const alpha = sinceChange / screenResponseMs;
        add(frame - 1, (1 - alpha) / S);
        add(frame, alpha / S);
      } else {
        add(frame, 1 / S);
      }
    }
    return [...acc.entries()].map(([frame, w]) => ({ frame, w }));
  }

  private frameImage(frame: number): Uint8Array {
    const cached = this.frameCache.get(frame);
    if (cached) return cached;
    const img = projectFrame(this.frameRgba(frame), this.geom);
    this.frameCache.set(frame, img);
    if (this.frameCache.size > 6) {
      const oldest = this.frameCache.keys().next().value!;
      this.frameCache.delete(oldest);
    }
    return img;
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** In-place linear motion blur of the given length (px) and direction. */
export function motionBlur(
  img: Float32Array,
  w: number,
  h: number,
  length: number,
  angle: number,
): void {
  const taps = Math.min(12, Math.max(1, Math.round(length)));
  if (taps < 2) return;
  const src = img.slice();
  const dx = Math.cos(angle) * length;
  const dy = Math.sin(angle) * length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = 0; t < taps; t++) {
        const f = t / (taps - 1) - 0.5;
        const sx = Math.min(w - 1, Math.max(0, Math.round(x + dx * f)));
        const sy = Math.min(h - 1, Math.max(0, Math.round(y + dy * f)));
        acc += src[sy * w + sx];
      }
      img[y * w + x] = acc / taps;
    }
  }
}

/** In-place separable Gaussian blur. */
export function gaussianBlur(img: Float32Array, w: number, h: number, sigma: number): void {
  if (sigma < 0.3) return;
  const radius = Math.min(14, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float32Array(img.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const sx = Math.min(w - 1, Math.max(0, x + i));
        acc += kernel[i + radius] * img[y * w + sx];
      }
      tmp[y * w + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const sy = Math.min(h - 1, Math.max(0, y + i));
        acc += kernel[i + radius] * tmp[sy * w + x];
      }
      img[y * w + x] = acc;
    }
  }
}
