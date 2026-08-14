import { describe, expect, it } from "vitest";
import { base45Decode, base45Encode } from "./base45";
import { parsePacket, serializeDataPacket, serializeMetaPacket } from "./packet";
import { LTDecoder, LTEncoder } from "./lt";
import { mulberry32 } from "./prng";

function randomBytes(n: number, seed = 1): Uint8Array {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256);
  return out;
}

describe("base45 error handling", () => {
  it("rejects length ≡ 1 (mod 3)", () => {
    expect(() => base45Decode("A")).toThrow();
    expect(() => base45Decode("ABCD")).toThrow();
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => base45Decode("ab!")).toThrow();
    expect(() => base45Decode("A#0")).toThrow();
  });

  it("rejects triplets that overflow 16 bits", () => {
    // ":::" decodes to 44 + 44*45 + 44*2025 = 91124 > 0xffff
    expect(() => base45Decode(":::")).toThrow();
  });

  it("rejects pairs that overflow 8 bits", () => {
    // "::" decodes to 44 + 44*45 = 2024 > 0xff
    expect(() => base45Decode("::")).toThrow();
  });
});

describe("packet robustness", () => {
  const valid = serializeDataPacket({
    fileId: 1,
    k: 4,
    blockSize: 64,
    fileSize: 200,
    seed: 9,
    payload: randomBytes(64),
  });

  it("rejects truncated packets", () => {
    // Any prefix short enough to lose payload bytes must not parse as data.
    const truncated = valid.slice(0, Math.floor(valid.length / 2) - ((valid.length / 2) % 3));
    for (const text of ["", "AAA", truncated]) {
      const p = parsePacket(text);
      expect(p?.type === "data").toBe(false);
    }
  });

  it("rejects unknown magic bytes", () => {
    const raw = base45Decode(valid);
    raw[0] = 0x77;
    expect(parsePacket(base45Encode(raw))).toBeNull();
  });

  it("rejects zero k or blockSize", () => {
    const raw = base45Decode(valid);
    const view = new DataView(raw.buffer, raw.byteOffset);
    view.setUint16(5, 0, true); // k = 0
    expect(parsePacket(base45Encode(raw))).toBeNull();
  });

  it("truncates over-long filenames instead of corrupting", () => {
    const name = "x".repeat(400) + ".bin";
    const text = serializeMetaPacket({
      fileId: 2,
      k: 3,
      blockSize: 64,
      fileSize: 100,
      crc: 0,
      name,
      mime: "application/octet-stream",
    });
    const parsed = parsePacket(text);
    expect(parsed?.type).toBe("meta");
    if (parsed?.type === "meta") {
      expect(parsed.name.length).toBeLessThanOrEqual(255);
      expect(parsed.name).toBe(name.slice(0, parsed.name.length));
      expect(parsed.mime).toBe("application/octet-stream");
    }
  });

  it("survives random garbage without throwing", () => {
    const rnd = mulberry32(77);
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
    for (let trial = 0; trial < 500; trial++) {
      const len = Math.floor(rnd() * 60) * 3;
      let s = "";
      for (let i = 0; i < len; i++) s += chars[Math.floor(rnd() * chars.length)];
      expect(() => parsePacket(s)).not.toThrow();
    }
  });
});

describe("LT decoder robustness", () => {
  it("throws on assemble before completion", () => {
    const dec = new LTDecoder(10, 64, 640);
    expect(() => dec.assemble()).toThrow();
  });

  it("ignores packets after completion", () => {
    const file = randomBytes(500, 5);
    const enc = new LTEncoder(file, 64);
    const dec = new LTDecoder(enc.k, enc.blockSize, enc.fileSize);
    let seed = 0;
    while (!dec.done) dec.addPacket(seed++, enc.encode(seed - 1));
    const used = dec.packetsUsed;
    expect(dec.addPacket(seed + 1000, enc.encode(seed + 1000))).toBe(false);
    expect(dec.packetsUsed).toBe(used);
    expect(dec.assemble()).toEqual(file);
  });

  it("decodes even when packets arrive in reverse order", () => {
    const file = randomBytes(5000, 11);
    const enc = new LTEncoder(file, 128);
    const dec = new LTDecoder(enc.k, enc.blockSize, enc.fileSize);
    const seeds = Array.from({ length: enc.k * 3 }, (_, i) => 42_000 + i).reverse();
    for (const seed of seeds) {
      if (dec.done) break;
      dec.addPacket(seed, enc.encode(seed));
    }
    expect(dec.done).toBe(true);
    expect(dec.assemble()).toEqual(file);
  });

  it("handles a larger file (k ≈ 2000) with loss", () => {
    const file = randomBytes(250_000, 13);
    const enc = new LTEncoder(file, 128);
    expect(enc.k).toBeGreaterThan(1900);
    const dec = new LTDecoder(enc.k, enc.blockSize, enc.fileSize);
    const rnd = mulberry32(4321);
    let seed = 0;
    let received = 0;
    while (!dec.done) {
      seed++;
      if (rnd() < 0.3) continue;
      dec.addPacket(seed, enc.encode(seed));
      received++;
      if (received > enc.k * 5) throw new Error("decode did not converge");
    }
    expect(dec.assemble()).toEqual(file);
  });
});
