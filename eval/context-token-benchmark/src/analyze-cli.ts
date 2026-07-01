/**
 * analyze-cli.ts — FREE: compute and print the experiment result.
 *
 * Joins results.jsonl + judged.jsonl, runs analyzeDrift, prints a human-readable
 * report (per-arm pass rate + mean drift, MCP usage, the T-P / T-C / P-C
 * contrasts with bootstrap CIs), and writes analysis.json. No metered calls.
 *
 * Usage: node dist/analyze-cli.js [--results results.jsonl] [--judged judged.jsonl]
 *        [--out analysis.json] [--resamples 2000] [--seed drift]
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadResults } from "./store.js";
import { loadJsonl } from "./jsonl.js";
import { analyzeDrift, type Contrast, type DriftAnalysis } from "./analyze-drift.js";
import type { RunDriftScore } from "./judge.js";

interface Args {
  results: string;
  judged: string;
  out: string;
  resamples: number;
  seed: string;
}

function parseArgs(argv: string[]): Args {
  const a = argv.slice(2);
  let results = "results.jsonl";
  let judged = "judged.jsonl";
  let out = "analysis.json";
  let resamples = 2000;
  let seed = "drift";
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case "--results": results = a[++i] ?? results; break;
      case "--judged": judged = a[++i] ?? judged; break;
      case "--out": out = a[++i] ?? out; break;
      case "--resamples": resamples = parseInt(a[++i] ?? String(resamples), 10); break;
      case "--seed": seed = a[++i] ?? seed; break;
      default: console.error(`Unknown flag: ${a[i]}`); process.exit(1);
    }
  }
  return { results: resolve(results), judged: resolve(judged), out: resolve(out), resamples, seed };
}

function fmtContrast(c: Contrast): string {
  if (c.nClusters === 0) return `${c.label}: (no paired tasks)`;
  const dir = c.deltaMean < 0 ? "less drift" : c.deltaMean > 0 ? "MORE drift" : "no diff";
  return (
    `${c.label} = ${c.deltaMean.toFixed(3)} ` +
    `[95% CI ${c.ci95[0].toFixed(3)}, ${c.ci95[1].toFixed(3)}] ` +
    `over ${c.nClusters} task(s) → first arm has ${dir}`
  );
}

export function formatReport(a: DriftAnalysis): string {
  const lines: string[] = [];
  lines.push("=== MCP Drift-Quality — RESULT ===");
  lines.push("(drift score 0 = perfect convention adherence, 1 = full drift; lower is better)");
  lines.push("");
  lines.push("Per-arm:");
  for (const arm of ["C", "P", "T"] as const) {
    const s = a.perArm[arm];
    lines.push(
      `  ${arm}: runs=${s.nRuns} passed=${s.nPassed} (${(s.passRate * 100).toFixed(0)}%) ` +
        `judged=${s.nJudged} meanDrift=${s.meanDrift.toFixed(3)}`,
    );
  }
  lines.push("");
  lines.push(
    `MCP fidelity (T): used the MCP in ${(a.mcpUsageRateT * 100).toFixed(0)}% of runs, ` +
      `${a.degenerateTRuns} degenerate (zero tool calls).`,
  );
  lines.push("");
  lines.push(`Contrasts (cluster bootstrap, ${a.bootstrapResamples} resamples):`);
  lines.push(`  PRIMARY  ${fmtContrast(a.contrasts.TminusP)}`);
  lines.push(`           ${fmtContrast(a.contrasts.TminusC)}`);
  lines.push(`           ${fmtContrast(a.contrasts.PminusC)}`);
  lines.push("");
  const c = a.contrasts.TminusP;
  if (c.nClusters === 0) {
    lines.push("VERDICT: insufficient paired data for the primary T-P contrast.");
  } else {
    const sig = c.ci95[1] < 0 ? "significant" : c.ci95[0] > 0 ? "significant (WRONG direction)" : "not significant";
    lines.push(
      `VERDICT: MCP vs instruction-only drift delta = ${c.deltaMean.toFixed(3)} ` +
        `(95% CI ${c.ci95[0].toFixed(3)}..${c.ci95[1].toFixed(3)}) — ${sig}.`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const runs = await loadResults(args.results);
  const judged = await loadJsonl<RunDriftScore>(args.judged);
  if (runs.length === 0) {
    console.error(`[analyze] no runs in ${args.results}`);
    process.exit(1);
  }
  const analysis = analyzeDrift(runs, judged, { resamples: args.resamples, seed: args.seed });
  console.log(formatReport(analysis));
  await writeFile(args.out, JSON.stringify(analysis, null, 2), "utf-8");
  console.log(`\n[analyze] wrote ${args.out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("[analyze] Fatal:", err);
    process.exit(1);
  });
}
