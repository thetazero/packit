# Camera-in-the-loop simulator

A pixel-level simulator of the whole transfer, for validating bandwidth
choices without pointing a phone at a screen. Every scan attempt:

1. **Sender** — the production wasm `TileSender` renders the exact 1024×1024
   RGBA frame the app would display.
2. **Screen** — that frame is projected into the camera's image plane
   (`render.ts`): fixed physical size, camera tilt, LCD black/white levels,
   anti-aliased tile edges at ~6–8 camera pixels per tile.
3. **Camera** — the sensor image is synthesized per RGB channel
   (`camera.ts`): exposure integrated over the shutter window (an exposure
   straddling a sender frame change produces a ghosted blend of two frames),
   rolling-shutter row skew, LCD pixel-response smearing, hand-shake motion
   blur, defocus with autofocus-hunt episodes, sensor noise, glare-washed
   contrast.
4. **Receive** — the pixels go straight into the production wasm
   `TileReceiver` until the file reassembles bit-exactly. Whether a frame is
   readable is decided by the shipped decoder on real pixels, not a
   probability model.

Because steps 1–4 *are* the shipped code (RaptorQ fountain, framing, RS
layer, tile detector), a configuration that wins here is wire-real. Requires
`npm run build:wasm` first.

## Run it

```sh
npm run sim                                  # 64 KB, 3 trials, lossless + handheld
npm run sim -- --scenarios steady,handheld,lowlight --trials 5
npm run sim -- --size 262144 --seed 7 --fps 8,15,30
npm run sim -- --dump captures/              # save synthesized sensor frames as PPM
npm run sim -- --help
```

Each scan really renders pixels and runs the wasm decoder, so CPU time scales
with `--size × --trials × scenarios`. `--dump` writes what the simulated
camera saw (ghosting, blur, noise and all) for eyeballing and calibration.

Output is one table per scenario, sender frame rates sorted by median goodput
(file bytes per wall-clock second — the number a user experiences). `scan
hit` is the fraction of camera scan attempts the decoder recognized. The fps
sweep answers the codec's main tuning question: past some frame rate, camera
exposures straddle frame changes so often that ghosting eats more packets
than the extra rate delivers.

## Scenarios

| | steady | handheld | lowlight |
| --- | --- | --- | --- |
| setup | tripod, good light | mid-range phone at a laptop | dim room |
| sensor / span | 1280 px / 0.80 | 1152 px / 0.80 | 1024 px / 0.85 |
| exposure | 6 ms | 12 ms | 24 ms |
| shake | 25 px/s | 130 px/s | 140 px/s |
| noise / contrast | σ4 / 0.90 | σ5 / 0.85 | σ6 / 0.75 |

Calibration is anchored to the decoder's real limits: the frame must span
≥ ~820 camera pixels (a 2 px glyph block needs ~1.6 sensor pixels — see the
`downscale_limit` test in `crates/packit-core/tests/codec.rs`), so sensors
sit at 1024–1280 px with the frame filling most of the view, matching the
app's 1280 px scan resolution. `lowlight` deliberately hovers just above the
span floor.

Plus `lossless`, which bypasses the optics entirely (every frame decoded
once) to isolate the codec's pure coding overhead.

The presets are calibration knobs — hold your own phone at your own screen,
`--dump` frames, and adjust until they look alike. *Rankings* between frame
rates are much less sensitive than absolute throughput.

## Determinism

All randomness (hand shake, noise, AF hunts, scan-interval jitter) flows
through a seeded `mulberry32` stream, and the wasm sender/receiver are
deterministic — identical seeds reproduce identical trials, so A/B
comparisons are noise-free and failures replay exactly.
