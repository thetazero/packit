//! 16-symbol glyph alphabet: 8x8 pixel bitmaps built from 2x2-pixel blocks,
//! i.e. 4x4 block patterns taken from the weight-8 codewords of the
//! Reed-Muller RM(1,4) code. Pairwise block distance >= 8 gives pixel
//! Hamming distance >= 32 of 64 (nearest-match corrects up to 15 flipped
//! pixels), and every glyph lights exactly 32 of 64 pixels, which keeps tile
//! brightness uniform for color classification.

/// Bit (y*8 + x) set means pixel (x, y) is "on".
pub const GLYPHS: [u64; 16] = build_glyphs();

const fn build_glyphs() -> [u64; 16] {
    let mut out = [0u64; 16];
    let mut s = 0;
    while s < 16 {
        // Codeword: block i is on iff parity(a & i) ^ a0, with a in 1..=8.
        let a = (s / 2) + 1usize;
        let a0 = s % 2;
        let mut bits: u64 = 0;
        let mut i = 0;
        while i < 16 {
            let on = ((a & i).count_ones() as usize + a0) % 2;
            if on == 1 {
                let bx = i % 4;
                let by = i / 4;
                // Expand the block to 2x2 pixels.
                let mut dy = 0;
                while dy < 2 {
                    let mut dx = 0;
                    while dx < 2 {
                        let x = bx * 2 + dx;
                        let y = by * 2 + dy;
                        bits |= 1u64 << (y * 8 + x);
                        dx += 1;
                    }
                    dy += 1;
                }
            }
            i += 1;
        }
        out[s] = bits;
        s += 1;
    }
    out
}

/// The 4x4 block pattern of each glyph (bit by*4+bx). The decoder samples
/// block centers (the farthest points from blurred block edges), so matching
/// happens in this 16-bit space: min pairwise distance 8, corrects 3 flips.
pub const BLOCK_GLYPHS: [u16; 16] = build_block_glyphs();

const fn build_block_glyphs() -> [u16; 16] {
    let mut out = [0u16; 16];
    let mut s = 0;
    while s < 16 {
        let mut bits: u16 = 0;
        let mut i = 0;
        while i < 16 {
            // Pixel (bx*2, by*2) represents block i = by*4+bx.
            let x = (i % 4) * 2;
            let y = (i / 4) * 2;
            if GLYPHS[s] >> (y * 8 + x) & 1 == 1 {
                bits |= 1 << i;
            }
            i += 1;
        }
        out[s] = bits;
        s += 1;
    }
    out
}

/// Index of the nearest glyph by block-pattern Hamming distance, plus the
/// distance itself (the caller can use the margin as confidence).
pub fn nearest_glyph(pattern: u16) -> (u8, u32) {
    let mut best = 0u8;
    let mut best_d = u32::MAX;
    for (i, g) in BLOCK_GLYPHS.iter().enumerate() {
        let d = (pattern ^ g).count_ones();
        if d < best_d {
            best_d = d;
            best = i as u8;
        }
    }
    (best, best_d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn min_pairwise_distance_at_least_20() {
        let mut min = u32::MAX;
        for i in 0..16 {
            for j in (i + 1)..16 {
                min = min.min((GLYPHS[i] ^ GLYPHS[j]).count_ones());
            }
        }
        assert!(min >= 20, "min pairwise distance {min} < 20");
    }

    #[test]
    fn balanced_on_count() {
        for g in GLYPHS {
            assert_eq!(g.count_ones(), 32);
        }
    }
}
