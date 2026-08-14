import jsQR from "jsqr";
import { LTDecoder } from "./lib/lt";
import { crc32 } from "./lib/crc32";
import { parsePacket, type MetaPacket } from "./lib/packet";
import { formatBytes } from "./sender";

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

interface ReceiveState {
  fileId: number;
  decoder: LTDecoder;
  meta: MetaPacket | null;
  framesSeen: number;
  startedAt: number;
}

export function initReceiver(root: HTMLElement): void {
  root.innerHTML = `
    <div class="panel">
      <button id="start-cam">Start camera</button>
      <div class="cam-wrap hidden" id="cam-wrap">
        <video id="cam" playsinline muted></video>
        <div class="progress"><div class="progress-bar" id="progress-bar"></div></div>
        <div class="stats" id="recv-stats">Point the camera at the sender's QR stream.</div>
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
  let state: ReceiveState | null = null;

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

  async function readQR(): Promise<string | null> {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    if (detector) {
      try {
        const codes = await detector.detect(video);
        return codes[0]?.rawValue ?? null;
      } catch {
        // Fall through to jsQR if the native detector chokes.
      }
    }
    const scale = Math.min(1, 720 / video.videoWidth);
    scanCanvas.width = Math.floor(video.videoWidth * scale);
    scanCanvas.height = Math.floor(video.videoHeight * scale);
    scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
    const img = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    return code?.data ?? null;
  }

  function handleText(text: string): void {
    const packet = parsePacket(text);
    if (!packet) return;

    if (!state || state.fileId !== packet.fileId) {
      state = {
        fileId: packet.fileId,
        decoder: new LTDecoder(packet.k, packet.blockSize, packet.fileSize),
        meta: null,
        framesSeen: 0,
        startedAt: performance.now(),
      };
      result.classList.add("hidden");
    }
    state.framesSeen++;
    if (packet.type === "meta") {
      state.meta = packet;
    } else {
      state.decoder.addPacket(packet.seed, packet.payload);
    }
    updateProgress();
    if (state.decoder.done && state.meta) finish();
  }

  function updateProgress(): void {
    if (!state) return;
    const d = state.decoder;
    // LT decoding avalanches: almost no blocks solve until ~k packets have
    // arrived, then everything cascades. Packet collection is the honest,
    // linear progress signal; solved blocks would read ~0% until the cliff.
    const estNeeded = Math.ceil(d.k * 1.12) + 2;
    const collected = d.packetsUsed;
    const pct = d.done ? 100 : Math.min(99, Math.floor((collected / estNeeded) * 100));
    progressBar.style.width = `${pct}%`;
    const elapsed = (performance.now() - state.startedAt) / 1000;
    // Incoming rate over the wire: unique packets × payload per second.
    const bandwidth = elapsed > 0.5 ? (collected * d.blockSize) / elapsed : 0;
    const eta =
      bandwidth > 0 ? (Math.max(1, estNeeded - collected) * d.blockSize) / bandwidth : Infinity;
    const decodedPct = Math.floor((d.solvedCount / d.k) * 100);
    stats.textContent = d.done
      ? `decoded ${formatBytes(d.fileSize)} — waiting for metadata frame…`
      : `${collected}/${estNeeded} packets (${pct}%) for ${formatBytes(d.fileSize)} · ` +
        `${bandwidth > 0 ? formatBytes(Math.round(bandwidth)) : "—"}/s · ` +
        `${Number.isFinite(eta) && eta >= 0 ? `~${Math.max(1, Math.ceil(eta))}s left` : "estimating…"} · ` +
        `${decodedPct}% decoded (cascades near the end) · ` +
        `${d.duplicates} rescans` +
        (state.meta ? ` · ${state.meta.name}` : "");
  }

  function finish(): void {
    if (!state?.meta) return;
    const data = state.decoder.assemble();
    const ok = crc32(data) === state.meta.crc;
    const seconds = (performance.now() - state.startedAt) / 1000;
    const avgBandwidth = formatBytes(Math.round(data.length / Math.max(seconds, 0.001)));
    stopCamera();
    const blob = new Blob([data.buffer as ArrayBuffer], { type: state.meta.mime });
    const url = URL.createObjectURL(blob);
    result.classList.remove("hidden");
    result.innerHTML = ok
      ? `<p class="success">✓ Received <strong></strong> (${formatBytes(data.length)}) in ${seconds.toFixed(1)}s — ${avgBandwidth}/s, checksum verified.</p>
         <a class="button" id="dl" download>Save file</a>`
      : `<p class="error">✗ Checksum mismatch — the transfer completed but the data is corrupt. Try again.</p>`;
    if (ok) {
      result.querySelector("strong")!.textContent = state.meta.name;
      const a = result.querySelector<HTMLAnchorElement>("#dl")!;
      a.href = url;
      a.download = state.meta.name;
    }
    state = null;
  }

  async function scanLoop(): Promise<void> {
    while (scanning) {
      const text = await readQR();
      if (text) handleText(text);
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  async function startCamera(): Promise<void> {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      stats.textContent = `Camera unavailable: ${err instanceof Error ? err.message : err}`;
      camWrap.classList.remove("hidden");
      return;
    }
    await setupDetector();
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
