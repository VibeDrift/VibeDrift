/**
 * Matrix analyzer — reads one or more drift-delta report JSONs and reports each
 * condition's delta with a 95% confidence interval, so we can state whether
 * VibeDrift's effect is statistically distinguishable from zero (not just a
 * point estimate). Writes a consolidated eval/reports/MATRIX-<stamp>.md.
 *
 *   tsx eval/analyze.ts eval/reports/A.json eval/reports/B.json ...
 *   npm run eval:analyze -- eval/reports/*.json
 *
 * The unit of observation is the TASK (n = number of tasks per condition) — see
 * eval/stats.ts for why trials are not treated as independent observations.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { meanCI95 } from "./stats.js";
import type { EvalReport } from "./types.js";

const REPORTS = fileURLToPath(new URL("./reports", import.meta.url));

interface ConditionRow {
  label: string;
  taskFile: string;
  sampleCap: number;
  nTasks: number;
  trials: number;
  controlMean: number;
  treatmentMean: number;
  delta: number;
  ciLo: number;
  ciHi: number;
  withinSd: number;
  verdict: string;
}

function verdictFor(lo: number, hi: number, n: number): string {
  if (n < 2) return "insufficient n";
  if (lo > 0) return "✓ significant — reduces drift";
  if (hi < 0) return "✗ significant — increases drift";
  return "~ not significant (CI spans 0)";
}

function analyzeOne(r: EvalReport): ConditionRow {
  const deltas = r.tasks.map((t) => t.delta);
  const ci = meanCI95(deltas);
  // Typical within-arm trial noise (averaged across tasks, both arms).
  const sds = r.tasks.flatMap((t) => [t.control.stdevDrift, t.treatment.stdevDrift]);
  const withinSd = sds.length ? sds.reduce((a, b) => a + b, 0) / sds.length : 0;
  return {
    label: r.label ?? "(unlabeled)",
    taskFile: r.taskFile ?? "?",
    sampleCap: r.sampleCap ?? -1,
    nTasks: r.tasks.length,
    trials: r.trials,
    controlMean: r.meanDriftControl,
    treatmentMean: r.meanDriftTreatment,
    delta: ci.mean,
    ciLo: ci.lo,
    ciHi: ci.hi,
    withinSd,
    verdict: verdictFor(ci.lo, ci.hi, ci.n),
  };
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function renderMarkdown(rows: ConditionRow[], model: string, scoring: string): string {
  const head = [
    `# Drift-delta matrix — hardened`,
    ``,
    `- **model:** ${model} · **scoring:** ${scoring}`,
    `- **unit of observation:** task (n = tasks per condition); 95% CI is a Student-t interval over per-task deltas.`,
    `- **delta > 0** ⇒ agent+VibeDrift introduced *less* drift. **Significant** when the 95% CI excludes 0.`,
    ``,
    `| condition | tasks | cap | trials | control | treatment | delta | 95% CI | within-arm sd | verdict |`,
    `|---|---:|---:|---:|---:|---:|---:|---|---:|---|`,
    ...rows.map(
      (r) =>
        `| ${r.label} | ${r.nTasks} | ${r.sampleCap} | ${r.trials} | ${fmt(r.controlMean)} | ${fmt(r.treatmentMean)} | ${fmt(r.delta)} | [${fmt(r.ciLo)}, ${fmt(r.ciHi)}] | ${fmt(r.withinSd)} | ${r.verdict} |`,
    ),
    ``,
    `## How to read this`,
    ``,
    `Each row is one experimental cell. \`cap\` is how many real repo files the`,
    `agent saw as raw context (0 = none; the only signal is VibeDrift's distilled`,
    `guidance). The headline is the **95% CI**: if its lower bound is above 0, the`,
    `drift reduction is statistically reliable for that condition, not noise.`,
  ];
  return head.join("\n");
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error("usage: tsx eval/analyze.ts <report.json> [report.json ...]");
    process.exit(1);
  }
  const reports: EvalReport[] = [];
  for (const p of paths) {
    reports.push(JSON.parse(await readFile(p, "utf8")) as EvalReport);
  }
  const rows = reports.map(analyzeOne);
  const model = reports[0]?.model ?? "?";
  const scoring = reports[0]?.scoringVersion ?? "?";

  // Console table.
  console.log(`\n=== DRIFT-DELTA MATRIX (${model}, scoring ${scoring}) ===\n`);
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(26)} delta ${fmt(r.delta).padStart(6)}  ` +
        `95% CI [${fmt(r.ciLo)}, ${fmt(r.ciHi)}]  (n=${r.nTasks}×${r.trials})  ${r.verdict}`,
    );
  }

  const md = renderMarkdown(rows, model, scoring);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(REPORTS, { recursive: true });
  const out = join(REPORTS, `MATRIX-${stamp}.md`);
  await writeFile(out, md, "utf8");
  console.log(`\nwrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
