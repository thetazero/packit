# Camera-in-the-loop simulator

A pixel-level simulator of the whole transfer, for validating bandwidth
strategies without pointing a phone at a screen. Every scan attempt:

1. **Screen** — the sender frame's QR is rasterized into the camera's image
   plane (`render.ts`): real module matrix from the `qrcode` library, fixed
   physical size incl. quiet zone (denser codes ⇒ smaller modules), camera
   tilt, anti-aliased edges at low pixels-per-module.
2. **Camera** — the sensor image is synthesized (`camera.ts`): exposure
   integrated over the shutter window (an exposure straddling a sender frame
   change produces a ghosted blend of two codes), rolling-shutter row skew,
   LCD pixel-response smearing, hand-shake motion blur, defocus with
   autofocus-hunt episodes, sensor noise, glare-washed contrast.
3. **Decode** — the pixels go to **jsQR**, the production fallback decoder.
   Whether a frame is readable is decided by a real decoder on real pixels,
   not a probability model.
4. **Receive** — decoded text flows through the production `parsePacket` →
   `LTDecoder` path until the file reassembles bit-exactly.

Because steps 1–4 reuse the shipped code (encoder, wire format, base45, jsQR,
peeling decoder), a strategy that wins here is wire-real.

## Run it

```sh
npm run sim                                  # 8 KB, 3 trials, lossless + handheld
npm run sim -- --scenarios steady,handheld,lowlight --trials 5
npm run sim -- --size 16384 --seed 7
npm run sim -- --dump captures/              # save synthesized sensor frames as PGM
npm run sim -- --help
```

Each scan really renders pixels and runs jsQR, so CPU time scales with
`--size × --trials × scenarios`. `--dump` writes what the simulated camera
saw (ghosting, blur, noise and all) for eyeballing and calibration.

Output is one table per scenario, strategies sorted by median goodput (file
bytes per wall-clock second — the number a user experiences). `scan hit` is
the fraction of camera scan attempts that decoded.

## Scenarios

| | steady | handheld | lowlight |
| --- | --- | --- | --- |
| setup | tripod, good light | mid-range phone at a laptop | dim room |
| exposure | 6 ms | 12 ms | 24 ms |
| shake | 25 px/s | 130 px/s | 140 px/s |
| noise / contrast | σ3 / 0.95 | σ5 / 0.85 | σ5.5 / 0.75 |

The noise numbers sit deliberately just under jsQR's binarizer cliff (σ ≈ 6
at ~6.5 px/module — probe it yourself by editing a preset); past it, decode
rates collapse from ~100% to near zero. That cliff is real: jsQR is the
production fallback decoder.

Plus `lossless`, which bypasses the optics entirely (every frame decoded
once) to isolate a strategy's pure coding overhead.

The presets are calibration knobs — hold your own phone at your own screen,
`--dump` frames, and adjust until they look alike. Strategy *rankings* are
much less sensitive than absolute throughput.

## Writing a strategy (`strategy.ts`)

A strategy owns everything the sender controls: block size, frame rate, and
which packet text each frame shows. `frameText(frame)` must be a pure
function of the frame index (the camera samples frames at arbitrary times).

```ts
const myStrategy: Strategy = {
  name: "my-idea",
  fps: 10,
  blockSize: 256,
  plan(ctx) {
    const s = /* build encoder + meta from ctx.data */;
    return { k: s.encoder.k, frameText: (frame) => /* QR text */ };
  },
};
```

Setting `cdf` marks a **protocol change**: the simulator applies the custom
degree distribution to the decoder too, modeling a coordinated upgrade of
both ends. Strategies without `cdf` are deployable against today's receiver
as-is.

Built-ins:

- `baseline` — what the shipped sender does (sequential seeds, meta every
  8th frame), at various block sizes / frame rates.
- `metaFrontLoaded` — dense meta frames early for fast lock-on, sparse later.
- `systematicFirst` — a degree-1 pass covering every block once (via
  brute-force seed search, so it's wire-compatible), then plain fountain.
  Zero reception overhead on clean channels, fountain robustness under loss.
- `carousel` — loops the k degree-1 packets with no fountain coding; the
  strawman lower bound with the coupon-collector tail.
- `solitonTuned(c, δ)` — re-tuned robust-soliton parameters on both ends.

Add yours to `defaultStrategies()` and it appears in every CLI run.

## Determinism

All randomness (strategy seeds, hand shake, noise, AF hunts) flows through a
seeded `mulberry32` stream — identical seeds reproduce identical trials, so
A/B comparisons between strategies are noise-free and failures replay
exactly.
