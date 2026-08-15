import { formatBytes } from "./sender";
import { loadCore, type Core } from "./wasm";
import type { TileReceiver } from "./wasm/pkg/packit_core";

interface TileStatus {
  recognized: boolean;
  packets: number;
  needed: number;
  haveMeta: boolean;
  done: boolean;
}

export function initReceiver(root: HTMLElement): void {
  root.innerHTML = `
    <div class="panel">
      <button id="start-cam">Start camera</button>
      <div class="cam-wrap hidden" id="cam-wrap">
        <video id="cam" playsinline muted></video>
        <div class="progress"><div class="progress-bar" id="progress-bar"></div></div>
        <div class="stats" id="recv-stats">Point the camera at the code and hold close — it should fill most of the view.</div>
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
  let core: Core | null = null;
  let tileReceiver: TileReceiver | null = null;
  let tileStartedAt = 0;

  const scanCanvas = document.createElement("canvas");
  const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true })!;

  function grabFrame(maxW: number): ImageData | null {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    const scale = Math.min(1, maxW / video.videoWidth);
    scanCanvas.width = Math.floor(video.videoWidth * scale);
    scanCanvas.height = Math.floor(video.videoHeight * scale);
    scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
    return scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
  }

  function processFrame(img: ImageData): void {
    if (!tileReceiver) return;
    const bytes = new Uint8Array(img.data.buffer, 0, img.data.length);
    const status = JSON.parse(tileReceiver.push_frame(bytes, img.width, img.height)) as TileStatus;
    if (!status.recognized) return;
    if (tileStartedAt === 0) tileStartedAt = performance.now();
    updateProgress(status);
    if (status.done) finish();
  }

  function updateProgress(s: TileStatus): void {
    const cap = core ? core.frameCapacity() : 9632;
    const pct = s.done ? 100 : Math.min(99, Math.floor((s.packets / Math.max(1, s.needed)) * 100));
    progressBar.style.width = `${pct}%`;
    const elapsed = (performance.now() - tileStartedAt) / 1000;
    const bandwidth = elapsed > 0.5 ? (s.packets * cap) / elapsed : 0;
    const eta = bandwidth > 0 ? (Math.max(1, s.needed - s.packets) * cap) / bandwidth : Infinity;
    stats.textContent =
      `${s.packets}/${s.needed} packets (${pct}%) · ` +
      `${bandwidth > 0 ? formatBytes(Math.round(bandwidth)) : "—"}/s · ` +
      `${Number.isFinite(eta) ? `~${Math.max(1, Math.ceil(eta))}s left` : "estimating…"}` +
      (s.haveMeta ? "" : " · waiting for metadata…");
  }

  function offerDownload(data: Uint8Array, name: string, mime: string, seconds: number): void {
    stopCamera();
    const blob = new Blob([data.buffer as ArrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const avg = formatBytes(Math.round(data.length / Math.max(seconds, 0.001)));
    result.classList.remove("hidden");
    result.innerHTML =
      `<p class="success">✓ Received <strong></strong> (${formatBytes(data.length)}) in ${seconds.toFixed(1)}s — ${avg}/s, checksum verified.</p>
       <a class="button" id="dl" download>Save file</a>`;
    result.querySelector("strong")!.textContent = name;
    const a = result.querySelector<HTMLAnchorElement>("#dl")!;
    a.href = url;
    a.download = name;
  }

  function finish(): void {
    if (!tileReceiver) return;
    const name = tileReceiver.file_name() ?? "received.bin";
    const mime = tileReceiver.file_mime() ?? "application/octet-stream";
    const bytes = tileReceiver.take_file();
    if (!bytes) return;
    const seconds = (performance.now() - tileStartedAt) / 1000;
    offerDownload(bytes, name, mime, seconds);
  }

  async function scanLoop(): Promise<void> {
    while (scanning) {
      // The code must span >= ~820 camera pixels to decode; never downscale
      // below the camera's native resolution (the old 1280 cap made a
      // landscape 1080p frame 1280x720 — a square code could never fit the
      // 820px floor). 2560 only bounds cost on 4K cameras.
      const img = grabFrame(2560);
      if (img) processFrame(img);
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  async function startCamera(): Promise<void> {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 2560 }, height: { ideal: 1440 } },
        audio: false,
      });
    } catch (err) {
      stats.textContent = `Camera unavailable: ${err instanceof Error ? err.message : err}`;
      camWrap.classList.remove("hidden");
      return;
    }
    core = await loadCore();
    if (!core) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      stats.textContent = "This browser can't load the codec (WebAssembly unavailable).";
      camWrap.classList.remove("hidden");
      return;
    }
    tileReceiver?.free();
    tileReceiver = new core.TileReceiver();
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
