// Lazy loader for the packit-core wasm module. The QR transport must keep
// working even when wasm fails to load (old browsers, blocked fetch), so
// consumers treat a null core as "tile mode unavailable".
import type { TileReceiver, TileSender } from "./wasm/pkg/packit_core";

export interface Core {
  version: () => string;
  frameCapacity: () => number;
  TileSender: typeof TileSender;
  TileReceiver: typeof TileReceiver;
}

let pending: Promise<Core | null> | null = null;

export function loadCore(): Promise<Core | null> {
  pending ??= (async () => {
    try {
      const mod = await import("./wasm/pkg/packit_core");
      await mod.default();
      return {
        version: mod.version,
        frameCapacity: mod.frame_capacity,
        TileSender: mod.TileSender,
        TileReceiver: mod.TileReceiver,
      };
    } catch (err) {
      console.warn("packit-core wasm unavailable; tile mode disabled", err);
      return null;
    }
  })();
  return pending;
}
