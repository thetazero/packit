//! 4-point DLT homography (8x8 Gaussian elimination, partial pivoting).

pub type Pt = (f64, f64);

/// Solve H such that H maps src[i] -> dst[i]; row-major 3x3 with h[8] = 1.
pub fn solve(src: &[Pt; 4], dst: &[Pt; 4]) -> Option<[f64; 9]> {
    let mut a = [[0.0f64; 9]; 8];
    for i in 0..4 {
        let (x, y) = src[i];
        let (xx, yy) = dst[i];
        a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -xx * x, -xx * y, xx];
        a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -yy * x, -yy * y, yy];
    }
    for col in 0..8 {
        let mut piv = col;
        for r in (col + 1)..8 {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        if a[piv][col].abs() < 1e-9 {
            return None;
        }
        a.swap(col, piv);
        for r in 0..8 {
            if r == col {
                continue;
            }
            let f = a[r][col] / a[col][col];
            for c in col..9 {
                a[r][c] -= f * a[col][c];
            }
        }
    }
    let mut h = [0.0f64; 9];
    for i in 0..8 {
        h[i] = a[i][8] / a[i][i];
    }
    h[8] = 1.0;
    Some(h)
}

pub fn apply(h: &[f64; 9], x: f64, y: f64) -> Pt {
    let w = h[6] * x + h[7] * y + h[8];
    ((h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_corners_exactly() {
        let src = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let dst = [(3.0, 2.0), (95.0, 8.0), (102.0, 110.0), (-4.0, 98.0)];
        let h = solve(&src, &dst).unwrap();
        for i in 0..4 {
            let (x, y) = apply(&h, src[i].0, src[i].1);
            assert!((x - dst[i].0).abs() < 1e-6 && (y - dst[i].1).abs() < 1e-6);
        }
    }
}
