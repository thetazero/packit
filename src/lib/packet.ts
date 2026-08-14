import { base45Decode, base45Encode } from "./base45";

/**
 * Wire format (binary, little-endian, then base45-encoded into the QR):
 *
 * Data packet (0xd1):
 *   u8 magic | u32 fileId | u16 k | u16 blockSize | u32 fileSize | u32 seed | payload[blockSize]
 *
 * Meta packet (0xd2):
 *   u8 magic | u32 fileId | u16 k | u16 blockSize | u32 fileSize | u32 crc32
 *   | u8 nameLen | name | u8 mimeLen | mime
 *
 * Every data packet carries (k, blockSize, fileSize) so a receiver joining
 * mid-stream can start decoding immediately; the meta packet (interleaved
 * periodically by the sender) adds filename, mime type, and checksum.
 */

const DATA_MAGIC = 0xd1;
const META_MAGIC = 0xd2;
const DATA_HEADER = 17;

export interface DataPacket {
  type: "data";
  fileId: number;
  k: number;
  blockSize: number;
  fileSize: number;
  seed: number;
  payload: Uint8Array;
}

export interface MetaPacket {
  type: "meta";
  fileId: number;
  k: number;
  blockSize: number;
  fileSize: number;
  crc: number;
  name: string;
  mime: string;
}

export type Packet = DataPacket | MetaPacket;

export function serializeDataPacket(p: Omit<DataPacket, "type">): string {
  const buf = new Uint8Array(DATA_HEADER + p.payload.length);
  const view = new DataView(buf.buffer);
  view.setUint8(0, DATA_MAGIC);
  view.setUint32(1, p.fileId, true);
  view.setUint16(5, p.k, true);
  view.setUint16(7, p.blockSize, true);
  view.setUint32(9, p.fileSize, true);
  view.setUint32(13, p.seed, true);
  buf.set(p.payload, DATA_HEADER);
  return base45Encode(buf);
}

export function serializeMetaPacket(p: Omit<MetaPacket, "type">): string {
  const enc = new TextEncoder();
  const name = enc.encode(p.name).slice(0, 255);
  const mime = enc.encode(p.mime).slice(0, 255);
  const buf = new Uint8Array(17 + 1 + name.length + 1 + mime.length);
  const view = new DataView(buf.buffer);
  view.setUint8(0, META_MAGIC);
  view.setUint32(1, p.fileId, true);
  view.setUint16(5, p.k, true);
  view.setUint16(7, p.blockSize, true);
  view.setUint32(9, p.fileSize, true);
  view.setUint32(13, p.crc, true);
  let o = 17;
  buf[o++] = name.length;
  buf.set(name, o);
  o += name.length;
  buf[o++] = mime.length;
  buf.set(mime, o);
  return base45Encode(buf);
}

export function parsePacket(text: string): Packet | null {
  let buf: Uint8Array;
  try {
    buf = base45Decode(text);
  } catch {
    return null;
  }
  if (buf.length < DATA_HEADER) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint8(0);
  const common = {
    fileId: view.getUint32(1, true),
    k: view.getUint16(5, true),
    blockSize: view.getUint16(7, true),
    fileSize: view.getUint32(9, true),
  };
  if (common.k === 0 || common.blockSize === 0) return null;

  if (magic === DATA_MAGIC) {
    if (buf.length < DATA_HEADER + common.blockSize) return null;
    return {
      type: "data",
      ...common,
      seed: view.getUint32(13, true),
      payload: buf.slice(DATA_HEADER, DATA_HEADER + common.blockSize),
    };
  }
  if (magic === META_MAGIC) {
    const dec = new TextDecoder();
    let o = 17;
    const nameLen = view.getUint8(o++);
    if (o + nameLen > buf.length) return null;
    const name = dec.decode(buf.subarray(o, o + nameLen));
    o += nameLen;
    if (o >= buf.length) return null;
    const mimeLen = view.getUint8(o++);
    if (o + mimeLen > buf.length) return null;
    const mime = dec.decode(buf.subarray(o, o + mimeLen));
    return {
      type: "meta",
      ...common,
      crc: view.getUint32(13, true),
      name,
      mime,
    };
  }
  return null;
}
