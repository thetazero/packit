//! Reed-Solomon layer: RS(155,125) blocks (30 ecc bytes, corrects <= 15 byte
//! errors per block), block-interleaved so spatially clustered tile damage
//! spreads across blocks.

use reed_solomon::{Decoder, Encoder};

pub const BLOCK: usize = 155;
pub const ECC: usize = 30;
pub const BLOCK_DATA: usize = BLOCK - ECC; // 125

/// Data bytes that fit in `raw` coded bytes (77 full blocks + one shortened).
pub fn data_capacity(raw: usize) -> usize {
    let full = raw / BLOCK;
    let rem = raw % BLOCK;
    // A shortened trailing block still carries full ECC.
    full * BLOCK_DATA + rem.saturating_sub(ECC)
}

fn block_lens(raw: usize) -> Option<Vec<usize>> {
    let full = raw / BLOCK;
    let rem = raw % BLOCK;
    let mut lens = vec![BLOCK; full];
    if rem > 0 {
        if rem <= ECC {
            return None; // trailing block too short to carry ECC
        }
        lens.push(rem);
    }
    Some(lens)
}

/// data.len() must equal data_capacity(raw); returns exactly `raw` bytes.
pub fn encode(data: &[u8], raw: usize) -> Vec<u8> {
    assert_eq!(data.len(), data_capacity(raw));
    let enc = Encoder::new(ECC);
    let lens = block_lens(raw).expect("invalid raw capacity for RS layout");
    let mut blocks: Vec<Vec<u8>> = Vec::with_capacity(lens.len());
    let mut off = 0;
    for &len in &lens {
        let dlen = len - ECC;
        let coded = enc.encode(&data[off..off + dlen]);
        blocks.push(coded.to_vec());
        off += dlen;
    }
    interleave(&blocks, raw)
}

/// Inverse of `encode`; returns None if any block is uncorrectable.
pub fn decode(raw_bytes: &[u8]) -> Option<Vec<u8>> {
    let raw = raw_bytes.len();
    let lens = block_lens(raw)?;
    let blocks = deinterleave(raw_bytes, &lens);
    let dec = Decoder::new(ECC);
    let mut out = Vec::with_capacity(data_capacity(raw));
    for b in &blocks {
        let fixed = dec.correct(b, None).ok()?;
        out.extend_from_slice(fixed.data());
    }
    Some(out)
}

/// Column-major transmission: byte j of every block, then byte j+1, ...
fn interleave(blocks: &[Vec<u8>], raw: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw);
    for j in 0..BLOCK {
        for b in blocks {
            if j < b.len() {
                out.push(b[j]);
            }
        }
    }
    out
}

fn deinterleave(bytes: &[u8], lens: &[usize]) -> Vec<Vec<u8>> {
    let mut blocks: Vec<Vec<u8>> = lens.iter().map(|&l| Vec::with_capacity(l)).collect();
    let mut it = bytes.iter();
    for j in 0..BLOCK {
        for (b, &len) in blocks.iter_mut().zip(lens) {
            if j < len {
                // Length invariants guarantee the iterator is long enough.
                if let Some(&v) = it.next() {
                    b.push(v);
                }
            }
        }
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_capacity() {
        let raw = 11_972;
        assert_eq!(data_capacity(raw), 77 * 125 + (11_972 - 77 * 155) - 30);
        let cap = data_capacity(raw);
        let data: Vec<u8> = (0..cap).map(|i| (i * 31 % 251) as u8).collect();
        let coded = encode(&data, raw);
        assert_eq!(coded.len(), raw);
        assert_eq!(decode(&coded).unwrap(), data);
    }

    #[test]
    fn corrects_clustered_errors() {
        let raw = 11_972;
        let cap = data_capacity(raw);
        let data: Vec<u8> = (0..cap).map(|i| (i * 7 % 256) as u8).collect();
        let mut coded = encode(&data, raw);
        // A contiguous 600-byte smudge: interleaving spreads it to <= ~8
        // errors per block, well under t=15.
        for i in 3000..3600 {
            coded[i] ^= 0x5a;
        }
        assert_eq!(decode(&coded).unwrap(), data);
    }

    #[test]
    fn rejects_overwhelming_damage() {
        let raw = 1550;
        let cap = data_capacity(raw);
        let data = vec![7u8; cap];
        let mut coded = encode(&data, raw);
        for (i, b) in coded.iter_mut().enumerate() {
            if i % 2 == 0 {
                *b ^= 0xff;
            }
        }
        assert!(decode(&coded).is_none());
    }
}
