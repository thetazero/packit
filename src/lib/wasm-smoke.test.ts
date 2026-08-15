import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("../wasm/pkg/", import.meta.url));
const built = existsSync(pkgDir + "packit_core.js");

describe.skipIf(!built)("packit-core wasm", () => {
  it("loads and reports its version", async () => {
    const mod = await import(/* @vite-ignore */ pkgDir + "packit_core.js");
    await mod.default({ module_or_path: readFileSync(pkgDir + "packit_core_bg.wasm") });
    expect(mod.version()).toBe("0.4.0");
    expect(mod.frame_capacity()).toBe(9632);
  });

  it("sender produces frames the receiver decodes", async () => {
    const mod = await import(/* @vite-ignore */ pkgDir + "packit_core.js");
    await mod.default({ module_or_path: readFileSync(pkgDir + "packit_core_bg.wasm") });
    const file = new Uint8Array(50_000).map((_, i) => (i * 37 + 11) % 256);
    const sender = new mod.TileSender(file, "test.bin", "application/octet-stream");
    const receiver = new mod.TileReceiver();
    let done = false;
    for (let i = 0; i < 40 && !done; i++) {
      const rgba = sender.next_frame();
      const status = JSON.parse(receiver.push_frame(rgba, 1024, 1024));
      expect(status.recognized).toBe(true);
      done = status.done;
    }
    expect(done).toBe(true);
    expect(receiver.file_name()).toBe("test.bin");
    const got: Uint8Array = receiver.take_file();
    expect(got).toBeDefined();
    expect(got.length).toBe(file.length);
    expect(got.every((v, i) => v === file[i])).toBe(true);
  });
});

if (!built) {
  it("wasm pkg not built — run `npm run build:wasm` to enable the smoke test", () => {
    expect(built).toBe(false);
  });
}
