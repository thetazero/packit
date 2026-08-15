import jsQR from "jsqr";
import { LTDecoder } from "./lib/lt";
import { crc32 } from "./lib/crc32";
import { parsePacket, type MetaPacket, type Packet } from "./lib/packet";
import { formatBytes } from "./sender";
import { loadCore, type Core } from "./wasm";
import type { TileReceiver } from "./wasm/pkg/packit_core";

// Minimal typing for the native BarcodeDetector (not in TS DOM lib yet).
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
declare const BarcodeDetector: {
  new (options?: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
};

interface TileStatus {
  recognized: boolean;
  packets: number;
  needed: number;
  haveMeta: boolean;
  done: boolean;
}

interface QrState {
  fileId: number;
  decoder: LTDecoder;
  meta: MetaPacket | null;
  startedAt: number;
}

export function initReceiver(root: HTMLElement): void {
  root.innerHTML = `
    <div class="panel">
      <button id="start-cam">Start camera</button>
      <div class="cam-wrap hidden" id="cam-wrap">
        <video id="cam" playsinline muted></video>
        <div class="progress"><div class="progress-bar" id="progress-bar"></div></div>
        <div class="stats" id="recv-stats">Point the camera at the sender's frame stream.</div>
        <button id="stop-cam" class="secondary">Stop camera</button>
      </div>
      <div class="result hidden" id="result"></div>
    </div>
  `;

  const startBtn = root.querySelector<HTMLButtonElement>("#start-cam")!;
  const stopBtn = root.querySelector<HTMLButtonElement>("#stop-cam")!;
  const camWrap = root.querySelector<HTMLElement>("#cam-wrap")!;
  const video = root.querySelector<HTMLVideoElement>("#cam")!;
  const progressBar = root.querySelector<HTMLElement>("#progress-bar")!;
  const stats = root.querySelector<HTMLElement>("#recv-stats")!;
  const result = root.querySelector<HTMLElement>("#result")!;

  let stream: MediaStream | null = null;
  let scanning = false;
  let qrState: QrState | null = null;
  let core: Core | null = null;
  let tileReceiver: TileReceiver | null = null;
  let tileStartedAt = 0;
  let lastTransport = "";

  const scanCanvas = document.createElement("canvas");
  const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true })!;

  let detector: BarcodeDetectorLike | null = null;

  async function setupDetector(): Promise<void> {
    detector = null;
    if (typeof BarcodeDetector !== "undefined") {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes("qr_code")) {
          detector = new BarcodeDetector({ formats: ["qr_code"] });
        }
      } catch {
        detector = null;
      }
    }
  }

  function grabFrame(maxW: number): ImageData | null {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    const scale = Math.min(1, maxW / video.videoWidth);
    scanCanvas.width = Math.floor(video.videoWidth * scale);
    scanCanvas.height = Math.floor(video.videoHeight * scale);
    scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
    return scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
  }

  /** Returns true if the frame carried a tile-mode code. */
  function tryTile(img: ImageData): boolean {
    if (!tileReceiver) return false;
    const bytes = new Uint8Array(img.data.buffer, 0, img.data.length);
    const status = JSON.parse(tileReceiver.push_frame(bytes, img.width, img.height)) as TileStatus;
    if (!status.recognized) return false;
    lastTransport = "tile";
    if (tileStartedAt === 0) tileStartedAt = performance.now();
    updateTileProgress(status);
    if (status.done) finishTile();
    return true;
  }

  async function tryQr(img: ImageData): Promise<void> {
    let text: string | null = null;
    if (detector) {
      try {
        const codes = await detector.detect(video);
        text = codes[0]?.rawValue ?? null;
      } catch {
        text = null;
      }
    }
    if (text === null) {
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      text = code?.data ?? null;
    }
    if (text) {
      const packet = parsePacket(text);
      if (packet) {
        lastTransport = "qr";
        handleQrPacket(packet);
      }
    }
  }

  function handleQrPacket(packet: Packet): void {
    if (!qrState || qrState.fileId !== packet.fileId) {
      qrState = {
        fileId: packet.fileId,
        decoder: new LTDecoder(packet.k, packet.blockSize, packet.fileSize),
        meta: null,
        startedAt: performance.now(),
      };
      result.classList.add("hidden");
    }
    if (packet.type === "meta") {
      qrState.meta = packet;
    } else {
      qrState.decoder.addPacket(packet.seed, packet.payload);
    }
    updateQrProgress();
    if (qrState.decoder.done && qrState.meta) finishQr();
  }

  function updateTileProgress(s: TileStatus): void {
    const cap = core ? core.frameCapacity() : 9632;
    const pct = s.done ? 100 : Math.min(99, Math.floor((s.packets / Math.max(1, s.needed)) * 100));
    progressBar.style.width = `${pct}%`;
    const elapsed = (performance.now() - tileStartedAt) / 1000;
    const bandwidth = elapsed > 0.5 ? (s.packets * cap) / elapsed : 0;
    const eta = bandwidth > 0 ? (Math.max(1, s.needed - s.packets) * cap) / bandwidth : Infinity;
    stats.textContent =
      `tile mode · ${s.packets}/${s.needed} packets (${pct}%) · ` +
      `${bandwidth > 0 ? formatBytes(Math.round(bandwidth)) : "—"}/s · ` +
      `${Number.isFinite(eta) ? `~${Math.max(1, Math.ceil(eta))}s left` : "estimating…"}` +
      (s.haveMeta ? "" : " · waiting for metadata…");
  }

  function updateQrProgress(): void {
    if (!qrState) return;
    const d = qrState.decoder;
    const estNeeded = Math.ceil(d.k * 1.12) + 2;
    const collected = d.packetsUsed;
    const pct = d.done ? 100 : Math.min(99, Math.floor((collected / estNeeded) * 100));
    progressBar.style.width = `${pct}%`;
    const elapsed = (performance.now() - qrState.startedAt) / 1000;
    const bandwidth = elapsed > 0.5 ? (collected * d.blockSize) / elapsed : 0;
    const eta =
      bandwidth > 0 ? (Math.max(1, estNeeded - collected) * d.blockSize) / bandwidth : Infinity;
    const decodedPct = Math.floor((d.solvedCount / d.k) * 100);
    stats.textContent = d.done
      ? `qr mode · decoded ${formatBytes(d.fileSize)} — waiting for metadata frame…`
      : `qr mode · ${collected}/${estNeeded} packets (${pct}%) for ${formatBytes(d.fileSize)} · ` +
        `${bandwidth > 0 ? formatBytes(Math.round(bandwidth)) : "—"}/s · ` +
        `${Number.isFinite(eta) && eta >= 0 ? `~${Math.max(1, Math.ceil(eta))}s left` : "estimating…"} · ` +
        `${decodedPct}% decoded (cascades near the end) · ` +
        `${d.duplicates} rescans` +
        (qrState.meta ? ` · ${qrState.meta.name}` : "");
  }

  function offerDownload(data: Uint8Array, name: string, mime: string, seconds: number): void {
    stopCamera();
    const blob = new Blob([data.buffer as ArrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const avg = formatBytes(Math.round(data.length / Math.max(seconds, 0.001)));
    result.classList.remove("hidden");
    result.innerHTML =
      `<p class="success">✓ Received <strong></strong> (${formatBytes(data.length)}) in ${seconds.toFixed(1)}s — ${avg}/s via ${lastTransport}, checksum verified.</p>
       <a class="button" id="dl" download>Save file</a>`;
    result.querySelector("strong")!.textContent = name;
    const a = result.querySelector<HTMLAnchorElement>("#dl")!;
    a.href = url;
    a.download = name;
  }

  function finishTile(): void {
    if (!tileReceiver) return;
    const name = tileReceiver.file_name() ?? "received.bin";
    const mime = tileReceiver.file_mime() ?? "application/octet-stream";
    const bytes = tileReceiver.take_file();
    if (!bytes) return;
    const seconds = (performance.now() - tileStartedAt) / 1000;
    offerDownload(bytes, name, mime, seconds);
  }

  function finishQr(): void {
    if (!qrState?.meta) return;
    const data = qrState.decoder.assemble();
    const ok = crc32(data) === qrState.meta.crc;
    const seconds = (performance.now() - qrState.startedAt) / 1000;
    if (!ok) {
      stopCamera();
      result.classList.remove("hidden");
      result.innerHTML = `<p class="error">✗ Checksum mismatch — the transfer completed but the data is corrupt. Try again.</p>`;
    } else {
      offerDownload(data, qrState.meta.name, qrState.meta.mime, seconds);
    }
    qrState = null;
  }

  async function scanLoop(): Promise<void> {
    while (scanning) {
      const img = grabFrame(1280);
      if (img && !tryTile(img)) {
        await tryQr(img);
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  async function startCamera(): Promise<void> {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (err) {
      stats.textContent = `Camera unavailable: ${err instanceof Error ? err.message : err}`;
      camWrap.classList.remove("hidden");
      return;
    }
    await setupDetector();
    core = await loadCore();
    tileReceiver?.free();
    tileReceiver = core ? new core.TileReceiver() : null;
    tileStartedAt = 0;
    video.srcObject = stream;
    await video.play();
    camWrap.classList.remove("hidden");
    startBtn.classList.add("hidden");
    result.classList.add("hidden");
    scanning = true;
    void scanLoop();
  }

  function stopCamera(): void {
    scanning = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    camWrap.classList.add("hidden");
    startBtn.classList.remove("hidden");
  }

  startBtn.addEventListener("click", () => void startCamera());
  stopBtn.addEventListener("click", stopCamera);
}
