//! Frame geometry: a 1024x1024 canvas of 8x8-pixel tiles (128x128 grid) with
//! corner bullseye anchors, interior alignment dots, per-corner color
//! reference strips, and one rotation-marker tile per corner.

pub const CANVAS: usize = 1024;
pub const TILE: usize = 8;
pub const GRID: usize = CANVAS / TILE; // 128

/// Corner anchor graphic: 48x48 px (6x6 tiles); the full reserved corner zone
/// is 7x7 tiles (graphic + one tile of margin holding strips/markers).
pub const ANCHOR_PX: usize = 48;
pub const CORNER_ZONE: usize = 7;

/// Bullseye centers in canvas coordinates, order TL, TR, BR, BL (clockwise).
pub const ANCHOR_CENTERS: [(f64, f64); 4] = [
    (24.0, 24.0),
    (1000.0, 24.0),
    (1000.0, 1000.0),
    (24.0, 1000.0),
];

/// Rotation marker tiles (tile coords): white at TL only, black at the rest.
pub const ROT_TILES: [(usize, usize); 4] = [(6, 6), (121, 6), (121, 121), (6, 121)];

/// Alignment-dot lattice: 5x5 dots; each dot is a white 8x8 core centered in
/// a reserved 3x3-tile black zone. Center tile coordinates:
pub const ALIGN_TILES: [usize; 5] = [12, 38, 64, 90, 116];
/// Dot centers in canvas px (tile*8 + 4).
pub const ALIGN_CENTERS: [f64; 5] = [100.0, 308.0, 516.0, 724.0, 932.0];

/// 4-color palette (bright on black): index = 2 low bits of a tile value.
pub const PALETTE: [[u8; 3]; 4] = [
    [0, 255, 255],  // cyan
    [255, 0, 255],  // magenta
    [255, 255, 0],  // yellow
    [0, 255, 0],    // green
];

/// Reference strip: 4 solid-color tiles per corner along the zone margin.
/// (tile_x, tile_y, palette_index)
pub fn reference_tiles() -> Vec<(usize, usize, u8)> {
    let mut out = Vec::with_capacity(16);
    for k in 0u8..4 {
        let k_us = k as usize;
        out.push((k_us, 6, k)); // TL: along bottom margin row
        out.push((127 - k_us, 6, k)); // TR
        out.push((127 - k_us, 121, k)); // BR
        out.push((k_us, 121, k)); // BL
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Corner,
    Align,
    Reference(u8),
    RotMarker(bool), // true = the white (TL) marker
    Data,
}

pub fn tile_role(tx: usize, ty: usize) -> Role {
    let near_lo = |v: usize| v < CORNER_ZONE;
    let near_hi = |v: usize| v >= GRID - CORNER_ZONE;
    if (near_lo(tx) || near_hi(tx)) && (near_lo(ty) || near_hi(ty)) {
        for (i, &(rx, ry)) in ROT_TILES.iter().enumerate() {
            if tx == rx && ty == ry {
                return Role::RotMarker(i == 0);
            }
        }
        for (fx, fy, k) in reference_tiles() {
            if tx == fx && ty == fy {
                return Role::Reference(k);
            }
        }
        return Role::Corner;
    }
    let near_align = |v: usize| ALIGN_TILES.iter().any(|&c| tx_near(v, c));
    if near_align(tx) && near_align(ty) {
        return Role::Align;
    }
    Role::Data
}

fn tx_near(v: usize, c: usize) -> bool {
    v + 1 >= c && v <= c + 1
}

/// Row-major list of data tile coordinates. Deterministic; both endpoints
/// derive it identically.
pub fn data_tiles() -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for ty in 0..GRID {
        for tx in 0..GRID {
            if tile_role(tx, ty) == Role::Data {
                out.push((tx, ty));
            }
        }
    }
    out
}

/// Raw bytes carried by one frame's tiles (6 bits per data tile).
pub fn raw_capacity_bytes() -> usize {
    data_tiles().len() * 6 / 8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_geometry() {
        // 4 corner zones of 7x7, 25 alignment zones of 3x3; strips and rot
        // markers live inside the corner zones.
        assert_eq!(data_tiles().len(), 128 * 128 - 4 * 49 - 25 * 9);
        assert_eq!(data_tiles().len(), 15_963);
        assert_eq!(raw_capacity_bytes(), 11_972);
    }

    #[test]
    fn zones_do_not_overlap() {
        // Every reference/rot tile must sit inside a corner zone, and
        // alignment zones must not touch corner zones.
        for (tx, ty, _) in reference_tiles() {
            assert!(matches!(tile_role(tx, ty), Role::Reference(_)));
        }
        for &c in &ALIGN_TILES {
            assert!(c > CORNER_ZONE + 1 && c < GRID - CORNER_ZONE - 2);
        }
    }
}
