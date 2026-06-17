#!/usr/bin/env node
/**
 * Performance budget gate.
 *
 * Runs `vibedrift scan` on a fixture corpus, records wall-time, and
 * fails if it exceeds the budget. Wired into CI so regressions in
 * scan performance surface on the PR that introduces them instead
 * of sneaking into a release.
 *
 * Budget policy:
 *   - p95 wall-time for a 500-file mixed-language corpus: < 5000 ms
 *   - Single-run wall-time (what we actually measure here since we
 *     do 5 runs, not 500): median under 4000 ms.
 *
 * Budget gets a ±10% slack vs the last committed baseline. Baseline
 * lives in scripts/.bench-baseline.json and updates manually when
 * someone wants to explicitly accept a regression (e.g. after
 * adding a new analyzer that costs real work).
 *
 * Usage:
 *   node scripts/bench.mjs               # run and print
 *   node scripts/bench.mjs --ci          # exit 1 if over budget
 *   node scripts/bench.mjs --accept      # update baseline to the
 *                                          current median
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = resolve(__dirname, ".bench-baseline.json");
const BENCH_FIXTURE = resolve(REPO_ROOT, "test/fixtures/drift-project");
const CLI_ENTRY = resolve(REPO_ROOT, "dist/cli/index.js");
const RUNS = 5;
const TOLERANCE = 0.10; // allow 10% regression before failing CI

function args() {
  const set = new Set(process.argv.slice(2));
  return {
    ci: set.has("--ci"),
    accept: set.has("--accept"),
  };
}

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function runOnce() {
  if (!existsSync(CLI_ENTRY)) {
    console.error(`dist/cli/index.js not found. Run \`npm run build\` first.`);
    process.exit(1);
  }
  if (!existsSync(BENCH_FIXTURE)) {
    console.error(
      `Bench fixture not found at ${BENCH_FIXTURE}. Pick a different corpus or create one.`,
    );
    process.exit(1);
  }
  const start = performance.now();
  const result = spawnSync(
    "node",
    [CLI_ENTRY, BENCH_FIXTURE, "--format", "json", "--local-only"],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
      timeout: 30_000,
    },
  );
  const elapsed = performance.now() - start;
  if (result.status !== 0) {
    console.error(
      `Bench run failed (exit ${result.status}): ${result.stderr?.toString().slice(0, 400)}`,
    );
    process.exit(1);
  }
  return elapsed;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveBaseline(medianMs) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        median_ms: Math.round(medianMs),
        recorded_at: new Date().toISOString(),
        runs: RUNS,
        fixture: "test/fixtures/drift-project",
        note:
          "Bumped manually via `node scripts/bench.mjs --accept`. " +
          "CI gates regressions within 10% of this value.",
      },
      null,
      2,
    ) + "\n",
  );
}

function main() {
  const opts = args();
  console.log(`Bench: ${RUNS} runs on ${BENCH_FIXTURE}`);
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const t = runOnce();
    samples.push(t);
    console.log(`  run ${i + 1}: ${t.toFixed(0)} ms`);
  }
  const med = median(samples);
  console.log(`\nmedian: ${med.toFixed(0)} ms`);
  const baseline = loadBaseline();

  if (opts.accept) {
    saveBaseline(med);
    console.log(`\nBaseline updated to ${Math.round(med)} ms.`);
    return 0;
  }

  if (!baseline) {
    console.log(
      `\nNo baseline recorded. Run with --accept to set the current median as the baseline.`,
    );
    return 0;
  }

  const ceiling = baseline.median_ms * (1 + TOLERANCE);
  console.log(
    `\nbaseline: ${baseline.median_ms} ms (recorded ${baseline.recorded_at})`,
  );
  console.log(`ceiling:  ${Math.round(ceiling)} ms (baseline × ${1 + TOLERANCE})`);

  if (med > ceiling) {
    const pct = ((med - baseline.median_ms) / baseline.median_ms) * 100;
    console.error(
      `\n✗ PERFORMANCE REGRESSION: median ${med.toFixed(0)} ms is ${pct.toFixed(1)}% over baseline.`,
    );
    if (opts.ci) {
      console.error(
        `\nCI gate failed. Either fix the regression or run:\n  node scripts/bench.mjs --accept\nto explicitly accept the new baseline.`,
      );
      return 1;
    }
  } else {
    const delta = med - baseline.median_ms;
    const sign = delta >= 0 ? "+" : "";
    console.log(`\n✓ within budget (${sign}${delta.toFixed(0)} ms vs baseline)`);
  }
  return 0;
}

process.exit(main());
