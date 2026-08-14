# packit — Fountain Transfer

Air-gapped file transfer between machines using nothing but a **screen and a camera**, powered by [LT fountain codes](https://en.wikipedia.org/wiki/Luby_transform_code). Installable as a PWA and fully offline-capable.

**Live:** https://thetazero.github.io/packit/

## How it works

1. **Send** — the file is split into `k` fixed-size blocks. An LT encoder emits an endless stream of packets, each the XOR of a pseudo-random subset of blocks (degree drawn from a robust soliton distribution, derived deterministically from a 32-bit seed carried in the packet). Each packet is base45-encoded (QR alphanumeric charset, ~3% overhead) and rendered as a QR code, cycling at a configurable frame rate.
2. **Receive** — the camera scans whatever frames it manages to catch (native `BarcodeDetector` where available, `jsQR` fallback). A peeling decoder XORs out solved blocks; the fountain property means *any* sufficiently large subset of packets reconstructs the file — missed frames simply don't matter. Metadata packets (filename, MIME type, CRC32) are interleaved every 8th frame, and the checksum is verified on completion.

Typical throughput: block size × frame rate × ~0.85 decode efficiency — around **1–2 KB/s** at defaults. Great for keys, configs, documents; patience required for megabytes.

## Develop

```sh
npm install
npm run dev     # HTTPS dev server (self-signed) so phones on the LAN can use the camera
npm test        # fountain code / packet format unit tests
npm run build   # type-check + production build to dist/
npm run icons   # regenerate PWA icons (no image deps — hand-rolled PNG writer)
```

Camera access requires a secure context: use the HTTPS dev server, `localhost`, or the deployed Pages site.

## Tile mode

The default transport is a custom high-density optical code — a 128×128 grid
of 8×8-pixel glyph tiles (16 shapes × 4 colors = 6 bits/tile), with corner
bullseye anchors, an alignment-dot lattice, interleaved RS(155,125) error
correction, and a RaptorQ (RFC 6330) fountain — carrying **~9.6 KB per frame**
vs QR's 256 bytes. The codec is a Rust crate (`crates/packit-core`) compiled
to WebAssembly and shared by sender and receiver; design and rationale live in
[docs/tile-mode-spec.md](docs/tile-mode-spec.md). It is cimbar-inspired but
not wire-compatible. QR mode remains the compatibility fallback and the
receiver auto-detects which transport it is looking at.

Tile mode needs the code to span ≳820 pixels in the camera frame (2×2-px
glyph blocks fall below Nyquist under ~0.8× scale) — hold the phone close.
