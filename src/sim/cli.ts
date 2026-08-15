/**
 * Bandwidth-validation harness for the tile codec. Run with:
 *
 *   npm run sim                                    # 64 KB, 3 trials, lossless + handheld
 *   npm run sim -- --scenarios steady,handheld,lowlight --trials 5
 *   npm run sim -- --size 262144 --seed 7 --fps 8,15,30
 *   npm run sim -- --dump /tmp/captures            # save synthesized camera frames as PPM
 *
 * Every scan attempt renders real sender frames, pushes them through the
 * camera model, and runs the production wasm decoder — so runs take real CPU
 * time. Scale --size / --trials with patience.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS, type Capture } from "./camera";
import { loadCore } from "./core";
import { makeTestFile, runTrials, simulateTransfer, type SenderConfig, type TrialSummary } from "./simulate";

interface Args {
  size: number;
  trials: number;
  seed: number;
  scenarios: string[];
  fps: number[];
  timeoutMin: number;
  dump: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    size: 64 * 1024,
    trials: 3,
    seed: 1,
    scenarios: ["lossless", "handheld"],
    fps: [4, 8, 15, 30],
    timeoutMin: 5,
    dump: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => argv[++i] ?? bail(`missing value for ${argv[i - 1]}`);
    switch (argv[i]) {
      case "--size":
        args.size = Number(next());
        break;
      case "--trials":
        args.trials = Number(next());
        break;
      case "--seed":
        args.seed = Number(next());
        break;
      case "--scenarios":
        args.scenarios = next().split(",");
        break;
      case "--fps":
        args.fps = next().split(",").map(Number);
        break;
      case "--timeout-min":
        args.timeoutMin = Number(next());
        break;
      case "--dump":
        args.dump = next();
        break;
      case "--help":
        console.log(
          "options: --size <bytes> --trials <n> --seed <n> " +
            `--scenarios <${Object.keys(SCENARIOS).join("|")},...> ` +
            "--fps <n,n,...> --timeout-min <n> --dump <dir>",
        );
        process.exit(0);
        break;
      default:
        bail(`unknown option ${argv[i]}`);
    }
  }
  return args;
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "—";
  return bps >= 1024 ? `${(bps / 1024).toFixed(2)} KB/s` : `${bps.toFixed(0)} B/s`;
}

function printTable(rows: TrialSummary[]): void {
  const header = ["sender", "done", "median", "p10..p90", "goodput", "overhead", "scan hit"];
  const cells = rows.map((r) => [
    r.sender,
    `${Math.round(r.completionRate * 100)}%`,
    fmtMs(r.medianMs),
    `${fmtMs(r.p10Ms)}..${fmtMs(r.p90Ms)}`,
    fmtBps(r.medianGoodputBps),
    Number.isFinite(r.meanOverhead) ? `${((r.meanOverhead - 1) * 100).toFixed(0)}%` : "—",
    `${Math.round(r.scanSuccessRate * 100)}%`,
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...cells.map((row) => row[c].length)));
  const line = (row: string[]): string => row.map((cell, c) => cell.padEnd(widths[c])).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of cells) console.log(line(row));
}

/** Binary PPM (P6) — trivially viewable color, no encoder dependency needed. */
function writePpm(path: string, cap: Capture): void {
  const header = Buffer.from(`P6\n${cap.width} ${cap.height}\n255\n`, "ascii");
  const plane = cap.width * cap.height;
  const pixels = Buffer.alloc(plane * 3);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      pixels[i * 3 + c] = Math.max(0, Math.min(255, Math.round(cap.rgb[c * plane + i])));
    }
  }
  writeFileSync(path, Buffer.concat([header, pixels]));
}

const args = parseArgs(process.argv.slice(2));
const data = makeTestFile(args.size, args.seed);
const configs: SenderConfig[] = args.fps.map((fps) => ({ name: `sender @${fps}fps`, fps }));
const core = await loadCore();

if (args.dump) {
  const dir = args.dump;
  mkdirSync(dir, { recursive: true });
  const scenario = args.scenarios.find((s) => s !== "lossless") ?? "handheld";
  const camera = SCENARIOS[scenario] ?? bail(`unknown scenario "${scenario}"`);
  console.log(`dumping captures for "${configs[0].name}" on "${scenario}" to ${dir}/`);
  let n = 0;
  simulateTransfer(core, configs[0], camera, data, args.seed, {
    timeoutMs: 10_000,
    onCapture: (cap, tMs, recognized) => {
      if (n >= 12) return;
      const name = `t${String(Math.round(tMs)).padStart(5, "0")}ms-${recognized ? "ok" : "fail"}.ppm`;
      writePpm(join(dir, name), cap);
      n++;
    },
  });
  console.log(`${n} frames written`);
  process.exit(0);
}

console.log(
  `codec: packit-core ${core.version()} · file: ${args.size} B · trials: ${args.trials} · ` +
    `seed: ${args.seed} · timeout: ${args.timeoutMin} min\n`,
);

for (const name of args.scenarios) {
  const camera =
    SCENARIOS[name] ?? bail(`unknown scenario "${name}" (have: ${Object.keys(SCENARIOS).join(", ")})`);
  console.log(`━━━ scenario: ${name} ━━━`);
  const rows: TrialSummary[] = [];
  for (const c of configs) {
    rows.push(runTrials(core, c, camera, data, args.trials, args.seed, args.timeoutMin * 60 * 1000));
  }
  rows.sort((a, b) => (b.medianGoodputBps || 0) - (a.medianGoodputBps || 0));
  printTable(rows);
  console.log();
}
