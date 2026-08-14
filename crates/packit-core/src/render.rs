//! Frame rendering: pre-RS byte stream -> 1024x1024 RGBA.

use crate::geometry::*;
use crate::glyphs::GLYPHS;
use crate::rs_layer;

/// Encode `data` (exactly rs_layer::data_capacity(raw_capacity_bytes())
/// bytes) into a rendered frame.
pub fn render_frame(data: &[u8]) -> Vec<u8> {
    let raw = raw_capacity_bytes();
    let coded = rs_layer::encode(data, raw);
    let mut img = vec![0u8; CANVAS * CANVAS * 4];
    // Opaque alpha everywhere.
    for px in img.chunks_exact_mut(4) {
        px[3] = 255;
    }
    for &(cx, cy) in ANCHOR_CENTERS.iter() {
        draw_bullseye(&mut img, cx as usize, cy as usize);
    }
    for (i, &(tx, ty)) in ROT_TILES.iter().enumerate() {
        if i == 0 {
            fill_tile(&mut img, tx, ty, [255, 255, 255]);
        }
    }
    for (tx, ty, k) in reference_tiles() {
        fill_tile(&mut img, tx, ty, PALETTE[k as usize]);
    }
    for &cy in ALIGN_TILES.iter() {
        for &cx in ALIGN_TILES.iter() {
            fill_tile(&mut img, cx, cy, [255, 255, 255]);
        }
    }
    // Data tiles: 6 bits per tile, MSB-first over the coded stream.
    let mut bit = 0usize;
    for (tx, ty) in data_tiles() {
        let mut v = 0u8;
        for _ in 0..6 {
            let byte = bit / 8;
            let b = if byte < coded.len() { (coded[byte] >> (7 - bit % 8)) & 1 } else { 0 };
            v = (v << 1) | b;
            bit += 1;
        }
        draw_glyph(&mut img, tx, ty, GLYPHS[(v >> 2) as usize], PALETTE[(v & 3) as usize]);
    }
    img
}

fn put(img: &mut [u8], x: usize, y: usize, rgb: [u8; 3]) {
    let o = (y * CANVAS + x) * 4;
    img[o] = rgb[0];
    img[o + 1] = rgb[1];
    img[o + 2] = rgb[2];
}

fn fill_tile(img: &mut [u8], tx: usize, ty: usize, rgb: [u8; 3]) {
    for j in 0..TILE {
        for i in 0..TILE {
            put(img, tx * TILE + i, ty * TILE + j, rgb);
        }
    }
}

fn draw_glyph(img: &mut [u8], tx: usize, ty: usize, glyph: u64, rgb: [u8; 3]) {
    for j in 0..TILE {
        for i in 0..TILE {
            if glyph >> (j * 8 + i) & 1 == 1 {
                put(img, tx * TILE + i, ty * TILE + j, rgb);
            }
        }
    }
}

/// Concentric rings by Chebyshev distance from the center: white core
/// (<=8 px), black ring (<=16), white ring (<=24). A center scanline reads
/// W:B:W:B:W = 1:1:2:1:1 in 8px units.
fn draw_bullseye(img: &mut [u8], cx: usize, cy: usize) {
    for dy in -24i32..24 {
        for dx in -24i32..24 {
            let d = dx.max(-dx - 1).max(dy.max(-dy - 1)) + 1; // 1..=24
            let white = d <= 8 || d > 16;
            if white {
                let x = (cx as i32 + dx) as usize;
                let y = (cy as i32 + dy) as usize;
                put(img, x, y, [255, 255, 255]);
            }
        }
    }
}
