/**
 * Screen model: projects the sender's rendered 1024x1024 RGBA frame into the
 * camera's image plane. The physical setup mirrors the real app — the frame
 * canvas has a fixed on-screen size, the camera sees it spanning `spanPx`
 * sensor pixels at a slight tilt, surrounded by the dark app UI, on an LCD
 * whose black isn't 0 and white isn't 255.
 *
 * Projection happens directly in camera coordinates with 2x2 supersampling:
 * each camera pixel inverse-rotates into screen space and averages the
 * source, reproducing the soft anti-aliased tile edges a real sensor sees
 * when an 8px tile lands on ~6-8 camera pixels.
 */
export interface TrialGeometry {
  /** Sensor crop is a camPx × camPx square. */
  camPx: number;
  /** Camera pixels the 1024px frame spans. The decoder's floor is ~820. */
  spanPx: number;
  /** Camera tilt relative to the screen, radians. */
  rotationRad: number;
  /** On-screen luminance of full-white / full-black, and of the UI around the frame. */
  white: number;
  black: number;
  bg: number;
}

export const FRAME_PX = 1024;

/** Project one sender frame; returns planar RGB (3 × camPx² planes). */
export function projectFrame(rgba: Uint8Array, geom: TrialGeometry): Uint8Array {
  const { camPx } = geom;
  const scale = geom.spanPx / FRAME_PX;
  const cos = Math.cos(geom.rotationRad);
  const sin = Math.sin(geom.rotationRad);
  const half = camPx / 2;
  const gain = (geom.white - geom.black) / 255;
  const n = camPx * camPx;
  const out = new Uint8Array(3 * n);

  const offsets = [-0.25, 0.25];
  for (let y = 0; y < camPx; y++) {
    for (let x = 0; x < camPx; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const dy of offsets) {
        for (const dx of offsets) {
          const px = x + dx - half;
          const py = y + dy - half;
          const sx = (px * cos + py * sin) / scale + FRAME_PX / 2;
          const sy = (-px * sin + py * cos) / scale + FRAME_PX / 2;
          if (sx < 0 || sy < 0 || sx >= FRAME_PX || sy >= FRAME_PX) {
            r += geom.bg;
            g += geom.bg;
            b += geom.bg;
          } else {
            const o = ((sy | 0) * FRAME_PX + (sx | 0)) * 4;
            r += geom.black + rgba[o] * gain;
            g += geom.black + rgba[o + 1] * gain;
            b += geom.black + rgba[o + 2] * gain;
          }
        }
      }
      const i = y * camPx + x;
      out[i] = r / 4;
      out[n + i] = g / 4;
      out[2 * n + i] = b / 4;
    }
  }
  return out;
}
