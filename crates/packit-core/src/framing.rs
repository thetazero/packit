//! Frame payload format (pre-RS byte stream):
//!
//! ```text
//! u8 magic 0xC7 | u8 version | u8 flags (bit0 = meta) | u32 fileId LE
//! | 12B raptorq OTI | u16 payload_len LE | payload | PRNG padding
//! ```
//!
//! Data frames: payload is one serialized raptorq EncodingPacket.
//! Meta frames: payload is `u64 fileLen | u32 crc32 | u8 nameLen | name
//! | u8 mimeLen | mime`. The OTI rides in every frame so a receiver joining
//! mid-stream can construct its fountain decoder from any single frame.

pub const MAGIC: u8 = 0xc7;
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 1 + 1 + 1 + 4 + 12 + 2; // 21

pub struct FrameHeader {
    pub is_meta: bool,
    pub file_id: u32,
    pub oti: [u8; 12],
}

pub fn build_frame(header: &FrameHeader, payload: &[u8], capacity: usize) -> Vec<u8> {
    assert!(HEADER_LEN + payload.len() <= capacity, "payload exceeds frame capacity");
    let mut out = Vec::with_capacity(capacity);
    out.push(MAGIC);
    out.push(VERSION);
    out.push(u8::from(header.is_meta));
    out.extend_from_slice(&header.file_id.to_le_bytes());
    out.extend_from_slice(&header.oti);
    out.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    out.extend_from_slice(payload);
    // PRNG padding keeps unused tiles visually varied (flat regions stress
    // the receiver's adaptive threshold).
    let mut state = 0x9e3779b9u32 ^ (payload.len() as u32);
    while out.len() < capacity {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        out.push((state >> 24) as u8);
    }
    out
}

pub fn parse_frame(bytes: &[u8]) -> Option<(FrameHeader, &[u8])> {
    if bytes.len() < HEADER_LEN || bytes[0] != MAGIC || bytes[1] != VERSION {
        return None;
    }
    let flags = bytes[2];
    let file_id = u32::from_le_bytes(bytes[3..7].try_into().ok()?);
    let oti: [u8; 12] = bytes[7..19].try_into().ok()?;
    let len = u16::from_le_bytes(bytes[19..21].try_into().ok()?) as usize;
    if HEADER_LEN + len > bytes.len() {
        return None;
    }
    Some((
        FrameHeader { is_meta: flags & 1 == 1, file_id, oti },
        &bytes[HEADER_LEN..HEADER_LEN + len],
    ))
}

pub struct Meta {
    pub file_len: u64,
    pub crc: u32,
    pub name: String,
    pub mime: String,
}

pub fn build_meta(meta: &Meta) -> Vec<u8> {
    let name = meta.name.as_bytes();
    let mime = meta.mime.as_bytes();
    let name_len = name.len().min(255);
    let mime_len = mime.len().min(255);
    let mut out = Vec::with_capacity(14 + name_len + mime_len);
    out.extend_from_slice(&meta.file_len.to_le_bytes());
    out.extend_from_slice(&meta.crc.to_le_bytes());
    out.push(name_len as u8);
    out.extend_from_slice(&name[..name_len]);
    out.push(mime_len as u8);
    out.extend_from_slice(&mime[..mime_len]);
    out
}

pub fn parse_meta(bytes: &[u8]) -> Option<Meta> {
    if bytes.len() < 14 {
        return None;
    }
    let file_len = u64::from_le_bytes(bytes[0..8].try_into().ok()?);
    let crc = u32::from_le_bytes(bytes[8..12].try_into().ok()?);
    let name_len = bytes[12] as usize;
    let name_end = 13 + name_len;
    if name_end >= bytes.len() {
        return None;
    }
    let mime_len = bytes[name_end] as usize;
    let mime_end = name_end + 1 + mime_len;
    if mime_end > bytes.len() {
        return None;
    }
    Some(Meta {
        file_len,
        crc,
        name: String::from_utf8_lossy(&bytes[13..name_end]).into_owned(),
        mime: String::from_utf8_lossy(&bytes[name_end + 1..mime_end]).into_owned(),
    })
}

const CRC_TABLE: [u32; 256] = build_crc_table();

const fn build_crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut i = 0;
        while i < 8 {
            c = if c & 1 == 1 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            i += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &b in bytes {
        crc = CRC_TABLE[((crc ^ b as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffff_ffff
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_known_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn frame_roundtrip() {
        let header = FrameHeader { is_meta: false, file_id: 42, oti: [7; 12] };
        let payload = vec![1u8, 2, 3, 4, 5];
        let frame = build_frame(&header, &payload, 100);
        assert_eq!(frame.len(), 100);
        let (h, p) = parse_frame(&frame).unwrap();
        assert!(!h.is_meta);
        assert_eq!(h.file_id, 42);
        assert_eq!(h.oti, [7; 12]);
        assert_eq!(p, &payload[..]);
    }

    #[test]
    fn meta_roundtrip() {
        let m = Meta { file_len: 123_456, crc: 0xdead_beef, name: "héllo.png".into(), mime: "image/png".into() };
        let parsed = parse_meta(&build_meta(&m)).unwrap();
        assert_eq!(parsed.file_len, 123_456);
        assert_eq!(parsed.crc, 0xdead_beef);
        assert_eq!(parsed.name, "héllo.png");
        assert_eq!(parsed.mime, "image/png");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_frame(&[0u8; 30]).is_none());
        assert!(parse_frame(&[]).is_none());
        assert!(parse_meta(&[1, 2, 3]).is_none());
    }
}
