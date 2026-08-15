import { loadCore, type Core } from "./wasm";
import type { TileSender } from "./wasm/pkg/packit_core";

const META_INTERVAL = 8; // every Nth frame repeats the metadata

interface Session {
  sender: TileSender;
  frame: number;
  startedAt: number;
}

export function initSender(root: HTMLElement): void {
  root.innerHTML = `
    <div class="panel">
      <label class="dropzone" id="dropzone">
        <input type="file" id="file-input" hidden>
        <span id="drop-label">Tap to choose a file, or drop one here</span>
      </label>
      <div class="controls">
        <label>Frames/sec
          <input type="range" id="fps" min="2" max="30" value="15">
          <span id="fps-label">15</span>
        </label>
      </div>
      <div class="frame-wrap hidden" id="frame-wrap">
        <canvas id="frame-canvas"></canvas>
        <div class="stats" id="send-stats"></div>
        <button id="stop-send" class="secondary">Stop</button>
      </div>
    </div>
  `;

  const fileInput = root.querySelector<HTMLInputElement>("#file-input")!;
  const dropzone = root.querySelector<HTMLElement>("#dropzone")!;
  const dropLabel = root.querySelector<HTMLElement>("#drop-label")!;
  const fpsInput = root.querySelector<HTMLInputElement>("#fps")!;
  const fpsLabel = root.querySelector<HTMLElement>("#fps-label")!;
  const frameWrap = root.querySelector<HTMLElement>("#frame-wrap")!;
  const canvas = root.querySelector<HTMLCanvasElement>("#frame-canvas")!;
  const stats = root.querySelector<HTMLElement>("#send-stats")!;
  const stopBtn = root.querySelector<HTMLButtonElement>("#stop-send")!;

  let session: Session | null = null;
  let rafId = 0;
  let lastFrameAt = 0;
  let core: Core | null = null;

  function stop(): void {
    cancelAnimationFrame(rafId);
    session?.sender.free();
    session = null;
    frameWrap.classList.add("hidden");
  }

  function loop(t: number): void {
    if (!session) return;
    const interval = 1000 / Number(fpsInput.value);
    if (t - lastFrameAt >= interval - 1) {
      lastFrameAt = t;
      renderFrame();
    }
    rafId = requestAnimationFrame(loop);
  }

  function renderFrame(): void {
    if (!session) return;
    const s = session;
    s.frame++;
    const rgba = s.sender.next_frame();
    const pixels = new Uint8ClampedArray(rgba.length) as ImageDataArray;
    pixels.set(rgba);
    const img = new ImageData(pixels, 1024, 1024);
    canvas.width = 1024;
    canvas.height = 1024;
    canvas.getContext("2d")!.putImageData(img, 0, 0);
    const elapsed = (performance.now() - s.startedAt) / 1000;
    const cap = s.sender.payload_capacity();
    const tx = elapsed > 0.5 ? (s.frame * (1 - 1 / META_INTERVAL) * cap) / elapsed : 0;
    stats.textContent =
      `${formatBytes(cap)}/frame · frame ${s.frame} · ` +
      `${tx > 0 ? formatBytes(Math.round(tx)) : "—"}/s tx · ` +
      `receiver needs ~${s.sender.source_symbols()} frames`;
  }

  async function start(file: File): Promise<void> {
    stop();
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length === 0) {
      dropLabel.textContent = "That file is empty — pick another.";
      return;
    }
    core ??= await loadCore();
    if (!core) {
      dropLabel.textContent = "This browser can't load the codec (WebAssembly unavailable).";
      return;
    }
    dropLabel.textContent = `${file.name} (${formatBytes(data.length)})`;
    frameWrap.classList.remove("hidden");
    session = {
      sender: new core.TileSender(data, file.name, file.type || "application/octet-stream"),
      frame: 0,
      startedAt: performance.now(),
    };
    lastFrameAt = 0;
    rafId = requestAnimationFrame(loop);
  }

  function restart(): void {
    if (fileInput.files?.[0]) void start(fileInput.files[0]);
  }

  fpsInput.addEventListener("input", () => {
    fpsLabel.textContent = fpsInput.value;
  });
  fileInput.addEventListener("change", restart);
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragging");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragging");
    const file = e.dataTransfer?.files?.[0];
    if (file) void start(file);
  });
  stopBtn.addEventListener("click", stop);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
