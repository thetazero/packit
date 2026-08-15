//! Camera-frame decoder: RGBA in, pre-RS byte stream out.

use crate::geometry::*;
use crate::glyphs::nearest_glyph;
use crate::homography::{apply, solve, Pt};
use crate::rs_layer;

pub struct Frame<'a> {
    pub rgba: &'a [u8],
    pub w: usize,
    pub h: usize,
}

impl<'a> Frame<'a> {
    fn luma(&self, x: usize, y: usize) -> u32 {
        let o = (y * self.w + x) * 4;
        (self.rgba[o] as u32 + 2 * self.rgba[o + 1] as u32 + self.rgba[o + 2] as u32) / 4
    }

    fn bilinear(&self, x: f64, y: f64) -> Option<[f64; 3]> {
        if !(x >= 0.0 && y >= 0.0 && x < (self.w - 1) as f64 && y < (self.h - 1) as f64) {
            return None;
        }
        let x0 = x as usize;
        let y0 = y as usize;
        let fx = x - x0 as f64;
        let fy = y - y0 as f64;
        let mut out = [0.0f64; 3];
        for (c, item) in out.iter_mut().enumerate() {
            let p = |xx: usize, yy: usize| self.rgba[(yy * self.w + xx) * 4 + c] as f64;
            *item = p(x0, y0) * (1.0 - fx) * (1.0 - fy)
                + p(x0 + 1, y0) * fx * (1.0 - fy)
                + p(x0, y0 + 1) * (1.0 - fx) * fy
                + p(x0 + 1, y0 + 1) * fx * fy;
        }
        Some(out)
    }

    fn bilinear_luma(&self, x: f64, y: f64) -> Option<f64> {
        self.bilinear(x, y).map(|[r, g, b]| (r + 2.0 * g + b) / 4.0)
    }
}

/// Stage-by-stage diagnostics for tests.
/// All candidate clusters (x, y, module, votes), for diagnostics.
#[doc(hidden)]
pub fn debug_clusters(rgba: &[u8], w: usize, h: usize) -> Vec<(f64, f64, f64, u32)> {
    let frame = Frame { rgba, w, h };
    let binary = binarize(&frame);
    let mut clusters: Vec<Cand> = Vec::new();
    collect_candidates(&frame, &binary, &mut clusters);
    clusters.iter().map(|c| (c.x, c.y, c.m, c.votes)).collect()
}

#[doc(hidden)]
pub fn debug_stages(rgba: &[u8], w: usize, h: usize) -> String {
    let frame = Frame { rgba, w, h };
    let binary = binarize(&frame);
    let quads = find_anchor_quads(&frame, &binary);
    if quads.is_empty() {
        return "anchors: none".into();
    }
    for centers in quads.iter().take(6) {
        let Some(hgy) = orient(&frame, centers) else {
            continue;
        };
        let offsets = alignment_offsets(&frame, &hgy);
        let Some(calib) = calibrate(&frame, &hgy, &offsets) else {
            return "calibrate: failed".into();
        };
        let raw = sample_data(&frame, &hgy, &offsets, &calib);
        return match rs_layer::decode(&raw) {
            Some(_) => "ok".into(),
            None => format!("rs failed; centers {centers:?}"),
        };
    }
    "orient: failed on all quads".into()
}

/// Pre-RS sampled stream (first orient-passing quad), for diagnostics.
#[doc(hidden)]
pub fn sample_raw(rgba: &[u8], w: usize, h: usize) -> Option<Vec<u8>> {
    let frame = Frame { rgba, w, h };
    let binary = binarize(&frame);
    for centers in find_anchor_quads(&frame, &binary).into_iter().take(6) {
        let Some(hgy) = orient(&frame, &centers) else {
            continue;
        };
        let offsets = alignment_offsets(&frame, &hgy);
        let calib = calibrate(&frame, &hgy, &offsets)?;
        return Some(sample_data(&frame, &hgy, &offsets, &calib));
    }
    None
}

/// Full decode: returns the de-interleaved, RS-corrected byte stream.
pub fn decode_frame(rgba: &[u8], w: usize, h: usize) -> Option<Vec<u8>> {
    if rgba.len() < w * h * 4 || w < 64 || h < 64 {
        return None;
    }
    let frame = Frame { rgba, w, h };
    let binary = binarize(&frame);
    // Candidate anchor quads, best-first; the rotation-marker check inside
    // orient() rejects quads built from data-field false positives.
    for centers in find_anchor_quads(&frame, &binary).into_iter().take(6) {
        let Some(hgy) = orient(&frame, &centers) else {
            continue;
        };
        let offsets = alignment_offsets(&frame, &hgy);
        let Some(calib) = calibrate(&frame, &hgy, &offsets) else {
            continue;
        };
        let raw = sample_data(&frame, &hgy, &offsets, &calib);
        if let Some(data) = rs_layer::decode(&raw) {
            return Some(data);
        }
    }
    None
}

// ---------------------------------------------------------------- threshold

struct Binary {
    bits: Vec<u8>,
    w: usize,
}

impl Binary {
    fn bright(&self, x: usize, y: usize) -> bool {
        self.bits[y * self.w + x] == 1
    }
}

fn binarize(f: &Frame) -> Binary {
    let (w, h) = (f.w, f.h);
    // Luma plane + histogram percentiles for a global floor.
    let mut luma = vec![0u8; w * h];
    let mut hist = [0u32; 256];
    for y in 0..h {
        for x in 0..w {
            let v = f.luma(x, y) as u8;
            luma[y * w + x] = v;
            hist[v as usize] += 1;
        }
    }
    let total = (w * h) as u32;
    let pct = |p: u32| {
        let target = total / 100 * p;
        let mut acc = 0u32;
        for (v, &c) in hist.iter().enumerate() {
            acc += c;
            if acc >= target {
                return v as u32;
            }
        }
        255
    };
    let lo = pct(5);
    let hi = pct(95);
    let floor = lo + (hi - lo) * 3 / 10;

    // Integral image for a local mean over a window ~ min(w,h)/16.
    let mut integral = vec![0u64; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0u64;
        for x in 0..w {
            row += luma[y * w + x] as u64;
            integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
        }
    }
    let half = (w.min(h) / 32).max(8);
    let mut bits = vec![0u8; w * h];
    for y in 0..h {
        let y0 = y.saturating_sub(half);
        let y1 = (y + half + 1).min(h);
        for x in 0..w {
            let x0 = x.saturating_sub(half);
            let x1 = (x + half + 1).min(w);
            let area = ((x1 - x0) * (y1 - y0)) as u64;
            let sum = integral[y1 * (w + 1) + x1] + integral[y0 * (w + 1) + x0]
                - integral[y0 * (w + 1) + x1]
                - integral[y1 * (w + 1) + x0];
            let mean = (sum / area) as u32;
            let t = mean.max(floor);
            bits[y * w + x] = u8::from(luma[y * w + x] as u32 > t);
        }
    }
    Binary { bits, w }
}

// ---------------------------------------------------------------- anchors

#[derive(Clone, Copy)]
struct Cand {
    x: f64,
    y: f64,
    m: f64,
    votes: u32,
}

/// Scan rows for the bullseye signature W:B:W:B:W = 1:1:2:1:1 (bright/dark
/// runs), cross-check vertically, cluster, and return candidate 4-corner
/// quads (largest first), each ordered clockwise from the visual top-left.
fn find_anchor_quads(f: &Frame, bin: &Binary) -> Vec<[Pt; 4]> {
    let mut clusters: Vec<Cand> = Vec::new();
    collect_candidates(f, bin, &mut clusters);
    clusters.retain(|c| c.votes >= 3);
    if clusters.len() < 4 {
        return Vec::new();
    }
    // Glyph-field artifacts mimic the signature at the glyph-block module
    // (half the anchor's); anchors are the largest well-voted patterns, so
    // drop clusters far below the strongest module size.
    let m_ref = clusters
        .iter()
        .filter(|c| c.votes >= 6)
        .map(|c| c.m)
        .fold(0.0f64, f64::max);
    if m_ref > 0.0 {
        clusters.retain(|c| c.m >= 0.55 * m_ref);
    }
    if clusters.len() < 4 {
        return Vec::new();
    }
    clusters.sort_by(|a, b| b.votes.cmp(&a.votes));
    clusters.truncate(10);
    // Enumerate module-consistent subsets, largest area first. The caller
    // validates each against the rotation marker, so false positives (which
    // can lie outside the true anchor rectangle, in the edge data bands)
    // only cost an extra attempt.
    let mut quads = candidate_quads(&clusters);
    quads.sort_by(|a, b| b.1.total_cmp(&a.1));
    quads.into_iter().map(|(q, _)| order_clockwise(&q)).collect()
}

fn collect_candidates(f: &Frame, bin: &Binary, clusters: &mut Vec<Cand>) {
    let (w, h) = (f.w, f.h);
    for y in 0..h {
        // Run-length encode the row.
        let mut runs: Vec<(usize, usize, bool)> = Vec::new(); // (start, len, bright)
        let mut start = 0usize;
        let mut cur = bin.bright(0, y);
        for x in 1..=w {
            let b = if x < w { bin.bright(x, y) } else { !cur };
            if b != cur {
                runs.push((start, x - start, cur));
                start = x;
                cur = b;
            }
        }
        for i in 0..runs.len().saturating_sub(4) {
            if !runs[i].2 {
                continue; // window must start bright
            }
            let s: Vec<f64> = (0..5).map(|k| runs[i + k].1 as f64).collect();
            let m = (s[0] + s[1] + s[3] + s[4]) / 4.0;
            if m < 3.0 {
                continue;
            }
            let ok = (s[2] - 2.0 * m).abs() <= m
                && s.iter().enumerate().all(|(k, &v)| k == 2 || (v >= 0.45 * m && v <= 1.9 * m));
            if !ok {
                continue;
            }
            // The pattern must be bordered by dark (or the image edge):
            // glyph fields fake the inner signature but rarely its margins.
            if i > 0 && runs[i - 1].2 {
                continue;
            }
            if i + 5 < runs.len() && runs[i + 5].2 {
                continue;
            }
            let cx = runs[i + 2].0 as f64 + s[2] / 2.0;
            if let Some(cy) = vertical_check(bin, f.h, cx as usize, y, m) {
                merge(clusters, cx, cy, m);
            }
        }
    }
}

fn candidate_quads(clusters: &[Cand]) -> Vec<([Cand; 4], f64)> {
    let n = clusters.len();
    let mut out = Vec::new();
    for a in 0..n {
        for b in (a + 1)..n {
            for c in (b + 1)..n {
                for d in (c + 1)..n {
                    let quad = [clusters[a], clusters[b], clusters[c], clusters[d]];
                    let (min_m, max_m) = quad
                        .iter()
                        .fold((f64::MAX, 0.0f64), |(lo, hi), q| (lo.min(q.m), hi.max(q.m)));
                    if max_m / min_m > 2.5 {
                        continue;
                    }
                    // Shoelace over the angularly ordered quad.
                    let cx = quad.iter().map(|q| q.x).sum::<f64>() / 4.0;
                    let cy = quad.iter().map(|q| q.y).sum::<f64>() / 4.0;
                    let mut pts: Vec<(f64, f64)> = quad.iter().map(|q| (q.x, q.y)).collect();
                    pts.sort_by(|p, q| {
                        (p.1 - cy).atan2(p.0 - cx).total_cmp(&(q.1 - cy).atan2(q.0 - cx))
                    });
                    let mut area = 0.0;
                    for i in 0..4 {
                        let (x1, y1) = pts[i];
                        let (x2, y2) = pts[(i + 1) % 4];
                        area += x1 * y2 - x2 * y1;
                    }
                    out.push((quad, area.abs() / 2.0));
                }
            }
        }
    }
    out
}

fn order_clockwise(four: &[Cand; 4]) -> [Pt; 4] {
    // Ascending atan2 is clockwise with y-down; start nearest the visual
    // top-left.
    let cx = four.iter().map(|c| c.x).sum::<f64>() / 4.0;
    let cy = four.iter().map(|c| c.y).sum::<f64>() / 4.0;
    let mut pts: Vec<(f64, Pt)> = four
        .iter()
        .map(|c| ((c.y - cy).atan2(c.x - cx), (c.x, c.y)))
        .collect();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0));
    let start = pts
        .iter()
        .enumerate()
        .min_by(|a, b| (a.1 .1 .0 + a.1 .1 .1).total_cmp(&(b.1 .1 .0 + b.1 .1 .1)))
        .map(|(i, _)| i)
        .unwrap_or(0);
    let mut out = [(0.0, 0.0); 4];
    for i in 0..4 {
        out[i] = pts[(start + i) % 4].1;
    }
    out
}

/// Verify the vertical profile at column x around row y; returns refined
/// center y (middle of the bright core run).
fn vertical_check(bin: &Binary, h: usize, x: usize, y: usize, m: f64) -> Option<f64> {
    if x >= bin.w {
        return None;
    }
    if !bin.bright(x, y) {
        return None;
    }
    let mut top = y;
    while top > 0 && bin.bright(x, top - 1) {
        top -= 1;
    }
    let mut bot = y;
    while bot + 1 < h && bin.bright(x, bot + 1) {
        bot += 1;
    }
    let core = (bot - top + 1) as f64;
    if !(core >= 1.2 * m && core <= 3.2 * m) {
        return None;
    }
    // Walk outward through the full ring profile: dark ring then bright
    // outer ring on both sides (rejects stripe-like data patterns that fake
    // the horizontal signature).
    let walk = |start: i64, dir: i64, want_bright: bool| -> (f64, i64) {
        let mut yy = start;
        let mut n = 0.0;
        loop {
            let next = yy + dir;
            if next < 0 || next >= h as i64 || bin.bright(x, next as usize) != want_bright {
                break;
            }
            yy = next;
            n += 1.0;
            if n > 3.0 * m {
                break;
            }
        }
        (n, yy)
    };
    // Dark ring: bounded on both sides. Outer bright ring: presence only —
    // it can merge with adjacent bright content (reference strips, glyphs).
    let (n_up, d_up) = walk(top as i64, -1, false);
    if !(0.4 * m..=2.2 * m).contains(&n_up) {
        return None;
    }
    let (b_up, _) = walk(d_up, -1, true);
    if b_up < 0.4 * m {
        return None;
    }
    let (n_dn, d_dn) = walk(bot as i64, 1, false);
    if !(0.4 * m..=2.2 * m).contains(&n_dn) {
        return None;
    }
    let (b_dn, _) = walk(d_dn, 1, true);
    if b_dn < 0.4 * m {
        return None;
    }
    Some((top + bot + 1) as f64 / 2.0)
}

fn merge(clusters: &mut Vec<Cand>, x: f64, y: f64, m: f64) {
    for c in clusters.iter_mut() {
        let d2 = (c.x - x).powi(2) + (c.y - y).powi(2);
        if d2 < (2.5 * c.m.max(m)).powi(2) {
            let n = c.votes as f64;
            c.x = (c.x * n + x) / (n + 1.0);
            c.y = (c.y * n + y) / (n + 1.0);
            c.m = (c.m * n + m) / (n + 1.0);
            c.votes += 1;
            return;
        }
    }
    clusters.push(Cand { x, y, m, votes: 1 });
}

// ---------------------------------------------------------------- orient

/// Try the four corner assignments; the right one shows a bright rotation
/// marker at the TL position and dark ones elsewhere.
fn orient(f: &Frame, centers: &[Pt; 4]) -> Option<[f64; 9]> {
    let code: [Pt; 4] = ANCHOR_CENTERS;
    let mut best: Option<([f64; 9], f64)> = None;
    for r in 0..4 {
        let src: [Pt; 4] = core_rotated(&code, r);
        let h = match solve(&src, centers) {
            Some(h) => h,
            None => continue,
        };
        let mut lumas = [0.0f64; 4];
        for (i, &(tx, ty)) in ROT_TILES.iter().enumerate() {
            let (px, py) = tile_center(tx, ty);
            let (ix, iy) = apply(&h, px, py);
            lumas[i] = f.bilinear_luma(ix, iy).unwrap_or(0.0);
        }
        let others = lumas[1].max(lumas[2]).max(lumas[3]);
        let score = lumas[0] - others;
        if best.as_ref().is_none_or(|(_, s)| score > *s) {
            best = Some((h, score));
        }
    }
    let (h, score) = best?;
    (score > 15.0).then_some(h)
}

fn core_rotated(code: &[Pt; 4], r: usize) -> [Pt; 4] {
    let mut out = [(0.0, 0.0); 4];
    for i in 0..4 {
        out[i] = code[(i + r) % 4];
    }
    out
}

fn tile_center(tx: usize, ty: usize) -> Pt {
    ((tx * TILE) as f64 + TILE as f64 / 2.0, (ty * TILE) as f64 + TILE as f64 / 2.0)
}

// ---------------------------------------------------------------- alignment

/// Per-dot image-space offsets (observed - predicted), bilinearly
/// interpolated over the 5x5 lattice when sampling.
struct OffsetField {
    dx: [[f64; 5]; 5],
    dy: [[f64; 5]; 5],
}

impl OffsetField {
    fn at(&self, code_x: f64, code_y: f64) -> (f64, f64) {
        let step = ALIGN_CENTERS[1] - ALIGN_CENTERS[0];
        let sx = ((code_x - ALIGN_CENTERS[0]) / step).clamp(0.0, 4.0);
        let sy = ((code_y - ALIGN_CENTERS[0]) / step).clamp(0.0, 4.0);
        let ix = (sx as usize).min(3);
        let iy = (sy as usize).min(3);
        let fx = sx - ix as f64;
        let fy = sy - iy as f64;
        let lerp2 = |g: &[[f64; 5]; 5]| {
            g[iy][ix] * (1.0 - fx) * (1.0 - fy)
                + g[iy][ix + 1] * fx * (1.0 - fy)
                + g[iy + 1][ix] * (1.0 - fx) * fy
                + g[iy + 1][ix + 1] * fx * fy
        };
        (lerp2(&self.dx), lerp2(&self.dy))
    }
}

fn alignment_offsets(f: &Frame, h: &[f64; 9]) -> OffsetField {
    let mut field = OffsetField { dx: [[0.0; 5]; 5], dy: [[0.0; 5]; 5] };
    for (iy, &cy) in ALIGN_CENTERS.iter().enumerate() {
        for (ix, &cx) in ALIGN_CENTERS.iter().enumerate() {
            let (px, py) = apply(h, cx, cy);
            // Brightness-weighted centroid in a window around the predicted
            // dot position. The window must stay inside the 24px black zone
            // (minus mapping error), or neighboring glyph pixels bias it.
            let r = 9i32;
            let (mut sw, mut sx, mut sy) = (0.0f64, 0.0f64, 0.0f64);
            let mut min_l = f64::MAX;
            let mut samples: Vec<(f64, f64, f64)> = Vec::new();
            for dy in -r..=r {
                for dx in -r..=r {
                    let x = px + dx as f64;
                    let y = py + dy as f64;
                    if let Some(l) = f.bilinear_luma(x, y) {
                        min_l = min_l.min(l);
                        samples.push((x, y, l));
                    }
                }
            }
            for (x, y, l) in samples {
                let wgt = (l - min_l - 30.0).max(0.0);
                sw += wgt;
                sx += wgt * x;
                sy += wgt * y;
            }
            if sw > 1.0 {
                let ox = sx / sw - px;
                let oy = sy / sw - py;
                if ox.hypot(oy) <= 8.0 {
                    field.dx[iy][ix] = ox;
                    field.dy[iy][ix] = oy;
                }
            }
        }
    }
    field
}

// ---------------------------------------------------------------- sampling

struct Calibration {
    // Unit-normalized mean RGB per palette index.
    means: [[f64; 3]; 4],
}

fn normalize(v: [f64; 3]) -> [f64; 3] {
    let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-6);
    [v[0] / n, v[1] / n, v[2] / n]
}

fn map_pt(h: &[f64; 9], off: &OffsetField, cx: f64, cy: f64) -> (f64, f64) {
    let (x, y) = apply(h, cx, cy);
    let (dx, dy) = off.at(cx, cy);
    (x + dx, y + dy)
}

fn calibrate(f: &Frame, h: &[f64; 9], off: &OffsetField) -> Option<Calibration> {
    let mut sums = [[0.0f64; 3]; 4];
    let mut counts = [0u32; 4];
    for (tx, ty, k) in reference_tiles() {
        // Reference tiles are solid color: average the whole tile interior.
        let mut acc = [0.0f64; 3];
        let mut n = 0.0;
        for j in 1..7 {
            for i in 1..7 {
                let cx = (tx * TILE + i) as f64 + 0.5;
                let cy = (ty * TILE + j) as f64 + 0.5;
                let (x, y) = map_pt(h, off, cx, cy);
                if let Some(rgb) = f.bilinear(x, y) {
                    for c in 0..3 {
                        acc[c] += rgb[c];
                    }
                    n += 1.0;
                }
            }
        }
        if n > 0.0 {
            let k = k as usize;
            for c in 0..3 {
                sums[k][c] += acc[c] / n;
            }
            counts[k] += 1;
        }
    }
    let mut means = [[0.0f64; 3]; 4];
    for k in 0..4 {
        if counts[k] == 0 {
            return None;
        }
        means[k] = normalize([
            sums[k][0] / counts[k] as f64,
            sums[k][1] / counts[k] as f64,
            sums[k][2] / counts[k] as f64,
        ]);
    }
    Some(Calibration { means })
}

fn classify_color(calib: &Calibration, rgb: [f64; 3]) -> u8 {
    let v = normalize(rgb);
    let mut best = 0u8;
    let mut best_d = f64::MAX;
    for (k, m) in calib.means.iter().enumerate() {
        let d = (v[0] - m[0]).powi(2) + (v[1] - m[1]).powi(2) + (v[2] - m[2]).powi(2);
        if d < best_d {
            best_d = d;
            best = k as u8;
        }
    }
    best
}

fn sample_data(f: &Frame, h: &[f64; 9], off: &OffsetField, calib: &Calibration) -> Vec<u8> {
    let tiles = data_tiles();
    let raw = raw_capacity_bytes();
    let mut out = vec![0u8; raw];
    let mut bit = 0usize;
    for (tx, ty) in tiles {
        // Sample the center of each 2x2-pixel glyph block: the farthest
        // point from block edges, hence the most blur-tolerant.
        let mut lumas = [0.0f64; 16];
        let mut rgbs = [[0.0f64; 3]; 16];
        for by in 0..4 {
            for bx in 0..4 {
                let cx = (tx * TILE + bx * 2) as f64 + 1.0;
                let cy = (ty * TILE + by * 2) as f64 + 1.0;
                let (x, y) = map_pt(h, off, cx, cy);
                if let Some(rgb) = f.bilinear(x, y) {
                    rgbs[by * 4 + bx] = rgb;
                    lumas[by * 4 + bx] = (rgb[0] + 2.0 * rgb[1] + rgb[2]) / 4.0;
                }
            }
        }
        // Glyphs light exactly half their blocks: threshold midway between
        // the bright and dark halves.
        let mut sorted = lumas;
        sorted.sort_by(f64::total_cmp);
        let dark: f64 = sorted[..4].iter().sum::<f64>() / 4.0;
        let bright: f64 = sorted[12..].iter().sum::<f64>() / 4.0;
        let t = (dark + bright) / 2.0;
        let mut pattern = 0u16;
        let mut on_rgb = [0.0f64; 3];
        let mut on_n = 0.0;
        for (idx, &l) in lumas.iter().enumerate() {
            if l > t {
                pattern |= 1u16 << idx;
                for c in 0..3 {
                    on_rgb[c] += rgbs[idx][c];
                }
                on_n += 1.0;
            }
        }
        let (sym, _) = nearest_glyph(pattern);
        let color = if on_n > 0.0 {
            classify_color(calib, [on_rgb[0] / on_n, on_rgb[1] / on_n, on_rgb[2] / on_n])
        } else {
            0
        };
        let v = (sym << 2) | color;
        for k in (0..6).rev() {
            let byte = bit / 8;
            if byte < raw {
                out[byte] |= ((v >> k) & 1) << (7 - bit % 8);
            }
            bit += 1;
        }
    }
    out
}
