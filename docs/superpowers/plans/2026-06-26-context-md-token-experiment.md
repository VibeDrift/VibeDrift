# context.md Token-Savings Experiment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `context.md` auto-inject CLI feature, then build and run a pre-registered controlled benchmark that measures whether inlining a repo's `context.md` lowers the USD cost to reach a passing solution under Claude Code headless.

**Architecture:** Phase 0 adds an idempotent managed-block injector to the existing `@vibedrift/cli` (TypeScript/ESM). Phase 1 builds a self-contained benchmark harness under `vibe-drift/eval/context-token-benchmark/` that, per (repo × task × arm × replicate), clones a repo at a pinned SHA, applies the arm's `CLAUDE.md` block, runs `claude -p`, captures per-turn token usage, runs a deterministic acceptance gate, and records a JSONL row. Phases 2–5 are operational runbooks: an expanded pilot to estimate variance and cost, a frozen pre-registration + a TDD'd Python analysis script, a spend-gated confirmatory run on Fly, and the analysis + blog.

**Tech Stack:** Node ≥18.17, TypeScript 5.x (ESM, strict), Commander.js, vitest (CLI + harness); Python 3.13 + pandas + lifelines + statsmodels (analysis); Fly Machines + Docker (execution); `claude` CLI headless.

## Global Constraints

- **Audit-first:** only claims this design supports may reach a reader; suppress or explicitly label anything uncertain. (workspace CLAUDE.md)
- **Reframed claim (verbatim):** "inlining the content of a repo's `.vibedrift/context.md` into the agent's instructions lowers the dollar cost to produce a solution that passes the repo's own tests, at no loss of success rate, under Claude Code headless with one pinned model, on these repos." Never "VibeDrift saves your tokens."
- **Primary contrast = T vs P** (wrong-repo placebo). T vs C is the secondary "total real-world delta." Overall claim needs BOTH to pass (intersection-union).
- **Primary endpoint = USD** (input/output/cache-write/cache-read broken out), joint with a non-inferiority success-rate guardrail. MEI set in dollars before the pilot.
- **No metered confirmatory run** launches before: pilot variance/feasibility verdict → projected USD range → Sami tops up the Claude balance (balance is not API-queryable). (memory: flag-metered-spend, cloud-for-long-runs)
- **CLI conventions (vibe-drift/CLAUDE.md):** ESM, path alias `@/* → src/*`; named exports only; async/await (no `.then()`); throw on error (no null/error-shape returns); camelCase vars/functions; tests `describe/it` with vitest, `vi.fn`/`vi.mock`; commit format `feat|fix|docs(scope): description`; ALWAYS update `README.md` when CLI flags change.
- **Pilot runs are excluded from the confirmatory dataset.**
- **v1 is single-harness (Claude Code headless);** aider second-harness check is parked (spec §11), top promotion candidate at pilot sizing.
- **Determinism:** seed/temperature are unavailable on current models — never claim them; frame results as a distribution shift. Pin the EXACT model ID string (never an alias) + Claude Code version.
- Never commit build artifacts or `.env`. Don't auto-commit onto unrelated branches; Phase 0 work goes on its own branch.

**Spec:** `vibe-drift/docs/superpowers/specs/2026-06-26-context-md-token-savings-experiment-design.md` (read it before starting).

---

## File Structure

**Phase 0 (in `vibe-drift/`):**
- Create: `src/output/inject-context.ts` — managed-block upsert + file injection (pure + IO).
- Create: `test/unit/output/inject-context.test.ts` — unit tests.
- Modify: `src/core/types.ts:348` — add `injectContext?: boolean` to `ScanOptions`.
- Modify: `src/cli/index.ts:84-87` (add `--inject-context` option) and `:164` (map into ScanOptions).
- Modify: `src/cli/commands/scan.ts:444-470` — `writeContextIfRequested` guard + inject call.
- Modify: `README.md` — document `--inject-context`.
- Modify: `CHANGELOG.md` — add entry.

**Phase 1 (new, self-contained under `vibe-drift/eval/context-token-benchmark/`):**
- `package.json`, `tsconfig.json`, `vitest.config.ts` — isolated from the published package.
- `src/types.ts` — `Arm`, `RepoSpec`, `TaskSpec`, `PerTurnUsage`, `RunResult`, `Rates`.
- `src/pricing.ts` — `computeRunCostUsd`.
- `src/usage.ts` — `parseClaudeUsage` (aggregate per-turn usage from `claude -p` JSON).
- `src/arm-block.ts` — `buildArmBlock`.
- `src/gate.ts` — `runAcceptanceGate` + flake re-test.
- `src/run-one.ts` — one (repo,task,arm,replicate) run end-to-end.
- `src/store.ts` — `appendResult` / `loadResults` (JSONL).
- `src/orchestrate.ts` — matrix iteration, arm-order randomization, resume.
- `src/cli.ts` — entrypoint (`pilot` / `confirm` subcommands).
- `fixtures/` — committed config: `repos.json`, `tasks/`, pinned SHAs.
- `test/` — `*.test.ts` mirroring `src/`.

**Phase 3 (new):**
- `vibe-drift/eval/context-token-benchmark/analysis/analyze.py` — frozen estimator.
- `.../analysis/test_analyze.py` — tests on simulated data with a known effect.
- `.../analysis/requirements.txt`.

---

# PHASE 0 — Ship `context.md` auto-inject (vibe-drift CLI)

> Do all Phase 0 work on a dedicated branch: `git checkout -b feat/inject-context` (off `main`, not the current `feat/scoring-decompression`).

### Task 0.1: Idempotent managed-block upsert (pure function)

**Files:**
- Create: `src/output/inject-context.ts`
- Test: `test/unit/output/inject-context.test.ts`

**Interfaces:**
- Produces: `MANAGED_BLOCK_START`, `MANAGED_BLOCK_END` (string consts); `upsertManagedBlock(existing: string, blockBody: string): string` — returns file content with exactly one managed block. If markers exist, replaces the content between them; otherwise appends the block (separated by a blank line). Idempotent: `upsert(upsert(x)) === upsert(x)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/output/inject-context.test.ts
import { describe, it, expect } from "vitest";
import {
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  upsertManagedBlock,
} from "../../../src/output/inject-context.js";

describe("upsertManagedBlock", () => {
  it("appends a fenced managed block when none exists", () => {
    const out = upsertManagedBlock("# My Rules\n", "hello patterns");
    expect(out).toContain("# My Rules");
    expect(out).toContain(MANAGED_BLOCK_START);
    expect(out).toContain("hello patterns");
    expect(out).toContain(MANAGED_BLOCK_END);
  });

  it("replaces the block body on re-run instead of duplicating it", () => {
    const once = upsertManagedBlock("# Rules\n", "v1 body");
    const twice = upsertManagedBlock(once, "v2 body");
    expect(twice.split(MANAGED_BLOCK_START).length - 1).toBe(1); // exactly one block
    expect(twice).toContain("v2 body");
    expect(twice).not.toContain("v1 body");
  });

  it("is idempotent for identical input", () => {
    const a = upsertManagedBlock("# Rules\n", "same");
    const b = upsertManagedBlock(a, "same");
    expect(b).toBe(a);
  });

  it("preserves text outside the markers untouched", () => {
    const base = "# Top\n\nkeep me\n";
    const out = upsertManagedBlock(base, "block");
    expect(out.startsWith("# Top\n\nkeep me")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/output/inject-context.test.ts`
Expected: FAIL — cannot find module `inject-context.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/output/inject-context.ts
/**
 * Idempotently injects VibeDrift's context.md content into an AI-rules file
 * (CLAUDE.md by default) inside a managed, clearly-delimited block. Re-running
 * replaces the block in place — it never duplicates or corrupts surrounding text.
 */
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

export const MANAGED_BLOCK_START = "<!-- vibedrift:context:start (auto-generated, do not edit by hand) -->";
export const MANAGED_BLOCK_END = "<!-- vibedrift:context:end -->";

export function upsertManagedBlock(existing: string, blockBody: string): string {
  const block = `${MANAGED_BLOCK_START}\n${blockBody}\n${MANAGED_BLOCK_END}`;
  const startIdx = existing.indexOf(MANAGED_BLOCK_START);
  const endIdx = existing.indexOf(MANAGED_BLOCK_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MANAGED_BLOCK_END.length);
    return `${before}${block}${after}`;
  }
  const sep = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${block}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/output/inject-context.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/output/inject-context.ts test/unit/output/inject-context.test.ts
git commit -m "feat(output): idempotent managed-block upsert for context injection"
```

### Task 0.2: File-level injection (read → upsert → write)

**Files:**
- Modify: `src/output/inject-context.ts`
- Test: `test/unit/output/inject-context.test.ts`

**Interfaces:**
- Consumes: `upsertManagedBlock`, `buildContextMarkdown` is NOT used here (caller passes the rendered body).
- Produces: `injectContext(rootDir: string, contextMd: string, targets?: string[]): Promise<string[]>` — default `targets = ["CLAUDE.md"]`; for each target, reads the file (empty string if missing), wraps `contextMd` with a one-line provenance header, upserts the block, writes the file, and returns the list of written relative paths. Throws on write failure (per "throw on error" convention).

- [ ] **Step 1: Write the failing test**

```ts
// append to test/unit/output/inject-context.test.ts
import { mkdtemp, readFile as rf, writeFile as wf, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { injectContext } from "../../../src/output/inject-context.js";

describe("injectContext", () => {
  it("creates CLAUDE.md with the block when the file is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vd-inject-"));
    const written = await injectContext(dir, "# VibeDrift Context\nbody");
    expect(written).toEqual(["CLAUDE.md"]);
    const content = await rf(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("# VibeDrift Context");
    expect(content).toContain("vibedrift:context:start");
  });

  it("updates an existing CLAUDE.md without losing prior content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vd-inject-"));
    await wf(join(dir, "CLAUDE.md"), "# House rules\nkeep me\n");
    await injectContext(dir, "patterns v1");
    await injectContext(dir, "patterns v2");
    const content = await rf(join(dir, "CLAUDE.md"), "utf8");
    expect(content).toContain("keep me");
    expect(content).toContain("patterns v2");
    expect(content).not.toContain("patterns v1");
    expect(content.split("vibedrift:context:start").length - 1).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/output/inject-context.test.ts`
Expected: FAIL — `injectContext` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/output/inject-context.ts
export async function injectContext(
  rootDir: string,
  contextMd: string,
  targets: string[] = ["CLAUDE.md"],
): Promise<string[]> {
  const body = `> The block below is VibeDrift's distilled view of this repo's dominant patterns and open drift. It is regenerated by \`vibedrift --write-context --inject-context\`. Read it before editing code here.\n\n${contextMd}`;
  const written: string[] = [];
  for (const target of targets) {
    const path = join(rootDir, target);
    let existing = "";
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = "";
    }
    await writeFile(path, upsertManagedBlock(existing, body));
    written.push(target);
  }
  return written;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/output/inject-context.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/output/inject-context.ts test/unit/output/inject-context.test.ts
git commit -m "feat(output): write context block into CLAUDE.md idempotently"
```

### Task 0.3: Wire `--inject-context` into the CLI

**Files:**
- Modify: `src/core/types.ts` (after line 348)
- Modify: `src/cli/index.ts` (after line 87; and the options map near line 164)
- Modify: `src/cli/commands/scan.ts` (`writeContextIfRequested`, lines 444–470)
- Test: `test/unit/cli/inject-context-wiring.test.ts` (new)

**Interfaces:**
- Consumes: `injectContext` from `@/output/inject-context.js`, `buildContextMarkdown` from `@/output/context-md.js`.
- Produces: `ScanOptions.injectContext?: boolean`. When set, `writeContextIfRequested` injects the freshly-built context markdown into `CLAUDE.md` (independent of `--write-context`).

- [ ] **Step 1: Add the ScanOptions field**

In `src/core/types.ts`, immediately after line 348 (`writeContext?: boolean;`):

```ts
  /** Inject context.md content into CLAUDE.md inside a managed block (idempotent). */
  injectContext?: boolean;
```

- [ ] **Step 2: Add the CLI option and map it**

In `src/cli/index.ts`, after line 87 (the `--write-context` option close `)`):

```ts
  .option(
    "--inject-context",
    "inject the context summary into CLAUDE.md inside a managed block (idempotent; pairs with --write-context)",
  )
```

And in the ScanOptions object near line 164, after `writeContext: options.writeContext,`:

```ts
      injectContext: options.injectContext,
```

- [ ] **Step 3: Write the failing test (scan applies injection)**

```ts
// test/unit/cli/inject-context-wiring.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// writeContextIfRequested is module-private; export it for testing via a thin re-export.
import { __test_writeContextIfRequested as writeContextIfRequested } from "../../../src/cli/commands/scan.js";

function fakeResult() {
  return {
    compositeScore: 80,
    maxCompositeScore: 100,
    context: { dominantLanguage: "typescript", files: [{}, {}], totalLines: 1000 },
    driftFindings: [],
    findings: [],
  } as any;
}

describe("--inject-context wiring", () => {
  it("writes a managed block into CLAUDE.md when injectContext is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vd-wire-"));
    await writeContextIfRequested(fakeResult(), { injectContext: true } as any, dir);
    const claude = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("vibedrift:context:start");
    expect(claude).toContain("Vibe Drift Score");
  });

  it("does nothing when neither writeContext nor injectContext is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vd-wire-"));
    await writeContextIfRequested(fakeResult(), {} as any, dir);
    await expect(readFile(join(dir, "CLAUDE.md"), "utf8")).rejects.toBeTruthy();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/unit/cli/inject-context-wiring.test.ts`
Expected: FAIL — `__test_writeContextIfRequested` not exported / no injection.

- [ ] **Step 5: Update `writeContextIfRequested` and add the test re-export**

In `src/cli/commands/scan.ts`, change the guard at line 449 and add injection. Replace the function body so it: (a) returns early only when BOTH flags are off; (b) writes `.vibedrift/` files only when `writeContext`; (c) injects when `injectContext`:

```ts
async function writeContextIfRequested(
  result: ScanResult,
  options: ScanOptions,
  rootDir: string,
): Promise<void> {
  if (!options.writeContext && !options.injectContext) return;
  const { basename } = await import("path");
  const projectName = options.projectName ?? basename(rootDir);
  try {
    if (options.writeContext) {
      const { writeContextFiles } = await import("../../output/context-md.js");
      const { written, note } = await writeContextFiles(rootDir, result, projectName);
      console.log("");
      console.log(chalk.green(`  ✓ Wrote ${written.length} files to .vibedrift/`));
      for (const f of written) console.log(chalk.dim(`    ${f}`));
      if (note) {
        console.log("");
        console.log(chalk.yellow(`    ${note}`));
      } else {
        console.log(chalk.dim("    Commit these to share your codebase's dominant patterns with your team."));
      }
      console.log("");
    }
    if (options.injectContext) {
      const { buildContextMarkdown } = await import("../../output/context-md.js");
      const { injectContext } = await import("../../output/inject-context.js");
      const md = buildContextMarkdown(result, projectName);
      const injected = await injectContext(rootDir, md);
      console.log(chalk.green(`  ✓ Injected context into ${injected.join(", ")}`));
    }
  } catch (err: any) {
    console.error(chalk.red(`  ✗ Failed to write/inject context: ${err.message}`));
  }
}

// Test-only re-export (kept at module scope, tree-shaken from the bundle).
export const __test_writeContextIfRequested = writeContextIfRequested;
```

- [ ] **Step 6: Run tests + typecheck + build**

Run: `npx vitest run test/unit/cli/inject-context-wiring.test.ts && npm run typecheck && npm run build`
Expected: tests PASS; typecheck clean; build succeeds.

- [ ] **Step 7: Manual smoke (real repo)**

Run: `node dist/cli/index.js . --write-context --inject-context --local-only`
Expected: prints "Injected context into CLAUDE.md"; `CLAUDE.md` gains exactly one `vibedrift:context` block; re-running does not duplicate it.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/cli/index.ts src/cli/commands/scan.ts test/unit/cli/inject-context-wiring.test.ts
git commit -m "feat(cli): add --inject-context to write context into CLAUDE.md"
```

### Task 0.4: Docs + changelog + full suite

**Files:**
- Modify: `README.md` (usage/flags + an example line), `CHANGELOG.md`, the CLI help epilog in `src/cli/index.ts:332` area.

- [ ] **Step 1: Update README** flags table and examples to include `--inject-context` (and that it pairs with `--write-context`). Add to the help epilog near line 332: `$ vibedrift --write-context --inject-context   refresh .vibedrift + inject into CLAUDE.md`.
- [ ] **Step 2: Add a CHANGELOG entry** under the next version heading: "Added `--inject-context` to inline the context summary into CLAUDE.md inside an idempotent managed block."
- [ ] **Step 3: Run the full suite + lint:** `npm test && npm run lint && npm run build` — Expected: all green.
- [ ] **Step 4: Commit:** `git add README.md CHANGELOG.md src/cli/index.ts && git commit -m "docs: document --inject-context flag"`
- [ ] **Step 5: Open a PR** for `feat/inject-context`. Do NOT `npm publish` — publishing is a separate, explicitly-approved step (memory: publish-safety). Releasing this feature is the gate that makes the experiment's treatment a shipped path.

---

# PHASE 1 — Benchmark harness (single-harness, Claude Code headless)

> Detailed bite-sizing for the integration tasks (1.5–1.8) is expanded in conversation right before Phase 1 starts (per vibe-drift convention: per-phase detail expanded before each phase). The pure-logic tasks below are fully specified now.

### Task 1.1: Scaffold the isolated harness package

**Files:** Create `eval/context-token-benchmark/{package.json,tsconfig.json,vitest.config.ts}` and `src/`, `test/`, `fixtures/` dirs.

- [ ] **Step 1:** Create `package.json` (`"type": "module"`, scripts: `test: vitest run`, `build: tsc -p tsconfig.json`), deps: none beyond devDeps `typescript`, `vitest`, `@types/node`. Shell-outs use `node:child_process`.
- [ ] **Step 2:** Create `tsconfig.json` (ESM, `strict: true`, `moduleResolution: bundler`, `outDir dist`).
- [ ] **Step 3:** Create `vitest.config.ts` with `include: ["test/**/*.test.ts"]`.
- [ ] **Step 4:** `cd eval/context-token-benchmark && npm install && npx vitest run` — Expected: "no tests" exit 0.
- [ ] **Step 5:** Commit `chore(eval): scaffold context-token-benchmark harness`.

### Task 1.2: Core types

**Files:** Create `eval/context-token-benchmark/src/types.ts`, test `test/types.test.ts` (a compile/shape smoke).

**Interfaces — Produces (exact shapes later tasks rely on):**

```ts
export type Arm = "C" | "P" | "T";

export interface Rates { // USD per token
  input: number; output: number; cacheWrite: number; cacheRead: number;
}

export interface PerTurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface RepoSpec {
  id: string; language: string; gitUrl: string; sha: string;
  testCmd: string; setupCmd?: string;
  /** Repo id whose context.md is used as this repo's wrong-repo placebo. */
  placeboFrom: string;
  postCutoff: boolean; // pretraining-contamination stratum
}

export interface TaskSpec {
  id: string; repoId: string; kind: "positive" | "negative-control";
  prompt: string;            // the instruction given to claude -p
  applyTestsPatch?: string;  // path to the merged-PR test patch to apply before gating
  gateTestCmd: string;       // deterministic acceptance command
}

export interface RunResult {
  runId: string; repoId: string; taskId: string; arm: Arm; replicate: number;
  modelId: string; cliVersion: string;
  usage: PerTurnUsage;       // summed across all turns
  costUsd: number;
  passed: boolean; censored: boolean; // censored = hit --max-turns / budget
  competingFailure: boolean;          // finished but wrong
  compactionEvents: number;
  startedAt: string; durationMs: number;
}
```

- [ ] Steps: write a test asserting the literal union and a sample object typechecks; implement; `npx vitest run`; commit `feat(eval): harness core types`.

### Task 1.3: USD cost accounting (pure, TDD)

**Files:** Create `src/pricing.ts`, test `test/pricing.test.ts`.

**Interfaces — Produces:** `computeRunCostUsd(usage: PerTurnUsage, rates: Rates): number`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { computeRunCostUsd } from "../src/pricing.js";

const rates = { input: 1e-6, output: 5e-6, cacheWrite: 1.25e-6, cacheRead: 0.1e-6 };

describe("computeRunCostUsd", () => {
  it("sums each token class at its own rate", () => {
    const usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 400, cache_read_input_tokens: 5000 };
    const cost = computeRunCostUsd(usage, rates);
    // 1000*1e-6 + 200*5e-6 + 400*1.25e-6 + 5000*0.1e-6
    expect(cost).toBeCloseTo(0.001 + 0.001 + 0.0005 + 0.0005, 10);
  });
  it("is zero for an empty run", () => {
    expect(computeRunCostUsd({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, rates)).toBe(0);
  });
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement:

```ts
import type { PerTurnUsage, Rates } from "./types.js";
export function computeRunCostUsd(u: PerTurnUsage, r: Rates): number {
  return u.input_tokens * r.input + u.output_tokens * r.output +
    u.cache_creation_input_tokens * r.cacheWrite + u.cache_read_input_tokens * r.cacheRead;
}
```

- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(eval): USD cost accounting with broken-out token classes`.

### Task 1.4: Aggregate per-turn usage from `claude -p` output (pure, TDD)

**Files:** Create `src/usage.ts`, test `test/usage.test.ts`, fixture `test/fixtures/claude-stream.jsonl`.

**Interfaces — Produces:** `parseClaudeUsage(stdout: string): { usage: PerTurnUsage; compactionEvents: number; turns: number }`. Sums `usage` across every assistant/result event in `claude -p --output-format stream-json`, not just the final event.

- [ ] **Step 1:** Capture a small real fixture: run `claude -p "say hi" --output-format stream-json --max-turns 1` on a throwaway dir, save 2–3 JSON lines (each with a `usage` object) to the fixture. (If unavailable in CI, hand-author a representative fixture matching the documented stream-json schema.)
- [ ] **Step 2: Failing test** asserting the summed `input_tokens`/`output_tokens`/cache fields equal the per-line sums, and `turns` counts events.
- [ ] **Step 3:** Implement line-by-line JSON parse, tolerate non-JSON lines, sum `message.usage`/`usage` fields, count `compact`/`compaction` events if present.
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat(eval): aggregate per-turn token usage from claude -p`.

### Task 1.5: Arm-block builder (pure, TDD)

**Files:** Create `src/arm-block.ts`, test `test/arm-block.test.ts`.

**Interfaces — Produces:** `buildArmBlock(arm: Arm, ownContextMd: string, placeboContextMd: string): string | null`. C → `null` (no block). P → block from `placeboContextMd` (wrong-repo). T → block from `ownContextMd`. Reuses the CLI's managed-block markers so the rendered CLAUDE.md byte-matches the shipped path; P and T must be token-comparable (assert in a later integration check via `count_tokens`).

- [ ] Steps: TDD that C returns null, P uses placebo content, T uses own content, both wrapped in the managed markers; implement; run; commit `feat(eval): build per-arm CLAUDE.md block`.

### Task 1.6: Acceptance gate + flake control (integration; child_process mocked in unit tests)

**Files:** Create `src/gate.ts`, test `test/gate.test.ts`.

**Interfaces — Produces:** `runAcceptanceGate(cwd: string, cmd: string, reruns: number): Promise<{ passed: boolean; flaky: boolean }>`. Runs `cmd`; on failure re-runs up to `reruns` times; `passed` only if a run passes; `flaky=true` if results disagree across reruns.

- [ ] Steps: unit-test with a `runner` injection (default = real `spawn`, test passes a fake that returns scripted exit codes) covering pass-first-try, fail-then-pass (flaky), consistent-fail; implement; run; commit `feat(eval): acceptance gate with flake re-test`.

### Task 1.7: One-run orchestration (integration)

**Files:** Create `src/run-one.ts`, `src/store.ts`, tests with mocked clone/agent.

**Interfaces — Produces:** `runOne(repo, task, arm, replicate, ctx): Promise<RunResult>` — fresh `git clone --depth 1` + `checkout sha` into a temp dir, run `setupCmd`, apply the arm block to `CLAUDE.md`, run `claude -p <task.prompt> --model <pinned> --max-turns <cap> --output-format stream-json` capturing stdout, apply `applyTestsPatch`, run the gate, compute cost via `computeRunCostUsd`, build a `RunResult`, append via `appendResult`. `appendResult(path, row)` / `loadResults(path)` use JSONL.

- [ ] Steps: TDD `store.ts` round-trip (append → load) fully; for `run-one.ts`, inject the clone/agent/gate functions so the unit test drives a fully-mocked happy path + a censored path (max-turns) + a competing-failure path; implement; run; commit per sub-piece.

### Task 1.8: Matrix orchestrator + resume + arm-order randomization

**Files:** Create `src/orchestrate.ts`, `src/cli.ts`, tests.

**Interfaces — Produces:** `orchestrate(specs, opts)` iterates `repos × tasks × arms × replicates`, randomizes arm order per (task,replicate) using a per-index varied seed (no `Math.random`), skips rows already present in the JSONL (resume), bounds concurrency, and writes results incrementally. `cli.ts` exposes `pilot` and `confirm` subcommands reading `fixtures/repos.json` + `fixtures/tasks/`.

- [ ] Steps: TDD that orchestrate is resumable (pre-seeded JSONL rows are not re-run) and respects the concurrency cap with a mocked `runOne`; implement; run; full harness suite green; commit `feat(eval): matrix orchestrator with resume`.

---

# PHASE 2 — Expanded pilot (operational runbook)

**Goal:** estimate within-task SD/CV of log(cost), the per-run cost distribution, and a feasibility verdict — for a fraction of the confirmatory cost. Pilot runs are excluded from the confirmatory dataset.

- [ ] **2.1 Assemble pilot fixtures:** pick ≥6 OSS repos (TS/Py/Rust/Go), pin SHAs, write `repos.json` with `testCmd`/`setupCmd`/`placeboFrom`/`postCutoff`. Include both pre-cutoff and post-cutoff repos.
- [ ] **2.2 Mine ~4 tasks/repo from merged-PR history** (positive: PRs touching files with an open drift item; plus ≥1 negative-control each). Author prompts + record each PR's test command as `gateTestCmd`; save the PR's test patch. Author BEFORE generating any context.md; the author does not read context.md content. Record the selection funnel.
- [ ] **2.3 Generate treatment + placebo context.md** for each repo via the shipped `vibedrift --write-context` at the pinned SHA; build each repo's placebo from its `placeboFrom` repo. Verify P and T are token-comparable via `claude` token counting.
- [ ] **2.4 Characterize flake:** run each repo's pristine `gateTestCmd` ~20× locally; quarantine non-deterministic tests; pin the selection. Record per-repo flake rate.
- [ ] **2.5 Set the dollar MEI now** (business grounds), before seeing pilot effects. Record it in the spec/pre-reg.
- [ ] **2.6 Run the pilot** (locally or a single small Fly machine): `node dist/cli.js pilot`. Small R (e.g. 5). This IS metered — state the (small) projected pilot spend and top up first.
- [ ] **2.7 Produce the variance/feasibility report:** within-task SD/CV of log(cost), cost distribution per arm, observed compaction rates per arm, and the required confirmatory run count to detect the dollar MEI at 80% power (sized off the UPPER bound of the pilot variance CI, inflated 25–40%). **Decision gate:** if the SNR implies an impractical run count, raise the MEI or stop. Also decide here whether to promote any parked arms (aider / staleness / C′).

---

# PHASE 3 — Freeze pre-registration + analysis script

- [ ] **3.1 Freeze the pre-registration:** finalize spec §14 open knobs (repo list+SHAs, PR-sampling rule, pinned model ID, R vs K, dollar MEI, cold-vs-warm caching, NI margin, optional arms). Commit + tag with a timestamp BEFORE any confirmatory run.
- [ ] **3.2 Write the analysis script (TDD on simulated data):** `analysis/analyze.py` implementing the frozen plan — within-task paired log-cost ratios (T−P primary, T−C secondary) with cluster bootstrap CIs; success-rate binomial NI test; cost-to-pass AFT/survival with right-censoring for max-turn runs and a competing-risks/cure term for finished-but-wrong; arithmetic-mean cost ratio (Gamma/log-link); fixed-sequence gatekeeping; per-stratum (contaminated vs fresh) reporting.
- [ ] **3.3 Tests (`test_analyze.py`):** simulate datasets with a KNOWN injected effect (e.g. T is 20% cheaper) and assert the estimator recovers it within CI; simulate a NULL and assert the gatekeeping does not declare a win; simulate differential success (collider scenario) and assert the joint estimand is not fooled. `pytest` green.
- [ ] **3.4 Commit the frozen script** (it is run as-is on confirmatory data; no post-hoc edits).

---

# PHASE 4 — Gated confirmatory run on Fly

- [ ] **4.1 Containerize:** Dockerfile with `claude` CLI + git + node/python/rust/go toolchains; harness `dist/`. Build + push.
- [ ] **4.2 Fly setup:** app/machine sized for clones + test suites; `ANTHROPIC_API_KEY` (metered key, not subscription) as a Fly secret; a volume for JSONL; periodic push of results to a results repo / object storage; batch exits on completion.
- [ ] **4.3 Spend gate (HARD):** publish the projected confirmatory USD range from the pilot cost model (× pinned rates, incl. cache-write multipliers + flake/censor re-run overhead). **Sami tops up the Claude balance with margin. No launch before this.**
- [ ] **4.4 Launch unattended on Fly**; monitor remotely via pushed results; confirm arm-order randomization, cache isolation, and that censored/max-turn runs are recorded. Re-run only failed/flaky rows (resume).
- [ ] **4.5 Pull the complete JSONL** when the batch exits.

---

# PHASE 5 — Analysis + blog

- [ ] **5.1 Run the frozen `analyze.py`** on the confirmatory JSONL. Report from that script only; secondary/exploratory cuts clearly labeled.
- [ ] **5.2 Fresh-eyes fact-check** every headline claim against the raw data (audit-first: a dedicated independent pass for user-facing output).
- [ ] **5.3 Assemble the reproducibility package** (spec §13): harness, Docker image, task defs + funnel, SHAs, prompts + CLAUDE.md blocks, per-run logs, raw cost data, frozen analysis script, exact model ID + CLI version + pricing date, 1–2 sample context.md artifacts.
- [ ] **5.4 Write the blog:** lead with product impact + the MCP-moat framing (memory: writing-style — public posts lead with impact, no em-dashes), method in an appendix, and the residual risks (spec §12: vendor-run, unshipped-on-other-agents scope, single harness, contamination caveat, freshness caveat, CLI-artifact-not-MCP) stated in the lede, not buried. Scope every claim to "Claude Code headless + <pinned model> on these repos."

---

## Self-Review (completed by author)

- **Spec coverage:** auto-inject (§3 → Phase 0); 3-arm wrong-repo placebo (§4 → Tasks 1.5, 2.3); USD endpoint + cache classes (§6 → Tasks 1.3, 1.4); collider-safe joint estimand + AFT/competing-risks + gatekeeping (§8 → Phase 3); real-PR tasks + blind authoring + funnel (§5 → 2.2); contamination stratum (§5 → 2.1, 3.2); flake control + blinded gate (§7 → 1.6, 2.4); pilot-gated spend on Fly (§9 → Phases 2, 4); pre-registration + reproducibility package (§13 → 3.1, 5.3); residual-risk disclosure (§12 → 5.4). No uncovered spec section.
- **Placeholders:** Phase 0 and the pure-logic harness tasks contain complete code; Phases 2/4/5 are operational runbooks by nature (no fabricated code-TDD), and the integration tasks (1.6–1.8) and analysis (3.2) are flagged to be bite-sized just before execution per the vibe-drift convention.
- **Type consistency:** `PerTurnUsage`/`Rates`/`Arm`/`RunResult` defined in Task 1.2 are used unchanged in 1.3/1.4/1.5/1.7; CLI `injectContext` field name matches across types.ts, index.ts, scan.ts, and the wiring test.
