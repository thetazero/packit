//! Synthetic camera for tests: projects a rendered frame into a larger
//! image through a homography, with per-channel gain/offset, noise, and
//! optional box blur. Deterministic (xorshift PRNG).

use crate::homography::{apply, solve, Pt};

pub struct Channel {
    pub out_w: usize,
    pub out_h: usize,
    /// Where the source corners (TL,TR,BR,BL of the 1024px frame) land in
    /// the output image. Rotate this list to simulate camera rotation.
    pub quad: [Pt; 4],
    pub gain: [f64; 3],
    pub offset: [f64; 3],
    pub noise: f64,
    pub blur: bool,
    pub seed: u32,
}

pub fn shoot(src: &[u8], src_w: usize, src_h: usize, ch: &Channel) -> Vec<u8> {
    let src_corners: [Pt; 4] = [
        (0.0, 0.0),
        (src_w as f64, 0.0),
        (src_w as f64, src_h as f64),
        (0.0, src_h as f64),
    ];
    // Map output pixel -> source pixel.
    let h = solve(&ch.quad, &src_corners).expect("degenerate quad");
    let mut out = vec![0u8; ch.out_w * ch.out_h * 4];
    let mut rng = ch.seed | 1;
    let mut next = move || {
        rng ^= rng << 13;
        rng ^= rng >> 17;
        rng ^= rng << 5;
        (rng >> 8) as f64 / (1 << 24) as f64 - 0.5
    };
    for y in 0..ch.out_h {
        for x in 0..ch.out_w {
            let (sx, sy) = apply(&h, x as f64 + 0.5, y as f64 + 0.5);
            let rgb = sample(src, src_w, src_h, sx, sy).unwrap_or([24.0, 22.0, 26.0]);
            let o = (y * ch.out_w + x) * 4;
            for c in 0..3 {
                let v = rgb[c] * ch.gain[c] + ch.offset[c] + next() * 2.0 * ch.noise;
                out[o + c] = v.clamp(0.0, 255.0) as u8;
            }
            out[o + 3] = 255;
        }
    }
    if ch.blur {
        box_blur(&out, ch.out_w, ch.out_h)
    } else {
        out
    }
}

fn sample(src: &[u8], w: usize, h: usize, x: f64, y: f64) -> Option<[f64; 3]> {
    if !(x >= 0.0 && y >= 0.0 && x < (w - 1) as f64 && y < (h - 1) as f64) {
        return None;
    }
    let x0 = x as usize;
    let y0 = y as usize;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let mut out = [0.0f64; 3];
    for (c, item) in out.iter_mut().enumerate() {
        let p = |xx: usize, yy: usize| src[(yy * w + xx) * 4 + c] as f64;
        *item = p(x0, y0) * (1.0 - fx) * (1.0 - fy)
            + p(x0 + 1, y0) * fx * (1.0 - fy)
            + p(x0, y0 + 1) * (1.0 - fx) * fy
            + p(x0 + 1, y0 + 1) * fx * fy;
    }
    Some(out)
}

fn box_blur(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = src.to_vec();
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            for c in 0..3 {
                let mut acc = 0u32;
                for dy in 0..3 {
                    for dx in 0..3 {
                        acc += src[((y + dy - 1) * w + x + dx - 1) * 4 + c] as u32;
                    }
                }
                out[(y * w + x) * 4 + c] = (acc / 9) as u8;
            }
        }
    }
    out
}
