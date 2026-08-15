# packit — Fountain Transfer

Air-gapped file transfer between machines using nothing but a **screen and a camera**, powered by [fountain codes](https://en.wikipedia.org/wiki/Fountain_code). Installable as a PWA and fully offline-capable.

**Live:** https://thetazero.github.io/packit/

## How it works

1. **Send** — the file is encoded with a RaptorQ (RFC 6330) fountain and rendered as a stream of high-density optical frames, cycling at a configurable frame rate.
2. **Receive** — the camera scans whatever frames it manages to catch; the fountain property means *any* sufficiently large subset of frames reconstructs the file — missed frames simply don't matter. Metadata (filename, MIME type) is interleaved periodically, and the checksum is verified on completion.

## The optical code

Each frame is a custom high-density code — a 128×128 grid of 8×8-pixel glyph
tiles (16 shapes × 4 colors = 6 bits/tile), with corner bullseye anchors, an
alignment-dot lattice, interleaved RS(155,125) error correction, and a RaptorQ
fountain — carrying **~9.6 KB per frame**. The codec is a Rust crate
(`crates/packit-core`) compiled to WebAssembly and shared by sender and
receiver; design and rationale live in
[docs/tile-mode-spec.md](docs/tile-mode-spec.md). It is cimbar-inspired but
not wire-compatible.

The code needs to span ≳820 pixels in the camera frame (2×2-px glyph blocks
fall below Nyquist under ~0.8× scale) — hold the phone close.

## Develop

```sh
npm install
git config core.hooksPath .githooks   # pre-push hook: refuses pushes to main without a version bump
npm run dev     # HTTPS dev server (self-signed) so phones on the LAN can use the camera
npm test        # wasm codec smoke tests
npm run build   # builds the wasm codec, type-checks, and bundles to dist/
npm run icons   # regenerate PWA icons (no image deps — hand-rolled PNG writer)
```

Camera access requires a secure context: use the HTTPS dev server, `localhost`, or the deployed Pages site.
