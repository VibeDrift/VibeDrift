/**
 * real-deps.ts — IO-bound RunOneDeps factory for real benchmark runs.
 *
 * NOT unit-tested (every function here is IO / metered). Each function is
 * small and clearly commented so it can be inspected during Phase 2 review.
 *
 * ⚠ METERED BOUNDARY: runAgent constructs and executes `claude -p …`.
 * Only call this module from the gated `pilot` / `confirm` subcommands.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { buildArmBlock } from "./arm-block.js";
import { runAcceptanceGate } from "./gate.js";
import type { RunOneDeps } from "./run-one.js";
import type { RepoSpec, TaskSpec, Arm } from "./types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp subdirectory for one run. */
async function makeTmpDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Run a shell command string in `cwd`, returning combined stdout+stderr.
 * Throws on non-zero exit.
 */
async function sh(cmd: string, cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("sh", ["-c", cmd], { cwd });
  return stdout + stderr;
}

/**
 * Generate a context.md for `repoDir` by invoking the VibeDrift CLI
 * with `--write-context`. Returns the file contents.
 *
 * Requires `vibedrift` (the CLI) to be on PATH or resolved via npx.
 * `--write-context` writes `.vibedrift/context.md` inside the repo.
 */
async function generateContextMd(repoDir: string): Promise<string> {
  // Run the shipped vibedrift CLI to produce the context file.
  // The CLI exits 0 on success and writes .vibedrift/context.md.
  await sh("npx --yes vibedrift --write-context", repoDir);
  const contextPath = join(repoDir, ".vibedrift", "context.md");
  return readFile(contextPath, "utf-8");
}

// ---------------------------------------------------------------------------
// Managed-block writer (arm wiring into CLAUDE.md)
// ---------------------------------------------------------------------------

const CLAUDE_MD = "CLAUDE.md";
const MANAGED_BLOCK_START =
  "<!-- vibedrift:context:start (auto-generated, do not edit by hand) -->";
const MANAGED_BLOCK_END = "<!-- vibedrift:context:end -->";

/**
 * Upsert or remove the VibeDrift managed block in `<cwd>/CLAUDE.md`.
 *
 * - arm "C" (control): ensures NO managed block is present.
 * - arm "T" or "P": writes the arm-specific block (build via buildArmBlock).
 *
 * Preserves any content outside the managed block markers.
 */
async function writeArmBlock(
  cwd: string,
  arm: Arm,
  ownContextMd: string,
  placeboContextMd: string,
): Promise<void> {
  const path = join(cwd, CLAUDE_MD);
  let existing = "";
  try {
    existing = await readFile(path, "utf-8");
  } catch {
    // File doesn't exist yet; start empty
  }

  // Strip any existing managed block
  const startIdx = existing.indexOf(MANAGED_BLOCK_START);
  const endIdx = existing.indexOf(MANAGED_BLOCK_END);
  let base = existing;
  if (startIdx !== -1 && endIdx !== -1) {
    base =
      existing.slice(0, startIdx) +
      existing.slice(endIdx + MANAGED_BLOCK_END.length);
  }

  const block = buildArmBlock(arm, ownContextMd, placeboContextMd);
  const content = block ? base.trimEnd() + "\n\n" + block + "\n" : base;
  await writeFile(path, content, "utf-8");
}

// ---------------------------------------------------------------------------
// RunOneDeps implementation
// ---------------------------------------------------------------------------

export interface RealDepsCtx {
  modelId: string;
  maxTurns: number;
}

/**
 * Build a RunOneDeps instance backed by real IO: git, vibedrift CLI, and
 * the `claude` CLI (METERED — see runAgent below).
 */
export function buildRealDeps(ctx: RealDepsCtx): RunOneDeps {
  return {
    /**
     * Clone the repo at the pinned SHA into a fresh temp directory,
     * run the repo's setup command, and generate context.md files for
     * both the own repo and the placebo repo.
     *
     * Returns { cwd, ownContextMd, placeboContextMd }.
     */
    async prepareWorkspace(
      repo: RepoSpec,
      _arm: Arm,
      replicate: number,
    ): Promise<{ cwd: string; ownContextMd: string; placeboContextMd: string }> {
      const cwd = await makeTmpDir(`bench-${repo.id}-r${replicate}`);

      // Clone the target repo at the pinned SHA (shallow to save bandwidth)
      await sh(`git clone --depth 1 ${repo.gitUrl} .`, cwd);
      await sh(`git fetch --depth 1 origin ${repo.sha}`, cwd);
      await sh(`git checkout ${repo.sha}`, cwd);

      // Run optional setup command (install dependencies, build, etc.)
      if (repo.setupCmd) {
        await sh(repo.setupCmd, cwd);
      }

      // Generate the own context.md (Treatment arm)
      const ownContextMd = await generateContextMd(cwd);

      // Generate the placebo context.md from the placeboFrom repo.
      // We need the placebo repo — clone it into a sibling temp dir.
      const placeboDir = await makeTmpDir(
        `bench-${repo.placeboFrom}-placebo-r${replicate}`,
      );
      await sh(`git clone --depth 1 ${repo.gitUrl} .`, placeboDir);
      // NOTE: We don't have the placebo repo's URL here; in practice the
      // fixture will carry it. For now we re-use the own repo URL as a
      // structural placeholder — the Phase 2 fixtures spec will wire the
      // correct URL from a repo registry keyed by placeboFrom.
      const placeboContextMd = await generateContextMd(placeboDir);

      return { cwd, ownContextMd, placeboContextMd };
    },

    /**
     * Write the arm-specific VibeDrift block into <cwd>/CLAUDE.md.
     * Control (C) removes any existing block; T/P inject context.
     */
    async applyArm(
      cwd: string,
      arm: Arm,
      ownContextMd: string,
      placeboContextMd: string,
    ): Promise<void> {
      await writeArmBlock(cwd, arm, ownContextMd, placeboContextMd);
    },

    /**
     * Apply the task's test patch (if any) via `git apply`.
     * This installs the merged-PR tests BEFORE the agent runs, so the
     * gate can verify the agent's implementation.
     */
    async applyTestsPatch(cwd: string, task: TaskSpec): Promise<void> {
      if (!task.applyTestsPatch) return;
      await sh(`git apply ${task.applyTestsPatch}`, cwd);
    },

    /**
     * ⚠ METERED BOUNDARY — PAID CLAUDE API USAGE ⚠
     *
     * This function constructs and executes:
     *   claude -p <task.prompt> \
     *     --model <modelId> \
     *     --max-turns <maxTurns> \
     *     --output-format stream-json \
     *     --verbose
     *
     * Every invocation bills against the Anthropic API key. This function
     * MUST only be called from the gated `pilot` and `confirm` subcommands
     * after the spend gate has been cleared (Phase 2 / Phase 4).
     *
     * Returns the raw stdout (stream-json lines) for usage parsing.
     */
    async runAgent(
      cwd: string,
      task: TaskSpec,
      modelId: string,
      maxTurns: number,
    ): Promise<string> {
      // ⚠ METERED: each call to this function incurs paid Claude API usage.
      return new Promise<string>((resolve, reject) => {
        const args = [
          "-p",
          task.prompt,
          "--model",
          modelId,
          "--max-turns",
          String(maxTurns),
          "--output-format",
          "stream-json",
          "--verbose",
        ];

        const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];

        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

        child.on("error", reject);
        child.on("close", (code) => {
          const stdout = Buffer.concat(chunks).toString("utf-8");
          // Non-zero exit is tolerated: max-turns hit returns non-zero but
          // still emits valid stream-json stdout. We parse and classify later.
          if (code !== 0 && stdout.length === 0) {
            const stderr = Buffer.concat(errChunks).toString("utf-8");
            reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
          } else {
            resolve(stdout);
          }
        });
      });
    },

    /**
     * Run the acceptance gate: execute `cmd` in `cwd` with up to
     * `reruns` retries to detect flaky tests. Delegates to the
     * shared runAcceptanceGate from gate.ts.
     */
    async gate(cwd: string, cmd: string, reruns: number) {
      return runAcceptanceGate(cwd, cmd, reruns);
    },
  };
}
