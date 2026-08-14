import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { LTDecoder, LTEncoder } from "./lt";
import { crc32 } from "./crc32";
import { parsePacket, serializeDataPacket, serializeMetaPacket } from "./packet";
import { mulberry32 } from "./prng";

/**
 * Full-pipeline test: packet → real QR code → rasterized pixels → jsQR scan →
 * parse → LT decode. This exercises exactly what travels between the sender's
 * canvas and the receiver's camera, minus the optics.
 */

function qrRoundTrip(text: string): string | null {
  const qr = QRCode.create(text, { errorCorrectionLevel: "L" });
  const size = qr.modules.size;
  const scale = 4;
  const margin = 4 * scale;
  const dim = size * scale + margin * 2;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((margin + y * scale + dy) * dim + margin + x * scale + dx) * 4;
          rgba[px] = rgba[px + 1] = rgba[px + 2] = 0;
        }
      }
    }
  }
  const code = jsQR(rgba, dim, dim, { inversionAttempts: "dontInvert" });
  return code?.data ?? null;
}

function randomBytes(n: number, seed = 1): Uint8Array {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256);
  return out;
}

describe("QR end-to-end", () => {
  it("survives QR render + scan for a data packet", () => {
    const payload = randomBytes(256, 21);
    const text = serializeDataPacket({
      fileId: 0xcafebabe,
      k: 40,
      blockSize: 256,
      fileSize: 10_000,
      seed: 777,
      payload,
    });
    const scanned = qrRoundTrip(text);
    expect(scanned).toBe(text);
    const parsed = parsePacket(scanned!);
    expect(parsed?.type).toBe("data");
    if (parsed?.type === "data") {
      expect(parsed.seed).toBe(777);
      expect(parsed.payload).toEqual(payload);
    }
  });

  it("transfers a whole file through rendered-and-scanned QR codes", () => {
    const file = randomBytes(3000, 33);
    const enc = new LTEncoder(file, 128);
    const fileId = 42;

    // Interleave a meta packet like the sender does.
    const metaText = serializeMetaPacket({
      fileId,
      k: enc.k,
      blockSize: enc.blockSize,
      fileSize: enc.fileSize,
      crc: crc32(file),
      name: "photo.jpg",
      mime: "image/jpeg",
    });

    let decoder: LTDecoder | null = null;
    let metaSeen = false;
    let seed = 0;
    while (!decoder?.done || !metaSeen) {
      seed++;
      const text =
        seed % 8 === 0
          ? metaText
          : serializeDataPacket({
              fileId,
              k: enc.k,
              blockSize: enc.blockSize,
              fileSize: enc.fileSize,
              seed,
              payload: enc.encode(seed),
            });
      const scanned = qrRoundTrip(text);
      expect(scanned).toBe(text);
      const packet = parsePacket(scanned!);
      expect(packet).not.toBeNull();
      decoder ??= new LTDecoder(packet!.k, packet!.blockSize, packet!.fileSize);
      if (packet!.type === "meta") {
        metaSeen = true;
        expect(packet!.name).toBe("photo.jpg");
      } else {
        decoder.addPacket(packet!.seed, packet!.payload);
      }
      if (seed > enc.k * 10) throw new Error("transfer did not converge");
    }
    const received = decoder!.assemble();
    expect(received).toEqual(file);
    expect(crc32(received)).toBe(crc32(file));
  });

  it("keeps QR versions scannable at every block size setting", () => {
    for (const blockSize of [128, 256, 512]) {
      const text = serializeDataPacket({
        fileId: 1,
        k: 100,
        blockSize,
        fileSize: blockSize * 100,
        seed: 5,
        payload: randomBytes(blockSize, blockSize),
      });
      const qr = QRCode.create(text, { errorCorrectionLevel: "L" });
      // Version 25 (117x117 modules) is a practical ceiling for camera scans.
      expect(qr.version).toBeLessThanOrEqual(25);
      expect(qrRoundTrip(text)).toBe(text);
    }
  });
});
