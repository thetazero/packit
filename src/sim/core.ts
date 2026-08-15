import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TileReceiver, TileSender } from "../wasm/pkg/packit_core";

/**
 * Node-side loader for the packit-core wasm module (the browser app uses
 * src/wasm.ts; under vite-node/vitest the .wasm bytes must be handed to the
 * init function explicitly).
 */
export interface Core {
  version: () => string;
  frameCapacity: () => number;
  TileSender: typeof TileSender;
  TileReceiver: typeof TileReceiver;
}

const pkgDir = fileURLToPath(new URL("../wasm/pkg/", import.meta.url));

export function coreBuilt(): boolean {
  return existsSync(pkgDir + "packit_core.js");
}

let pending: Promise<Core> | null = null;

export function loadCore(): Promise<Core> {
  pending ??= (async () => {
    if (!coreBuilt()) {
      throw new Error("packit-core wasm not built — run `npm run build:wasm` first");
    }
    const mod = await import(/* @vite-ignore */ pkgDir + "packit_core.js");
    await mod.default({ module_or_path: readFileSync(pkgDir + "packit_core_bg.wasm") });
    return {
      version: mod.version,
      frameCapacity: mod.frame_capacity,
      TileSender: mod.TileSender,
      TileReceiver: mod.TileReceiver,
    };
  })();
  return pending;
}
