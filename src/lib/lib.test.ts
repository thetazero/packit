import { describe, expect, it } from "vitest";
import { LTDecoder, LTEncoder } from "./lt";
import { base45Decode, base45Encode } from "./base45";
import { crc32 } from "./crc32";
import { mulberry32 } from "./prng";
import { parsePacket, serializeDataPacket, serializeMetaPacket } from "./packet";

function randomBytes(n: number, seed = 42): Uint8Array {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256);
  return out;
}

describe("base45", () => {
  it("round-trips arbitrary bytes", () => {
    for (const n of [0, 1, 2, 3, 100, 255, 256, 1000]) {
      const data = randomBytes(n, n + 1);
      const encoded = base45Encode(data);
      expect(base45Decode(encoded)).toEqual(data);
    }
  });

  it("uses only the QR alphanumeric charset", () => {
    const encoded = base45Encode(randomBytes(500));
    expect(encoded).toMatch(/^[0-9A-Z $%*+\-./:]*$/);
  });

  it("matches RFC 9285 vectors", () => {
    expect(base45Encode(new TextEncoder().encode("AB"))).toBe("BB8");
    expect(base45Encode(new TextEncoder().encode("Hello!!"))).toBe("%69 VD92EX0");
  });
});

describe("crc32", () => {
  it("matches known value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("packets", () => {
  it("round-trips data packets", () => {
    const payload = randomBytes(256);
    const text = serializeDataPacket({
      fileId: 0xdeadbeef,
      k: 123,
      blockSize: 256,
      fileSize: 31337,
      seed: 0x12345678,
      payload,
    });
    const parsed = parsePacket(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("data");
    if (parsed!.type === "data") {
      expect(parsed!.fileId).toBe(0xdeadbeef);
      expect(parsed!.k).toBe(123);
      expect(parsed!.blockSize).toBe(256);
      expect(parsed!.fileSize).toBe(31337);
      expect(parsed!.seed).toBe(0x12345678);
      expect(parsed!.payload).toEqual(payload);
    }
  });

  it("round-trips meta packets", () => {
    const text = serializeMetaPacket({
      fileId: 7,
      k: 10,
      blockSize: 128,
      fileSize: 1234,
      crc: 0xabcdef01,
      name: "héllo wörld.png",
      mime: "image/png",
    });
    const parsed = parsePacket(text);
    expect(parsed).not.toBeNull();
    if (parsed!.type === "meta") {
      expect(parsed!.name).toBe("héllo wörld.png");
      expect(parsed!.mime).toBe("image/png");
      expect(parsed!.crc).toBe(0xabcdef01);
    } else {
      throw new Error("expected meta packet");
    }
  });

  it("rejects garbage", () => {
    expect(parsePacket("HELLO WORLD")).toBeNull();
    expect(parsePacket("not base45 at all!!! ~~~")).toBeNull();
  });
});

describe("LT fountain codes", () => {
  it("round-trips with sequential packets", () => {
    const file = randomBytes(10_000, 7);
    const enc = new LTEncoder(file, 256);
    const dec = new LTDecoder(enc.k, enc.blockSize, enc.fileSize);
    let seed = 1000;
    while (!dec.done) {
      dec.addPacket(seed, enc.encode(seed));
      seed++;
      if (seed > 1000 + enc.k * 10) throw new Error("decode did not converge");
    }
    expect(dec.assemble()).toEqual(file);
  });

  it("survives heavy random packet loss", () => {
    const file = randomBytes(50_000, 9);
    const enc = new LTEncoder(file, 256);
    const dec = new LTDecoder(enc.k, enc.blockSize, enc.fileSize);
    const rnd = mulberry32(1234);
    let seed = 5000;
    let received = 0;
    while (!dec.done) {
      seed++;
      if (rnd() < 0.6) continue; // drop 60% of frames
      dec.addPacket(seed, enc.encode(seed));
      received++;
      if (received > enc.k * 10) throw new Error("decode did not converge");
    }
    expect(dec.assemble()).toEqual(file);
    // Overhead should be modest: LT typically needs ~5-15% extra packets.
    expect(dec.packetsUsed).toBeLessThan(enc.k * 1.6);
  });

  it("handles tiny files (k=1) and non-block-aligned sizes", () => {
    for (const n of [1, 100, 255, 256, 257, 4097]) {
      const file = randomBytes(n, n);
      const enc = new LTEncoder(file, 256);
      const dec = new LTDecoder(enc.k, enc.blockSize, enc.fileSize);
      let seed = 1;
      while (!dec.done) {
        dec.addPacket(seed, enc.encode(seed));
        seed++;
        if (seed > 1000) throw new Error("decode did not converge");
      }
      expect(dec.assemble()).toEqual(file);
    }
  });

  it("ignores duplicate seeds", () => {
    const file = randomBytes(2048, 3);
    const enc = new LTEncoder(file, 256);
    const dec = new LTDecoder(enc.k, enc.blockSize, enc.fileSize);
    dec.addPacket(1, enc.encode(1));
    expect(dec.addPacket(1, enc.encode(1))).toBe(false);
    expect(dec.duplicates).toBe(1);
  });
});
