/**
 * Drift-delta eval — MANUAL run (metered, non-deterministic; NOT CI).
 *
 *   export ANTHROPIC_API_KEY=...        # your own Anthropic API key
 *   EVAL_TRIALS=3 npm run eval          # EVAL_MODEL=... to swap models
 *
 * Writes eval/reports/<stamp>.json + <stamp>.md (headline delta + before/after
 * diffs). A positive delta means agent+VibeDrift introduced LESS drift.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadTasks, repoDir } from "./fixtures.js";
import { runEval } from "./orchestrate.js";
import { ClaudeAgentRunner, buildGuidance, DEFAULT_EVAL_MODEL } from "./runner-claude.js";
import { buildBaseline, writeBaseline } from "../src/core/baseline.js";
import type { RepoContext, EvalReport, Treatment } from "./types.js";

const REPORTS = fileURLToPath(new URL("./reports", import.meta.url));

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. Set your Anthropic API key, e.g.:\n" +
        "  export ANTHROPIC_API_KEY=sk-ant-...\n" +
        "  npm run eval",
    );
    process.exit(1);
  }

  const trials = Number(process.env.EVAL_TRIALS ?? "3");
  const taskFile = process.env.EVAL_TASKS ?? "tasks.json";
  const sampleCap = process.env.EVAL_SAMPLE_CAP !== undefined ? Number(process.env.EVAL_SAMPLE_CAP) : undefined;
  const control = (process.env.EVAL_CONTROL ?? "none") as Treatment;
  const treatment = (process.env.EVAL_TREATMENT ?? "context") as Treatment;
  const tasks = loadTasks(taskFile);
  console.log(
    `Running ${tasks.length} tasks × ${trials} trials × {${control} vs ${treatment}} on ${DEFAULT_EVAL_MODEL} ` +
      `(tasks=${taskFile}, sampleCap=${sampleCap ?? "default(3)"})…`,
  );

  // The "tools" arm reads a baseline from disk (the real MCP tools do), so
  // pre-scan + persist each repo's baseline first — otherwise every tool call
  // returns no_baseline and the arm is inert.
  if (control === "tools" || treatment === "tools") {
    const repos = [...new Set(tasks.map((t) => t.repo))];
    for (const r of repos) {
      const dir = repoDir(r);
      await writeBaseline(await buildBaseline(dir));
      console.log(`  pre-scanned baseline for ${r}`);
    }
  }

  // buildGuidance does a full scan; memoize per repo (it's identical across a repo's tasks).
  const cache = new Map<string, Promise<RepoContext["guidance"]>>();
  const guidanceFor = (rootDir: string) => {
    if (!cache.has(rootDir)) cache.set(rootDir, buildGuidance(rootDir));
    return cache.get(rootDir)!;
  };

  const base = await runEval(tasks, new ClaudeAgentRunner({ sampleCap }), {
    trials,
    control,
    treatment,
    resolveRepoDir: repoDir,
    buildGuidance: guidanceFor,
    model: DEFAULT_EVAL_MODEL,
  });

  // Self-describe the condition so the matrix analyzer can label this cell.
  const label =
    process.env.EVAL_LABEL ??
    `${taskFile.replace(/\.json$/, "")} cap=${sampleCap ?? 3} ${treatment}`;
  const report = { ...base, sampleCap: sampleCap ?? 3, taskFile, label };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(REPORTS, { recursive: true });
  await writeFile(join(REPORTS, `${stamp}.json`), JSON.stringify(report, null, 2), "utf8");
  await writeFile(join(REPORTS, `${stamp}.md`), renderMarkdown(report), "utf8");

  console.log(`\n=== DRIFT-DELTA (${report.model}, ${report.trials} trials, scoring ${report.scoringVersion}) ===`);
  console.log(`  control (agent alone):       mean drift ${report.meanDriftControl.toFixed(2)}`);
  console.log(`  treatment (agent+VibeDrift): mean drift ${report.meanDriftTreatment.toFixed(2)}`);
  console.log(`  delta: ${report.delta.toFixed(2)}  ${report.delta > 0 ? "✓ VibeDrift reduced drift" : "✗ no improvement — investigate"}`);
  console.log(`\nwrote eval/reports/${stamp}.{json,md}`);
}

function renderMarkdown(r: EvalReport): string {
  const head = [
    `# Drift-delta eval`,
    ``,
    `- **model:** ${r.model} · **trials:** ${r.trials} · **scoring:** ${r.scoringVersion}`,
    `- **mean drift — control (agent alone):** ${r.meanDriftControl.toFixed(2)}`,
    `- **mean drift — treatment (agent+VibeDrift):** ${r.meanDriftTreatment.toFixed(2)}`,
    `- **delta:** ${r.delta.toFixed(2)} ${r.delta > 0 ? "(VibeDrift reduced drift)" : "(no improvement)"}`,
    ``,
    `| task | repo | control | treatment | delta |`,
    `|---|---|---:|---:|---:|`,
    ...r.tasks.map((t) =>
      `| ${t.taskId} | ${t.repo} | ${t.control.meanDrift.toFixed(2)} | ${t.treatment.meanDrift.toFixed(2)} | ${t.delta.toFixed(2)} |`,
    ),
    ``,
    `## Before / after (first 3 tasks)`,
  ];
  const examples = r.tasks.slice(0, 3).flatMap((t) => [
    ``,
    `### ${t.taskId}`,
    `**control (agent alone) — drift ${t.control.meanDrift.toFixed(2)}:**`,
    "```ts",
    t.example?.controlBody ?? "",
    "```",
    `**treatment (agent+VibeDrift) — drift ${t.treatment.meanDrift.toFixed(2)}:**`,
    "```ts",
    t.example?.treatmentBody ?? "",
    "```",
  ]);
  return [...head, ...examples].join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
