import QRCode from "qrcode";
import { LTEncoder } from "./lib/lt";
import { crc32 } from "./lib/crc32";
import { serializeDataPacket, serializeMetaPacket } from "./lib/packet";
import { loadCore, type Core } from "./wasm";
import type { TileSender } from "./wasm/pkg/packit_core";

const META_INTERVAL = 8; // every Nth frame repeats the metadata

interface QrSession {
  kind: "qr";
  encoder: LTEncoder;
  fileId: number;
  metaText: string;
  seedBase: number;
}

interface TileSession {
  kind: "tile";
  sender: TileSender;
}

type Session = (QrSession | TileSession) & {
  frame: number;
  startedAt: number;
};

export function initSender(root: HTMLElement): void {
  root.innerHTML = `
    <div class="panel">
      <label class="dropzone" id="dropzone">
        <input type="file" id="file-input" hidden>
        <span id="drop-label">Tap to choose a file, or drop one here</span>
      </label>
      <div class="controls">
        <label>Transport
          <select id="transport">
            <option value="tile" selected>Tile (fast)</option>
            <option value="qr">QR (compatible)</option>
          </select>
        </label>
        <label id="block-size-wrap">Block size
          <select id="block-size">
            <option value="128">128 B (easier scan)</option>
            <option value="256" selected>256 B (balanced)</option>
            <option value="512">512 B (dense, needs good camera)</option>
          </select>
        </label>
        <label>Frames/sec
          <input type="range" id="fps" min="2" max="30" value="15">
          <span id="fps-label">15</span>
        </label>
      </div>
      <div class="qr-wrap hidden" id="qr-wrap">
        <canvas id="qr-canvas"></canvas>
        <div class="stats" id="send-stats"></div>
        <button id="stop-send" class="secondary">Stop</button>
      </div>
    </div>
  `;

  const fileInput = root.querySelector<HTMLInputElement>("#file-input")!;
  const dropzone = root.querySelector<HTMLElement>("#dropzone")!;
  const dropLabel = root.querySelector<HTMLElement>("#drop-label")!;
  const transportSel = root.querySelector<HTMLSelectElement>("#transport")!;
  const blockSizeWrap = root.querySelector<HTMLElement>("#block-size-wrap")!;
  const blockSizeSel = root.querySelector<HTMLSelectElement>("#block-size")!;
  const fpsInput = root.querySelector<HTMLInputElement>("#fps")!;
  const fpsLabel = root.querySelector<HTMLElement>("#fps-label")!;
  const qrWrap = root.querySelector<HTMLElement>("#qr-wrap")!;
  const canvas = root.querySelector<HTMLCanvasElement>("#qr-canvas")!;
  const stats = root.querySelector<HTMLElement>("#send-stats")!;
  const stopBtn = root.querySelector<HTMLButtonElement>("#stop-send")!;

  let session: Session | null = null;
  let rafId = 0;
  let lastFrameAt = 0;
  let core: Core | null = null;

  function applyTransportUI(): void {
    const tile = transportSel.value === "tile";
    blockSizeWrap.classList.toggle("hidden", tile);
    fpsInput.max = tile ? "30" : "15";
    fpsInput.value = tile ? "15" : "8";
    fpsLabel.textContent = fpsInput.value;
  }
  applyTransportUI();

  function stop(): void {
    cancelAnimationFrame(rafId);
    if (session?.kind === "tile") session.sender.free();
    session = null;
    qrWrap.classList.add("hidden");
  }

  function loop(t: number): void {
    if (!session) return;
    const interval = 1000 / Number(fpsInput.value);
    if (t - lastFrameAt >= interval - 1) {
      lastFrameAt = t;
      void renderFrame();
    }
    rafId = requestAnimationFrame(loop);
  }

  async function renderFrame(): Promise<void> {
    if (!session) return;
    const s = session;
    s.frame++;
    if (s.kind === "tile") {
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
        `tile mode · ${formatBytes(cap)}/frame · frame ${s.frame} · ` +
        `${tx > 0 ? formatBytes(Math.round(tx)) : "—"}/s tx · ` +
        `receiver needs ~${s.sender.source_symbols()} frames`;
      return;
    }
    let text: string;
    if (s.frame % META_INTERVAL === 0) {
      text = s.metaText;
    } else {
      const seed = (s.seedBase + s.frame) >>> 0;
      text = serializeDataPacket({
        fileId: s.fileId,
        k: s.encoder.k,
        blockSize: s.encoder.blockSize,
        fileSize: s.encoder.fileSize,
        seed,
        payload: s.encoder.encode(seed),
      });
    }
    await QRCode.toCanvas(canvas, text, {
      errorCorrectionLevel: "L",
      margin: 2,
      width: Math.min(560, Math.floor(Math.min(window.innerWidth, 720) * 0.92)),
    });
    const elapsed = (performance.now() - s.startedAt) / 1000;
    const fps = Number(fpsInput.value);
    const dataFps = fps * (1 - 1 / META_INTERVAL);
    const minSeconds = Math.ceil((s.encoder.k * 1.15) / dataFps);
    const dataFrames = s.frame - Math.floor(s.frame / META_INTERVAL);
    const txRate = elapsed > 0.5 ? (dataFrames * s.encoder.blockSize) / elapsed : 0;
    stats.textContent =
      `qr mode · ${s.encoder.k} blocks × ${s.encoder.blockSize} B · ` +
      `frame ${s.frame} · ${elapsed.toFixed(0)}s · ` +
      `${txRate > 0 ? formatBytes(Math.round(txRate)) : "—"}/s tx · ` +
      `≈${minSeconds}s per receive (theoretical)`;
  }

  async function start(file: File): Promise<void> {
    stop();
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length === 0) {
      dropLabel.textContent = "That file is empty — pick another.";
      return;
    }
    let base: Session | null = null;
    if (transportSel.value === "tile") {
      core ??= await loadCore();
      if (!core) {
        dropLabel.textContent = "Tile mode unavailable in this browser — falling back to QR.";
        transportSel.value = "qr";
        applyTransportUI();
      } else {
        base = {
          kind: "tile",
          sender: new core.TileSender(data, file.name, file.type || "application/octet-stream"),
          frame: 0,
          startedAt: performance.now(),
        };
      }
    }
    if (!base) {
      const blockSize = Number(blockSizeSel.value);
      const encoder = new LTEncoder(data, blockSize);
      if (encoder.k > 65535) {
        dropLabel.textContent = "File too large for this block size — raise the block size.";
        return;
      }
      const fileId = crypto.getRandomValues(new Uint32Array(1))[0];
      base = {
        kind: "qr",
        encoder,
        fileId,
        metaText: serializeMetaPacket({
          fileId,
          k: encoder.k,
          blockSize,
          fileSize: data.length,
          crc: crc32(data),
          name: file.name,
          mime: file.type || "application/octet-stream",
        }),
        seedBase: crypto.getRandomValues(new Uint32Array(1))[0],
        frame: 0,
        startedAt: performance.now(),
      };
    }
    dropLabel.textContent = `${file.name} (${formatBytes(data.length)})`;
    qrWrap.classList.remove("hidden");
    session = base;
    lastFrameAt = 0;
    rafId = requestAnimationFrame(loop);
  }

  function restart(): void {
    if (fileInput.files?.[0]) void start(fileInput.files[0]);
  }

  fpsInput.addEventListener("input", () => {
    fpsLabel.textContent = fpsInput.value;
  });
  transportSel.addEventListener("change", () => {
    applyTransportUI();
    restart();
  });
  blockSizeSel.addEventListener("change", restart);
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
