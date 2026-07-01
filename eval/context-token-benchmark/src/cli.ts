/**
 * cli.ts — Benchmark harness entry point.
 *
 * Subcommands:
 *   pilot   — ⚠ METERED: small exploratory run (R=5). Billed to Anthropic API.
 *   confirm — ⚠ METERED: full confirmatory run. Billed to Anthropic API.
 *
 * IMPORTANT: `pilot` and `confirm` perform METERED Claude API runs.
 * They are gated — do NOT invoke them without:
 *   (a) clearing the spend gate (Phase 2 / Phase 4 pre-reg),
 *   (b) verifying the Anthropic API balance has enough margin, and
 *   (c) explicit per-conversation approval from the project owner.
 *
 * Usage:
 *   node dist/cli.js pilot   [options]
 *   node dist/cli.js confirm [options]
 *
 * Options:
 *   --results <path>      JSONL output file  (default: results.jsonl)
 *   --replicates <N>      Replicate count     (default: 5)
 *   --concurrency <N>     Parallel runs       (default: 3)
 *   --model <id>          Claude model ID     (default: claude-opus-4-8)
 *   --max-turns <N>       Max agent turns     (default: 30)
 *   --reruns <N>          Gate flake reruns   (default: 2)
 */

// Nothing executes at import time — safe to import.

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Arm, RepoSpec, TaskSpec } from "./types.js";
import { expandMatrix, orchestrate } from "./orchestrate.js";
import { runOne } from "./run-one.js";
import { buildRealDeps } from "./real-deps.js";
import { loadRepos as loadReposFromDir, loadTasks as loadTasksFromDir } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// __dirname equivalent for ESM: the harness root is one level above dist/
const HARNESS_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURES_DIR = join(HARNESS_ROOT, "fixtures");

// ---------------------------------------------------------------------------
// Arg parsing (hand-rolled; no external dep)
// ---------------------------------------------------------------------------

interface CliArgs {
  subcommand: "pilot" | "confirm";
  results: string;
  replicates: number;
  concurrency: number;
  model: string;
  maxTurns: number;
  reruns: number;
  /** Arms to run. Default all three; pass --arms C,T for a token-only A/B (no placebo). */
  arms: Arm[];
}

const ALL_ARMS: Arm[] = ["C", "P", "T"];

function parseArms(spec: string): Arm[] {
  const parsed = spec
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  for (const a of parsed) {
    if (a !== "C" && a !== "P" && a !== "T") {
      console.error(`Invalid arm "${a}" (expected C, P, or T)`);
      process.exit(1);
    }
  }
  if (parsed.length === 0) {
    console.error("--arms must list at least one of C,P,T");
    process.exit(1);
  }
  return parsed as Arm[];
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // drop node + script path

  const subcommand = args[0];
  if (subcommand !== "pilot" && subcommand !== "confirm") {
    console.error(
      `Usage: node dist/cli.js <pilot|confirm> [options]\n` +
        `  --results <path>    (default: results.jsonl)\n` +
        `  --replicates <N>    (default: 5)\n` +
        `  --concurrency <N>   (default: 3)\n` +
        `  --model <id>        (default: claude-opus-4-8)\n` +
        `  --max-turns <N>     (default: 30)\n` +
        `  --reruns <N>        (default: 2)\n` +
        `  --arms <C,P,T>      (default: C,P,T; use C,T for a token-only A/B)\n`,
    );
    process.exit(1);
  }

  // Defaults
  let results = "results.jsonl";
  let replicates = 5;
  let concurrency = 3;
  let model = "claude-opus-4-8";
  let maxTurns = 30;
  let reruns = 2;
  let arms: Arm[] = ALL_ARMS;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--results":
        results = args[++i] ?? results;
        break;
      case "--replicates":
        replicates = parseInt(args[++i] ?? String(replicates), 10);
        break;
      case "--concurrency":
        concurrency = parseInt(args[++i] ?? String(concurrency), 10);
        break;
      case "--model":
        model = args[++i] ?? model;
        break;
      case "--max-turns":
        maxTurns = parseInt(args[++i] ?? String(maxTurns), 10);
        break;
      case "--reruns":
        reruns = parseInt(args[++i] ?? String(reruns), 10);
        break;
      case "--arms":
        arms = parseArms(args[++i] ?? "");
        break;
      default:
        console.error(`Unknown flag: ${args[i]}`);
        process.exit(1);
    }
  }

  return {
    subcommand: subcommand as "pilot" | "confirm",
    results: resolve(results),
    replicates,
    concurrency,
    model,
    maxTurns,
    reruns,
    arms,
  };
}

// ---------------------------------------------------------------------------
// Fixture loaders
// ---------------------------------------------------------------------------

/** Load repos.json from fixtures/. Exits with a clear error if absent. */
async function loadRepos(): Promise<RepoSpec[]> {
  try {
    return await loadReposFromDir(FIXTURES_DIR);
  } catch {
    console.error(
      `[benchmark] fixtures/repos.json not found under ${FIXTURES_DIR}.\n` +
        `Fixtures arrive in Phase 2 — run the Phase 2 assembly steps first.`,
    );
    process.exit(1);
  }
}

/** Load all *.json files from fixtures/tasks/. Exits with a clear error if absent. */
async function loadTasks(): Promise<TaskSpec[]> {
  let tasks: TaskSpec[];
  try {
    tasks = await loadTasksFromDir(FIXTURES_DIR);
  } catch {
    console.error(
      `[benchmark] fixtures/tasks/ not found under ${FIXTURES_DIR}.\n` +
        `Fixtures arrive in Phase 2 — run the Phase 2 assembly steps first.`,
    );
    process.exit(1);
  }
  if (tasks.length === 0) {
    console.error(
      `[benchmark] No task JSON files found under ${FIXTURES_DIR}/tasks.\n` +
        `Fixtures arrive in Phase 2 — run the Phase 2 assembly steps first.`,
    );
    process.exit(1);
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// CLI entry point (called only when this file is the main module)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv);

  console.log(
    `[benchmark] ⚠  ${cliArgs.subcommand.toUpperCase()} — METERED RUN (bills Claude API)\n` +
      `            model=${cliArgs.model} replicates=${cliArgs.replicates} ` +
      `concurrency=${cliArgs.concurrency} max-turns=${cliArgs.maxTurns}\n` +
      `            results → ${cliArgs.results}`,
  );

  // Load fixtures (absent in Phase 1 — exits early with a clear error)
  const repos = await loadRepos();
  const tasks = await loadTasks();

  // Expand the matrix, then keep only the requested arms.
  const armSet = new Set(cliArgs.arms);
  const items = expandMatrix(repos, tasks, cliArgs.replicates).filter((i) => armSet.has(i.arm));
  console.log(
    `[benchmark] Matrix: ${items.length} runs total (arms=${cliArgs.arms.join(",")})`,
  );

  // Per-token USD rates for the PINNED model (claude-opus-4-8). Source: Anthropic
  // official pricing table (platform.claude.com/docs/.../pricing), fetched
  // 2026-06-26 — $5 input / $25 output / $6.25 5m-cache-write / $0.50 cache-read
  // per MTok. cacheWrite maps to the 5-minute ephemeral write (Claude Code's
  // default). VALIDATED against a real `claude -p --output-format stream-json`
  // call: usage × these rates reproduced the result event's total_cost_usd to the
  // cent ($0.05044225). Correct ONLY for claude-opus-4-8 — if --model changes,
  // update them (and keep inference_geo "global" / no fast-mode, or rates shift).
  const rates = {
    input: 5 / 1_000_000,
    output: 25 / 1_000_000,
    cacheWrite: 6.25 / 1_000_000,
    cacheRead: 0.5 / 1_000_000,
  };

  const depsCtx = { modelId: cliArgs.model, maxTurns: cliArgs.maxTurns };
  const runOneCtx = {
    modelId: cliArgs.model,
    cliVersion: "0.1.0", // harness version — update to match package.json
    maxTurns: cliArgs.maxTurns,
    reruns: cliArgs.reruns,
    rates,
  };

  // Wire runOne with real IO deps
  const summary = await orchestrate(items, {
    resultsPath: cliArgs.results,
    concurrency: cliArgs.concurrency,
    runOne: async (item) => {
      const deps = buildRealDeps(depsCtx);
      return runOne(
        item.repo,
        item.task,
        item.arm,
        item.replicate,
        runOneCtx,
        deps,
      );
    },
  });

  console.log(
    `[benchmark] Done — total=${summary.total} ran=${summary.ran} skipped=${summary.skipped}`,
  );
}

// Guard: only run when this file is the direct entry point (not on import)
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((err) => {
    console.error("[benchmark] Fatal:", err);
    process.exit(1);
  });
}
