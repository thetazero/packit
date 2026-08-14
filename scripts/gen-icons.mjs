// Generates PWA icons as PNGs without any image library: raw RGBA pixels,
// zlib-deflated, wrapped in hand-written PNG chunks.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const o = row + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Icon: indigo→teal gradient with a stylized 3x3 QR-finder motif.
function iconPixel(size) {
  const cell = size / 12;
  // Squares (in 12x12 grid units): three QR finder corners + center dot.
  const squares = [
    [2, 2, 3],
    [7, 2, 3],
    [2, 7, 3],
    [7.75, 7.75, 1.5],
  ];
  return (x, y) => {
    const t = (x + y) / (2 * size);
    let r = Math.round(0x2b + (0x37 - 0x2b) * t);
    let g = Math.round(0x3f + (0xd5 - 0x3f) * t);
    let b = Math.round(0xd8 + (0xc8 - 0xd8) * t);
    // Rounded-corner mask for maskable-friendly full-bleed icon.
    for (const [sx, sy, s] of squares) {
      const x0 = sx * cell;
      const y0 = sy * cell;
      const s0 = s * cell;
      if (x >= x0 && x < x0 + s0 && y >= y0 && y < y0 + s0) {
        const inner = s >= 3 && x >= x0 + cell && x < x0 + s0 - cell && y >= y0 + cell && y < y0 + s0 - cell;
        const core =
          s >= 3 &&
          x >= x0 + 1.6 * cell &&
          x < x0 + s0 - 1.6 * cell &&
          y >= y0 + 1.6 * cell &&
          y < y0 + s0 - 1.6 * cell;
        if (!inner || core) return [255, 255, 255, 255];
      }
    }
    return [r, g, b, 255];
  };
}

mkdirSync(new URL("../public/icons/", import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  const buf = png(size, iconPixel(size));
  writeFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url), buf);
  console.log(`icon-${size}.png (${buf.length} bytes)`);
}
