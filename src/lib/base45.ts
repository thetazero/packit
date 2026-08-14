/**
 * Base45 (RFC 9285). Its alphabet is exactly the QR alphanumeric charset, so
 * encoded packets fit QR alphanumeric mode (~3% overhead vs raw byte mode) and
 * survive every QR scanner's string decoding, unlike raw binary payloads.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const REVERSE = new Map<string, number>([...ALPHABET].map((ch, i) => [ch, i]));

export function base45Encode(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const v = bytes[i] * 256 + bytes[i + 1];
    out.push(ALPHABET[v % 45], ALPHABET[Math.floor(v / 45) % 45], ALPHABET[Math.floor(v / 2025)]);
  }
  if (bytes.length % 2 === 1) {
    const v = bytes[bytes.length - 1];
    out.push(ALPHABET[v % 45], ALPHABET[Math.floor(v / 45)]);
  }
  return out.join("");
}

export function base45Decode(text: string): Uint8Array {
  const rem = text.length % 3;
  if (rem === 1) throw new Error("invalid base45 length");
  const out = new Uint8Array(Math.floor(text.length / 3) * 2 + (rem === 2 ? 1 : 0));
  let o = 0;
  const val = (ch: string): number => {
    const v = REVERSE.get(ch);
    if (v === undefined) throw new Error(`invalid base45 char: ${ch}`);
    return v;
  };
  for (let i = 0; i + 2 < text.length + 1; i += 3) {
    if (i + 3 <= text.length) {
      const v = val(text[i]) + val(text[i + 1]) * 45 + val(text[i + 2]) * 2025;
      if (v > 0xffff) throw new Error("invalid base45 triplet");
      out[o++] = v >> 8;
      out[o++] = v & 0xff;
    } else {
      const v = val(text[i]) + val(text[i + 1]) * 45;
      if (v > 0xff) throw new Error("invalid base45 pair");
      out[o++] = v;
    }
  }
  return out;
}
