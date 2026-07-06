/**
 * `vibedrift watch` — re-run the scan on file changes.
 *
 * Designed to run alongside an AI coding session (Claude Code, Cursor,
 * Copilot). Every time the agent writes or edits a file, the watcher
 * debounces for a few seconds and then runs a local scan with
 * `--write-context`. That refreshes `.vibedrift/context.md`,
 * `fix-plan.md`, and `patterns.json` so the AI assistant always has a
 * current view of the codebase's dominant patterns when it reads those
 * files on its next turn.
 *
 * Design constraints
 * ------------------
 *   - **Never writes into the user's source tree.** Only `.vibedrift/`
 *     outputs are touched (via `--write-context`).
 *   - **Zero network calls.** Forces `--local-only`. Deep scan + scan-log
 *     beaconing + fix-prompt synthesis are all disabled in watch mode.
 *     Network writes from a watcher that might fire many times per hour
 *     would be abusive to both the API and the user's quota.
 *   - **Debounced.** A burst of writes (e.g. an AI editing 5 files in
 *     sequence) collapses into one scan. Default debounce 10s; tunable
 *     via `--interval <seconds>`.
 *   - **Graceful on macOS/Windows/Linux.** Uses `fs.watch(root,
 *     { recursive: true })` which is fully supported on macOS and
 *     Windows. On Linux the recursive option is a no-op in some Node
 *     versions — we detect that at startup and fall back to a periodic
 *     poll of the discovered file list's mtimes. Either way, edits are
 *     picked up within one debounce interval.
 */

import { watch as fsWatch } from "fs";
import { readdir, stat } from "fs/promises";
import { join, relative, resolve } from "path";
import chalk from "chalk";
import { runScan } from "./scan.js";
import { resolveToken } from "../../auth/resolver.js";
import { readConfig } from "../../auth/config.js";
import { isPaidPlan } from "../../auth/plan.js";
import type { ScanOptions } from "../../core/types.js";

/** Ignore list — we don't want to fire rescans for editor tempfiles,
 *  build artifacts, dependencies, git internals, or VibeDrift's own
 *  output directory. Anything matching these segments is skipped. */
const IGNORE_SEGMENTS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  ".vercel",
  ".vibedrift",
  "coverage",
  ".nyc_output",
  ".turbo",
  ".cache",
];

const IGNORE_EXTENSIONS = [".log", ".lock", ".swp", ".tmp"];

function shouldIgnore(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/);
  for (const seg of parts) {
    if (IGNORE_SEGMENTS.includes(seg)) return true;
  }
  for (const ext of IGNORE_EXTENSIONS) {
    if (relPath.endsWith(ext)) return true;
  }
  return false;
}

export interface WatchOptions {
  intervalSeconds?: number;
  verbose?: boolean;
  /** Extra pattern passthrough to the scanner. Same semantics as `scan --include`. */
  include?: string[];
  /** Same semantics as `scan --exclude`. */
  exclude?: string[];
}

/**
 * Run the scan loop. Returns the installed cleanup function that closes
 * the watcher — intended for tests. The CLI never cleans up until the
 * user hits Ctrl-C, which terminates the process.
 */
export async function runWatch(
  targetPath: string,
  options: WatchOptions,
): Promise<() => void> {
  const rootDir = resolve(targetPath);
  const intervalSeconds = options.intervalSeconds ?? 10;
  if (intervalSeconds < 2 || intervalSeconds > 600) {
    console.error(`Error: --interval must be between 2 and 600 seconds.`);
    process.exit(1);
  }

  try {
    const info = await stat(rootDir);
    if (!info.isDirectory()) {
      console.error(`Error: ${rootDir} is not a directory.`);
      process.exit(1);
    }
  } catch {
    console.error(`Error: ${rootDir} does not exist.`);
    process.exit(1);
  }

  // Auth gate. Watch mode is the only way to get a continuous full
  // finding stream (terminal output AND `.vibedrift/` context files
  // written on every change). The equivalent one-shot scan gates full
  // output behind a free account — watch must do the same, or it
  // becomes a free backdoor that bypasses the gate.
  const token = await resolveToken();
  if (!token) {
    console.error(chalk.red("\nvibedrift watch requires a free account.\n"));
    console.error(chalk.dim("Watch mode emits full finding details and refreshes"));
    console.error(chalk.dim(".vibedrift/context.md, fix-plan.md, and fix-prompts.md"));
    console.error(chalk.dim("on every change — the equivalent one-shot scan gates"));
    console.error(chalk.dim("the same surface behind a signed-in account."));
    console.error("");
    console.error(chalk.yellow("  Sign in (takes 30 seconds, free forever):"));
    console.error(chalk.bold("    vibedrift login"));
    console.error("");
    console.error(chalk.dim("  Or if you just need a one-time scan without account:"));
    console.error(chalk.dim("    vibedrift ."));
    console.error("");
    process.exit(1);
  }

  // Continuous watch is a Pro feature (it re-scans on every change and
  // keeps the .vibedrift/ agent context fresh all session). Free runs one-shot
  // scans on demand. Cached-plan check — works offline.
  if (!isPaidPlan((await readConfig()).plan)) {
    console.error(chalk.red("\nvibedrift watch is a Pro feature.\n"));
    console.error(chalk.dim("Continuous drift watch re-scans on every file change and keeps"));
    console.error(chalk.dim(".vibedrift/ context fresh for your AI agent the whole session."));
    console.error("");
    console.error(`  ${chalk.yellow("Upgrade:")} ${chalk.bold("vibedrift upgrade")}`);
    console.error("");
    console.error(chalk.dim("  Free: run a one-shot scan any time with  vibedrift ."));
    console.error("");
    process.exit(1);
  }

  console.log(chalk.cyan(`\nVibeDrift watch — ${rootDir}`));
  console.log(
    chalk.dim(
      `  Signed in · Debounce: ${intervalSeconds}s · Outputs: .vibedrift/ · Network: off · Ctrl-C to stop.`,
    ),
  );
  console.log("");

  // Kick off an initial scan so .vibedrift/ is populated immediately,
  // even before any files change. AI agents started in a fresh terminal
  // should not have to wait for the first debounced edit.
  await runOnce(rootDir, options, /* initial */ true);

  let debounceHandle: NodeJS.Timeout | null = null;
  let running = false;
  let pendingChange = false;

  const fire = async () => {
    if (running) {
      // An event arrived while a previous scan was still running —
      // remember to rescan once the current one finishes so we don't
      // miss the edit that triggered it.
      pendingChange = true;
      return;
    }
    running = true;
    try {
      await runOnce(rootDir, options, /* initial */ false);
    } finally {
      running = false;
      if (pendingChange) {
        pendingChange = false;
        // Re-schedule with the same debounce so bursts continue to
        // coalesce rather than firing back-to-back scans.
        schedule();
      }
    }
  };

  const schedule = () => {
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => {
      debounceHandle = null;
      void fire();
    }, intervalSeconds * 1000);
  };

  // Try recursive fs.watch. If it throws (or quietly doesn't deliver
  // events on Linux), fall back to the polling loop.
  let watcher: ReturnType<typeof fsWatch> | null = null;
  let fallbackPoll: NodeJS.Timeout | null = null;

  try {
    watcher = fsWatch(rootDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      // Node's fs.watch callback types `filename` as `string | Buffer`
      // but TS narrows it to `never` in some setups when the encoding
      // is not passed. Cast through unknown for resilient cross-version
      // compatibility — we only use the string form.
      const rel = typeof filename === "string"
        ? filename
        : String(filename as unknown as { toString(): string });
      if (shouldIgnore(rel)) return;
      if (options.verbose) {
        console.log(chalk.dim(`  ~ changed: ${rel}`));
      }
      schedule();
    });
  } catch (err: unknown) {
    if (options.verbose) {
      console.log(
        chalk.dim(
          `  fs.watch recursive unavailable (${err instanceof Error ? err.message : "unknown"}) — falling back to poll mode.`,
        ),
      );
    }
  }

  if (!watcher) {
    // Polling fallback: at each interval tick, walk the tree once and
    // compare mtimes to the last snapshot. New or modified files trigger
    // a schedule(). Ignore list keeps the walk cheap.
    const mtimeSnapshot = await snapshotMtimes(rootDir);
    fallbackPoll = setInterval(async () => {
      const next = await snapshotMtimes(rootDir);
      if (anyDelta(mtimeSnapshot, next)) {
        // Update the snapshot before scheduling — avoids re-triggering
        // on the same change next tick.
        for (const [k, v] of next) mtimeSnapshot.set(k, v);
        schedule();
      }
    }, intervalSeconds * 1000);
  }

  const cleanup = () => {
    if (debounceHandle) clearTimeout(debounceHandle);
    if (watcher) watcher.close();
    if (fallbackPoll) clearInterval(fallbackPoll);
  };

  return cleanup;
}

/**
 * Run one local scan with the watch-specific flag set. Surfaces the
 * composite-score line so the user can see the trend at a glance in
 * their watcher terminal.
 */
async function runOnce(
  rootDir: string,
  options: WatchOptions,
  initial: boolean,
): Promise<void> {
  const scanOptions: ScanOptions = {
    format: "terminal",
    // Watch mode never runs deep (see module docstring).
    deep: false,
    localOnly: true,
    writeContext: true,
    verbose: options.verbose,
    cache: true,
    codedna: true,
    include: options.include,
    exclude: options.exclude,
    // Disable the diff banner on subsequent runs — the watcher already
    // makes "what changed" obvious by being the thing that reacted.
    compare: false,
  };

  const stamp = new Date().toLocaleTimeString();
  console.log(chalk.bold(`[${stamp}]${initial ? " initial scan" : " rescan"}`));
  try {
    await runScan(rootDir, scanOptions);
  } catch (err: unknown) {
    console.error(
      chalk.red(`  scan failed: ${err instanceof Error ? err.message : "unknown error"}`),
    );
  }
  console.log("");
}

/** Walk the tree once, recording mtime for every non-ignored file. */
async function snapshotMtimes(rootDir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  async function walk(dir: string): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = relative(rootDir, full).replace(/\\/g, "/");
      if (shouldIgnore(rel)) continue;
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(full);
      } else if (info.isFile()) {
        out.set(rel, info.mtimeMs);
      }
    }
  }
  await walk(rootDir);
  return out;
}

/** Detect if any file was added, removed, or touched since the snapshot. */
function anyDelta(prev: Map<string, number>, curr: Map<string, number>): boolean {
  if (prev.size !== curr.size) return true;
  for (const [k, v] of curr) {
    const p = prev.get(k);
    if (p === undefined || p !== v) return true;
  }
  return false;
}
