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

## Roadmap

- Audio transport (the packet layer is transport-agnostic — an audio modem can slot in beside QR)
- Multi-QR grids per frame for higher throughput
