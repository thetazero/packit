import QRCode from "qrcode";
import { LTEncoder } from "./lib/lt";
import { crc32 } from "./lib/crc32";
import { serializeDataPacket, serializeMetaPacket } from "./lib/packet";

const META_INTERVAL = 8; // every Nth frame repeats the metadata packet

interface SendSession {
  encoder: LTEncoder;
  fileId: number;
  metaText: string;
  seedBase: number;
  frame: number;
  timer: number;
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
        <label>Block size
          <select id="block-size">
            <option value="128">128 B (easier scan)</option>
            <option value="256" selected>256 B (balanced)</option>
            <option value="512">512 B (dense, needs good camera)</option>
          </select>
        </label>
        <label>Frames/sec
          <input type="range" id="fps" min="2" max="15" value="8">
          <span id="fps-label">8</span>
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
  const blockSizeSel = root.querySelector<HTMLSelectElement>("#block-size")!;
  const fpsInput = root.querySelector<HTMLInputElement>("#fps")!;
  const fpsLabel = root.querySelector<HTMLElement>("#fps-label")!;
  const qrWrap = root.querySelector<HTMLElement>("#qr-wrap")!;
  const canvas = root.querySelector<HTMLCanvasElement>("#qr-canvas")!;
  const stats = root.querySelector<HTMLElement>("#send-stats")!;
  const stopBtn = root.querySelector<HTMLButtonElement>("#stop-send")!;

  let session: SendSession | null = null;

  function stop(): void {
    if (session) {
      clearInterval(session.timer);
      session = null;
    }
    qrWrap.classList.add("hidden");
  }

  async function renderFrame(): Promise<void> {
    if (!session) return;
    const s = session;
    let text: string;
    if (s.frame % META_INTERVAL === META_INTERVAL - 1) {
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
    s.frame++;
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
      `${s.encoder.k} blocks × ${s.encoder.blockSize} B · ` +
      `frame ${s.frame} · ${elapsed.toFixed(0)}s · ` +
      `${txRate > 0 ? formatBytes(Math.round(txRate)) : "—"}/s tx · ` +
      `≈${minSeconds}s per receive (theoretical)`;
  }

  function start(file: File): void {
    stop();
    file.arrayBuffer().then((buffer) => {
      const data = new Uint8Array(buffer);
      if (data.length === 0) {
        dropLabel.textContent = "That file is empty — pick another.";
        return;
      }
      const blockSize = Number(blockSizeSel.value);
      const encoder = new LTEncoder(data, blockSize);
      if (encoder.k > 65535) {
        dropLabel.textContent = "File too large for this block size — raise the block size.";
        return;
      }
      const fileId = crypto.getRandomValues(new Uint32Array(1))[0];
      const metaText = serializeMetaPacket({
        fileId,
        k: encoder.k,
        blockSize,
        fileSize: data.length,
        crc: crc32(data),
        name: file.name,
        mime: file.type || "application/octet-stream",
      });
      dropLabel.textContent = `${file.name} (${formatBytes(data.length)})`;
      qrWrap.classList.remove("hidden");
      session = {
        encoder,
        fileId,
        metaText,
        seedBase: crypto.getRandomValues(new Uint32Array(1))[0],
        frame: 0,
        timer: 0,
        startedAt: performance.now(),
      };
      restartTimer();
    });
  }

  function restartTimer(): void {
    if (!session) return;
    clearInterval(session.timer);
    session.timer = window.setInterval(renderFrame, 1000 / Number(fpsInput.value));
  }

  fpsInput.addEventListener("input", () => {
    fpsLabel.textContent = fpsInput.value;
    restartTimer();
  });
  blockSizeSel.addEventListener("change", () => {
    if (fileInput.files?.[0]) start(fileInput.files[0]);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) start(fileInput.files[0]);
  });
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragging");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragging");
    const file = e.dataTransfer?.files?.[0];
    if (file) start(file);
  });
  stopBtn.addEventListener("click", stop);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
