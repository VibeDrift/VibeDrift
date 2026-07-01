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
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

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
  // Large maxBuffer: `npm install` / clone output easily exceeds Node's 1MB
  // default, which would otherwise throw ENOBUFS and fail the run.
  const { stdout, stderr } = await execFileAsync("sh", ["-c", cmd], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout + stderr;
}

/**
 * Run a shell command string in `cwd`, returning stdout ONLY (stderr discarded).
 * Used for `git diff` capture where stderr warnings must not pollute the diff.
 * Large maxBuffer so big diffs are not truncated by the default 1MB cap.
 */
async function shStdout(cmd: string, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("sh", ["-c", cmd], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Max bytes of captured diff persisted per run (longer diffs are truncated). */
const MAX_DIFF_BYTES = 200_000;

/** Paths/globs always excluded from the judged diff (harness artifacts + build output). */
const DIFF_EXCLUDES = [
  ".mcp.json",
  "CLAUDE.md",
  "AGENTS.md",
  ".vibedrift",
  ".vibedrift/**",
];
const DIFF_EXCLUDE_GLOBS = ["**/node_modules/**", "**/dist/**", "**/build/**"];

// ---------------------------------------------------------------------------
// MCP wiring (Test-arm only)
// ---------------------------------------------------------------------------

const MCP_CONFIG_FILE = ".mcp.json";
/** The exact .mcp.json the Treatment arm writes to attach the VibeDrift MCP server. */
const MCP_CONFIG_JSON = `{"mcpServers":{"vibedrift":{"command":"vibedrift","args":["mcp"]}}}`;

/**
 * Harness-owned directive markers. The injected block is stripped from CLAUDE.md
 * before the blinded judge ever sees a diff (see captureBlindedDiff), so the
 * judge cannot tell which arm produced the change. Markers are intentionally
 * neutral (not "vibedrift") so the P-arm agent's CLAUDE.md does not advertise the
 * experiment.
 */
export const DIRECTIVE_START = "<!-- bench:directive:start -->";
export const DIRECTIVE_END = "<!-- bench:directive:end -->";

/**
 * Treatment (T) directive: VibeDrift "used as intended" — the persistent usage
 * guidance a real adopter commits to CLAUDE.md so the agent consults the MCP.
 */
const T_DIRECTIVE_BODY = `## Using VibeDrift (required for this repo)

This repository uses VibeDrift. Its MCP tools are the fastest way to stay consistent with the codebase — prefer them over manually grepping/reading many files. BEFORE writing or modifying code:
- Call \`get_dominant_pattern\` and \`get_intent_hints\` to learn this repo's conventions (naming, error handling, imports, async).
- Call \`find_similar_function\` before implementing any new function, to reuse existing code instead of duplicating it.
- After editing, call \`validate_change\` / \`check_file_drift\` to confirm the change matches the repo's dominant patterns.`;

/**
 * Instruction-only (P) directive: the SAME behavioral ask as T (match the repo's
 * conventions, reuse existing code) but with NO MCP — the agent must achieve it
 * by reading the codebase itself. This is the active placebo / strong baseline.
 * Deliberately names no tool, so T-vs-P isolates the MCP.
 */
const P_DIRECTIVE_BODY = `## Matching this repo's conventions (required)

Stay consistent with the existing codebase. BEFORE writing or modifying code:
- Read enough of the surrounding code to learn this repo's conventions (naming, error handling, imports, async) and follow them.
- Search the codebase for an existing function that already does what you need, and reuse it instead of writing a new one.
- After editing, re-check that your change matches the repo's prevailing patterns.`;

/** Per-prompt usage suffix appended to the Treatment-arm prompt (names the MCP). */
const T_USAGE_SUFFIX = `This repository has the VibeDrift MCP tools available (get_dominant_pattern, get_intent_hints, find_similar_function, check_file_drift, validate_change). Use them: check the repo's dominant patterns and search for similar existing functions BEFORE writing new code, and validate your change against the repo's patterns afterward.`;

/** Per-prompt usage suffix appended to the Instruction-only-arm prompt (no MCP). */
const P_USAGE_SUFFIX = `Stay consistent with this repository's existing conventions: read the surrounding code to learn its naming, error-handling, and import patterns and match them, and search for an existing function that already does what you need BEFORE writing a new one, reusing it instead of duplicating.`;

/** Idempotently append the given directive body to <cwd>/CLAUDE.md (P and T only). */
async function upsertDirective(cwd: string, body: string): Promise<void> {
  const path = join(cwd, "CLAUDE.md");
  let existing = "";
  try {
    existing = await readFile(path, "utf-8");
  } catch {
    // No CLAUDE.md yet — start empty.
  }
  if (existing.includes(DIRECTIVE_START)) return; // already present
  const block = `${DIRECTIVE_START}\n${body}\n${DIRECTIVE_END}`;
  const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(path, `${existing}${sep}${block}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// RunOneDeps implementation
// ---------------------------------------------------------------------------

export interface RealDepsCtx {
  modelId: string;
  maxTurns: number;
}

/**
 * Build a RunOneDeps instance backed by real IO: git, the vibedrift CLI
 * (local baseline warming), and the `claude` CLI (METERED — see runAgent below).
 */
export function buildRealDeps(_ctx: RealDepsCtx): RunOneDeps {
  return {
    /**
     * Clone the repo at the pinned SHA into a fresh temp directory and run the
     * repo's setup command. For the Test arm (T), warm the VibeDrift baseline
     * by running the local CLI (free, best-effort) so the MCP tools have a
     * computed dominance vote to answer from.
     *
     * Returns { cwd }.
     */
    async prepareWorkspace(
      repo: RepoSpec,
      arm: Arm,
      replicate: number,
    ): Promise<{ cwd: string }> {
      const cwd = await makeTmpDir(`bench-${repo.id}-r${replicate}`);

      // Clone the target repo at the pinned SHA (shallow to save bandwidth)
      await sh(`git clone --depth 1 ${repo.gitUrl} .`, cwd);
      await sh(`git fetch --depth 1 origin ${repo.sha}`, cwd);
      await sh(`git checkout ${repo.sha}`, cwd);

      // Run optional setup command (install dependencies, build, etc.)
      if (repo.setupCmd) {
        await sh(repo.setupCmd, cwd);
      }

      // Test arm: warm the local VibeDrift baseline so the MCP tools answer
      // from a computed dominance vote. This is LOCAL and FREE (--local-only),
      // NOT metered. Best-effort: swallow any error / non-zero exit.
      if (arm === "T") {
        try {
          await sh("vibedrift . --local-only --format terminal", cwd);
        } catch {
          // Best-effort warming only — ignore failures.
        }
      }

      return { cwd };
    },

    /**
     * Apply the arm-specific config.
     *
     * - Treatment (T): write <cwd>/.mcp.json attaching the VibeDrift MCP server
     *   AND commit the VibeDrift usage directive to CLAUDE.md.
     * - Instruction-only (P): commit the conventions directive to CLAUDE.md, and
     *   ensure NO .mcp.json (no MCP).
     * - Control (C): ensure no .mcp.json and no injected directive.
     *
     * The injected CLAUDE.md block is stripped before judging (captureBlindedDiff).
     */
    async applyArm(cwd: string, arm: Arm): Promise<void> {
      const mcpPath = join(cwd, MCP_CONFIG_FILE);
      if (arm === "T") {
        await writeFile(mcpPath, MCP_CONFIG_JSON, "utf-8");
        await upsertDirective(cwd, T_DIRECTIVE_BODY);
      } else if (arm === "P") {
        // Instruction-only: nudge in CLAUDE.md, but NO MCP.
        await rm(mcpPath, { force: true });
        await upsertDirective(cwd, P_DIRECTIVE_BODY);
      } else {
        // Control: no MCP, no nudge.
        await rm(mcpPath, { force: true });
      }
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
     * Restore the canonical tests AFTER the agent ran, BEFORE gating. The agent
     * runs with --dangerously-skip-permissions and could edit/delete the gate's
     * tests to pass; this guarantees the gated tests are exactly the patch's.
     * For each file the test patch touches: revert it to base (or remove it if
     * the patch added it), then re-apply the patch. Agent edits to OTHER files
     * (the actual source fix) are left untouched.
     */
    async reassertTests(cwd: string, task: TaskSpec): Promise<void> {
      if (!task.applyTestsPatch) return;
      const patch = task.applyTestsPatch;
      // `git apply --numstat` lists "added removed path" without applying.
      const numstat = await sh(`git apply --numstat ${patch}`, cwd);
      const paths = numstat
        .split("\n")
        .map((l) => l.trim().split(/\s+/).slice(2).join(" "))
        .filter(Boolean);
      for (const p of paths) {
        // Revert to base if tracked; if the patch ADDED the file, drop it.
        await sh(`git checkout -- "${p}" 2>/dev/null || rm -f "${p}"`, cwd);
      }
      // Re-apply the canonical test patch on the cleaned files.
      await sh(`git apply ${patch}`, cwd);
    },

    /**
     * ⚠ METERED BOUNDARY — PAID CLAUDE API USAGE ⚠
     *
     * This function constructs and executes:
     *   claude -p <task.prompt> \
     *     --model <modelId> \
     *     --max-turns <maxTurns> \
     *     --output-format stream-json \
     *     --verbose \
     *     --dangerously-skip-permissions \
     *     --strict-mcp-config \       (all arms: ignore host MCP config)
     *     [--mcp-config .mcp.json]   (Test arm only)
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
      arm: Arm,
      modelId: string,
      maxTurns: number,
    ): Promise<string> {
      // ⚠ METERED: each call to this function incurs paid Claude API usage.
      // T appends the MCP-naming usage suffix; P appends the equivalent
      // conventions nudge (no MCP); C gets the bare task prompt. The suffix is
      // paired with the CLAUDE.md directive written in applyArm.
      const prompt =
        arm === "T"
          ? `${task.prompt}\n\n${T_USAGE_SUFFIX}`
          : arm === "P"
            ? `${task.prompt}\n\n${P_USAGE_SUFFIX}`
            : task.prompt;
      return new Promise<string>((resolve, reject) => {
        const args = [
          "-p",
          prompt,
          "--model",
          modelId,
          "--max-turns",
          String(maxTurns),
          "--output-format",
          "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
          // CRITICAL for a clean A/B: ignore the operator's user/project MCP
          // config (e.g. a globally-installed playwright/gmail server) and use
          // ONLY what we pass via --mcp-config. Without this, EVERY arm inherits
          // the host's MCP servers, so Control is not MCP-free and both arms
          // carry extra tool-definition tokens — contaminating the comparison.
          "--strict-mcp-config",
        ];

        // Treatment arm only: attach the VibeDrift MCP server via the cwd-local
        // config. With --strict-mcp-config this is the ONLY server T loads;
        // C and P load none.
        if (arm === "T") {
          args.push("--mcp-config", MCP_CONFIG_FILE);
        }

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
     * Capture the agent's BLINDED source diff. Non-destructive: stages all
     * changes (respecting .gitignore), diffs the index against the base commit
     * EXCLUDING harness artifacts (.mcp.json, the injected CLAUDE.md/AGENTS.md
     * directive, .vibedrift/) and the task's own test files, then resets the
     * index so the working tree is unchanged for the subsequent gate.
     *
     * The excludes are why the judge stays blind: the diff it scores carries no
     * .mcp.json, no directive, no .vibedrift — nothing that reveals the arm.
     */
    async captureDiff(cwd: string, task: TaskSpec, _arm: Arm) {
      try {
        // The task's test-patch files are excluded (identical across arms; the
        // judge scores source edits, not tests).
        let testPaths: string[] = [];
        if (task.applyTestsPatch) {
          const numstat = await sh(
            `git apply --numstat ${task.applyTestsPatch}`,
            cwd,
          ).catch(() => "");
          testPaths = numstat
            .split("\n")
            .map((l) => l.trim().split(/\s+/).slice(2).join(" "))
            .filter(Boolean);
        }

        const excludeArgs = [
          ...DIFF_EXCLUDES.map((p) => `':(exclude)${p}'`),
          ...testPaths.map((p) => `':(exclude)${p}'`),
          ...DIFF_EXCLUDE_GLOBS.map((g) => `':(exclude,glob)${g}'`),
        ].join(" ");

        // Stage everything so brand-new untracked files (e.g. a reimplemented
        // helper the agent created) appear in the diff too.
        await sh("git add -A", cwd);
        let diff = "";
        try {
          diff = await shStdout(
            `git diff --cached HEAD -- . ${excludeArgs}`,
            cwd,
          );
        } finally {
          // Unstage (mixed reset to HEAD); working tree stays as the agent left it.
          await sh("git reset -q", cwd).catch(() => undefined);
        }

        if (diff.length > MAX_DIFF_BYTES) {
          return {
            diff: diff.slice(0, MAX_DIFF_BYTES) + "\n…[diff truncated]…\n",
            truncated: true,
          };
        }
        return { diff, truncated: false };
      } catch {
        // Diff capture must never fail a run.
        return { diff: "", truncated: false };
      }
    },

    /**
     * Run the acceptance gate: execute `cmd` in `cwd` with up to
     * `reruns` retries to detect flaky tests. Delegates to the
     * shared runAcceptanceGate from gate.ts.
     */
    async gate(cwd: string, cmd: string, reruns: number) {
      return runAcceptanceGate(cwd, cmd, reruns);
    },

    /**
     * Remove the run's workspace (fresh clone + node_modules can be hundreds of
     * MB). Best-effort: a cleanup failure must not fail the run.
     */
    async cleanup(cwd: string): Promise<void> {
      try {
        await rm(cwd, { recursive: true, force: true });
      } catch {
        // Best-effort — ignore.
      }
    },
  };
}
