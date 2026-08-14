import QRCode from "qrcode";

/**
 * Screen model: rasterizes the QR a sender frame displays into the camera's
 * image plane. The physical setup mirrors the real app — the sender canvas
 * has a fixed on-screen size (quiet zone included), so denser codes get
 * proportionally smaller modules; the camera sees the code spanning
 * `qrSpanPx` sensor pixels at a slight tilt, surrounded by the dark app UI.
 *
 * Rendering is done directly in camera coordinates with 2×2 supersampling:
 * each camera pixel inverse-rotates into screen space and area-averages the
 * module grid, which reproduces the soft anti-aliased module edges a real
 * sensor sees at low pixels-per-module.
 */
export interface TrialGeometry {
  /** Sensor crop is a camPx × camPx square. */
  camPx: number;
  /** Camera pixels the QR spans, quiet zone included. */
  qrSpanPx: number;
  /** Camera tilt relative to the screen, radians. */
  rotationRad: number;
  /** Luminance of white / black modules and of the screen around the code. */
  white: number;
  black: number;
  bg: number;
}

/** Quiet-zone modules the sender renders (QRCode.toCanvas margin: 2). */
const MARGIN = 2;

export function renderFrameImage(text: string, geom: TrialGeometry): Uint8Array {
  const qr = QRCode.create(text, { errorCorrectionLevel: "L" });
  const size = qr.modules.size;
  const bits = qr.modules.data;
  const total = size + 2 * MARGIN;
  const ppm = geom.qrSpanPx / total;
  const { camPx } = geom;
  const cos = Math.cos(geom.rotationRad);
  const sin = Math.sin(geom.rotationRad);
  const half = camPx / 2;
  const out = new Uint8Array(camPx * camPx);

  const sample = (u: number, v: number): number => {
    if (u < 0 || v < 0 || u >= total || v >= total) return geom.bg;
    const mu = Math.floor(u) - MARGIN;
    const mv = Math.floor(v) - MARGIN;
    if (mu < 0 || mv < 0 || mu >= size || mv >= size) return geom.white; // quiet zone
    return bits[mv * size + mu] ? geom.black : geom.white;
  };

  const offsets = [-0.25, 0.25];
  for (let y = 0; y < camPx; y++) {
    for (let x = 0; x < camPx; x++) {
      let acc = 0;
      for (const dy of offsets) {
        for (const dx of offsets) {
          const px = x + dx - half;
          const py = y + dy - half;
          const sx = px * cos + py * sin;
          const sy = -px * sin + py * cos;
          acc += sample(sx / ppm + total / 2, sy / ppm + total / 2);
        }
      }
      out[y * camPx + x] = acc / 4;
    }
  }
  return out;
}
