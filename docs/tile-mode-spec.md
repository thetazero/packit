# Tile mode — design spec (v2)

Supersedes the retired dense-color spec. Revised after studying
[libcimbar](https://github.com/sz3/libcimbar) (C++/MPL-2.0), which measured
**~106 KB/s** screen→camera with the same architecture we planned — proving the
100× target is reachable and teaching us three lessons we adopt:

1. **Shapes beat colors.** Cimbar deprecated its 8-color mode: color is the
   unreliable channel. Robust bits come from multi-pixel glyph shapes decoded
   by image-hash Hamming distance; color contributes only 2 bits per tile.
2. **Reed–Solomon from day one.** Post-shape-matching tile error rates are
   sub-1%; interleaved RS corrects them instead of dropping whole frames.
3. **The camera is the bottleneck, not the CPU** — but only if decode is
   native-speed. Hence Rust→WASM.

We do **not** aim for cimbar wire compatibility. We take the ideas and keep our
own packet/metadata layers, 4-anchor homography, and in-browser decoding —
which libcimbar does not have (its decoder is an Android/OpenCV app; the wasm
build is encoder-only). A browser-to-browser PWA doing both directions is the
novel part of this project.

## Architecture

```
crates/packit-core (Rust → wasm32, via wasm-pack + wasm-bindgen)
  ├── tile codec      encode_frame(bytes) -> RGBA / decode_frame(RGBA) -> bytes
  ├── reed-solomon    RS(155,125) over GF(256), interleaved across the frame
  ├── fountain        raptorq (RFC 6330) object encoding/decoding
  └── framing         file metadata (name, mime, crc32), OTI, packet headers

src/ (TypeScript)
  ├── UI, camera/canvas plumbing, PWA shell   (unchanged roles)
  ├── legacy QR transport (jsQR/BarcodeDetector + base45 + LT)  — kept as
  │     the no-wasm/compatibility fallback, untouched
  └── wasm loader + thin sender/receiver glue for tile mode
```

Sender and receiver share one compiled core, so determinism is by
construction. The JS↔wasm boundary is two calls per frame with a persistent
buffer — never per-tile chatter.

## Visual format

- **Canvas**: fixed 1024×1024 logical px, CSS-scaled to fit the screen.
  Black background (glyphs are bright-on-dark; screens emit light, so dark
  background maximizes per-channel contrast and reduces blooming).
- **Tiles**: 8×8 px glyphs on a uniform grid. **16 glyph symbols** (4 bits),
  generated/curated for maximal pairwise Hamming distance (target ≥ 20 bits of
  64, matching cimbar's alphabet quality). **4 colors** (2 bits) applied to
  the glyph's "on" pixels: a palette of well-separated hues (initial:
  cyan, magenta, yellow, green; final palette is an implementation detail
  validated by the synthetic-camera tests). **6 bits/tile.**
- **Anchors**: 4 corner bullseye markers (concentric square rings, ~48 px)
  for detection + full 4-point homography; one marker visually distinct to fix
  rotation. **Alignment dots** (small bullseyes) on a coarse interior lattice
  (~every 192 px) for local drift correction — at 8 px tiles, a global
  homography alone is not accurate enough across 1024 px of screen glass and
  lens distortion; cimbar's ±7 px drift tracking confirms this.
- **Color reference**: a short strip of known-color tiles adjacent to each
  anchor, sampled to calibrate the 4-color classifier per frame.
- Capacity at this geometry: ~15k tiles gross, ≈ **12k data tiles** after
  anchors/alignment/reference ⇒ ~9.0 KB raw, ≈ **7.4 KB per frame after RS**
  (30/155 parity). Exact counts are computed by the implementation and pinned
  by tests, not hand-maintained in this doc.

## Frame payload format

RS-coded body, interleaved with stride N so a smudge corrupts ≤ t bytes per
RS block (t = 15 with 30 ECC bytes):

```
header:  u8 magic 0xPC | u8 version | u8 flags | u32 fileId
         | 12B raptorq OTI | u32 payloadId+len fields
body:    one raptorq EncodingPacket (symbol size = frame capacity − header)
```

The 12-byte OTI rides in **every** frame (0.2% overhead) so a receiver joining
mid-stream constructs its decoder from any single frame — no buffering phase.
File metadata (name, mime, whole-file crc32) travels in a **meta frame**
interleaved every 8th frame, as today. A final whole-file crc32 check remains
the end-to-end integrity gate.

## Decode pipeline (all in Rust)

1. Grayscale + adaptive threshold (integral image).
2. Locate 4 corner bullseyes (run-ratio scan, like QR finders but ring-shaped);
   order corners, fix rotation from the distinct marker.
3. Global homography (4-pt DLT); then per-lattice-cell refinement against the
   alignment dots → a smoothly-varying local offset field (cap ±8 px).
4. For each tile: sample its 8×8 pixels through the corrected mapping,
   binarize against local luma, hash, nearest symbol by Hamming distance
   (confidence = margin to second-best); mean RGB of "on" pixels → color via
   the calibrated classifier.
5. De-interleave, RS-decode each block (correct ≤ 15 errors), reassemble;
   header sanity + fountain-layer consumption. A frame that fails RS is
   dropped — fountain coding absorbs it.

## Fountain layer

`raptorq` crate (RFC 6330): systematic, ~0–2% reception overhead (vs 7–18%
for our LT code), proven at scale. One EncodingPacket per frame; symbol size
chosen so K source symbols cover the file (files up to ~500 MB fit trivially;
practical limit is time, not format). The TS LT implementation remains only
for the legacy QR transport.

Optional (v2.1): pre-compress with the browser-native `CompressionStream`
('deflate-raw') before handing bytes to the core — zstd-in-wasm is not worth
+300 KB of binary when the platform ships a codec; flagged in the meta frame.

## Toolchain / CI

- Cargo workspace at repo root; `crates/packit-core`; `wasm-pack build
  --target web` emitting into `src/wasm/pkg/` (gitignored), invoked from an
  npm `build:wasm` script that `dev`/`build` depend on. wasm-pack installs via
  npm (prebuilt binary) so CI needs only `rustup target add wasm32-unknown-unknown`.
- No wasm threads (GitHub Pages cannot set COOP/COEP → no SharedArrayBuffer).
  SIMD128 allowed. Single `decode_frame` call per camera frame.
- Tests: the codec's correctness lives in **`cargo test`** with a synthetic
  camera in Rust (render → perspective warp → color shift/noise/blur →
  decode), mirroring the acceptance style of the QR-mode TS tests. Vitest
  keeps the TS layers plus one wasm-loading smoke test. CI runs cargo test,
  vitest, and the wasm+vite build.

## Throughput model

7.4 KB/frame × 10 fps effective = 74 KB/s; × 15 fps = 111 KB/s ≈ **100×**
current defaults. Cimbar's measured 106 KB/s on a Snapdragon 625 says the
format supports this; our risk concentrates in browser-side capture (camera
exposure control and frame pacing via getUserMedia), not the codec.

## Milestones

| # | deliverable | acceptance |
|---|-------------|------------|
| M1 | workspace + packit-core skeleton + wasm build wired into vite/CI | app loads wasm, calls a version() export |
| M2 | tile codec encode/decode + RS | cargo synthetic-camera suite green (warp, rotations, noise, color shift, blur) |
| M3 | raptorq + framing + meta | cargo end-to-end: file → frames → lossy channel → file, crc verified |
| M4 | sender/receiver UI integration | manual: laptop↔phone transfer in tile mode; QR fallback intact |
| M5 | tuning: SIMD, drift field, fps/exposure controls | measured ≥ 10× QR mode on real hardware, iterate toward 100× |

## Known risks

- 8 px glyphs need ≈2 camera px per glyph px → 1080p+ capture and a
  reasonably steady hand; if field tests struggle, a 10 px-tile fallback mode
  halves density but relaxes optics.
- Rolling shutter mixing display frames: RS may rescue partially-mixed frames
  (unlike CRC-reject); worst case they drop, as today.
- Browser camera controls (exposure/focus lock) vary by platform; capture
  quality tuning is M5 work, guided by per-frame confidence stats exported
  from the core.
