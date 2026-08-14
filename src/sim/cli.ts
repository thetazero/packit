/**
 * Strategy-comparison harness. Run with:
 *
 *   npm run sim                                    # defaults: 8 KB, 3 trials, handheld
 *   npm run sim -- --scenarios steady,handheld,lowlight --trials 5
 *   npm run sim -- --size 16384 --seed 7
 *   npm run sim -- --dump /tmp/captures            # save synthesized camera frames as PGM
 *
 * Every scan attempt rasterizes real QR frames, pushes them through the
 * camera model, and runs jsQR — so runs take real CPU time. Scale --size /
 * --trials with patience.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS, type Capture } from "./camera";
import { defaultStrategies } from "./strategy";
import { makeTestFile, runTrials, simulateTransfer, type TrialSummary } from "./simulate";

interface Args {
  size: number;
  trials: number;
  seed: number;
  scenarios: string[];
  timeoutMin: number;
  dump: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    size: 8 * 1024,
    trials: 3,
    seed: 1,
    scenarios: ["lossless", "handheld"],
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
            "--timeout-min <n> --dump <dir>",
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
  const header = ["strategy", "done", "median", "p10..p90", "goodput", "overhead", "scan hit"];
  const cells = rows.map((r) => [
    r.strategy,
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

/** Binary PGM (P5) — trivially viewable, no encoder dependency needed. */
function writePgm(path: string, cap: Capture): void {
  const header = Buffer.from(`P5\n${cap.width} ${cap.height}\n255\n`, "ascii");
  const pixels = Buffer.alloc(cap.gray.length);
  for (let i = 0; i < cap.gray.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, Math.round(cap.gray[i])));
  }
  writeFileSync(path, Buffer.concat([header, pixels]));
}

const args = parseArgs(process.argv.slice(2));
const data = makeTestFile(args.size, args.seed);
const strategies = defaultStrategies();

if (args.dump) {
  const dir = args.dump;
  mkdirSync(dir, { recursive: true });
  const scenario = args.scenarios.find((s) => s !== "lossless") ?? "handheld";
  const camera = SCENARIOS[scenario] ?? bail(`unknown scenario "${scenario}"`);
  console.log(`dumping captures for "${strategies[0].name}" on "${scenario}" to ${dir}/`);
  let n = 0;
  simulateTransfer(strategies[0], camera, data, args.seed, {
    timeoutMs: 10_000,
    onCapture: (cap, tMs, decoded) => {
      if (n >= 12) return;
      const name = `t${String(Math.round(tMs)).padStart(5, "0")}ms-${decoded ? "ok" : "fail"}.pgm`;
      writePgm(join(dir, name), cap);
      n++;
    },
  });
  console.log(`${n} frames written`);
  process.exit(0);
}

console.log(
  `file: ${args.size} B · trials: ${args.trials} · seed: ${args.seed} · timeout: ${args.timeoutMin} min\n`,
);

for (const name of args.scenarios) {
  const camera =
    SCENARIOS[name] ?? bail(`unknown scenario "${name}" (have: ${Object.keys(SCENARIOS).join(", ")})`);
  console.log(`━━━ scenario: ${name} ━━━`);
  const rows: TrialSummary[] = [];
  for (const s of strategies) {
    rows.push(runTrials(s, camera, data, args.trials, args.seed, args.timeoutMin * 60 * 1000));
  }
  rows.sort((a, b) => (b.medianGoodputBps || 0) - (a.medianGoodputBps || 0));
  printTable(rows);
  console.log();
}
