/**
 * Scoring calibration runner.
 *
 * Generates baseline → injects drift at increasing rates → runs the full
 * scan pipeline against each variant → asserts the composite score drops
 * monotonically as drift rises. If any pair violates, exit 1.
 *
 * Intended as a pre-publish gate. Run via `npm run calibrate`.
 */

import { mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { buildAnalysisContext } from "../../src/core/discovery.js";
import { parseFiles } from "../../src/utils/ast.js";
import { createAnalyzerRegistry } from "../../src/analyzers/index.js";
import { runDriftDetection } from "../../src/drift/index.js";
import { computeScores } from "../../src/scoring/engine.js";
import { generateBaseline, type BaselineFile } from "./baseline.js";
import { injectAll, INJECTORS } from "./injectors.js";

const INJECTION_RATES = [0, 0.10, 0.25, 0.50, 0.75, 0.90];
const REQUIRED_DROP_PER_25PCT = 3.0;

interface Row {
  label: string;
  rate: number;
  composite: number;
  drift: number;
  findings: number;
}

async function writeFixture(root: string, files: BaselineFile[]): Promise<void> {
  await rm(root, { recursive: true, force: true });
  for (const f of files) {
    const full = join(root, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content);
  }
}

async function scanRepo(root: string): Promise<{ composite: number; drift: number; findings: number }> {
  const { ctx } = await buildAnalysisContext(root);
  await parseFiles(ctx.files);

  const analyzers = createAnalyzerRegistry();
  const findings = [];
  for (const a of analyzers) {
    findings.push(...(await a.analyze(ctx)));
  }
  const driftResult = runDriftDetection(ctx);
  findings.push(...driftResult.findings);

  const { compositeScore } = computeScores(findings, ctx.totalLines, ctx, undefined, { mutateImpact: false });

  return {
    // Single authoritative composite (engine). driftScores no longer carries
    // a separate composite after the Phase 0 dual-engine collapse.
    composite: compositeScore,
    drift: compositeScore,
    findings: findings.length,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function checkMonotonic(rows: Row[]): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (cur.composite > prev.composite + 0.5) {
      violations.push(`composite non-monotonic: ${prev.label} (${prev.composite.toFixed(1)}) → ${cur.label} (${cur.composite.toFixed(1)})`);
    }
  }
  return { ok: violations.length === 0, violations };
}

function checkResponsiveness(rows: Row[]): { ok: boolean; note: string } {
  const low = rows.find((r) => r.rate === 0.25);
  const mid = rows.find((r) => r.rate === 0.50);
  const high = rows.find((r) => r.rate === 0.75);
  if (!low || !mid || !high) return { ok: true, note: "skipped — missing reference rows" };

  const midDrop = low.composite - mid.composite;
  const highDrop = mid.composite - high.composite;
  if (midDrop < REQUIRED_DROP_PER_25PCT || highDrop < REQUIRED_DROP_PER_25PCT) {
    return {
      ok: false,
      note: `each 25% injection should drop score ≥${REQUIRED_DROP_PER_25PCT}pt; saw ${midDrop.toFixed(1)} (25→50) and ${highDrop.toFixed(1)} (50→75)`,
    };
  }
  return { ok: true, note: `each 25% → ≥${REQUIRED_DROP_PER_25PCT}pt drop confirmed` };
}

async function main(): Promise<void> {
  const baseline = generateBaseline();
  const rootDir = join(tmpdir(), `vibedrift-calibration-${Date.now()}`);

  console.log(`\n\x1b[1mScoring calibration harness\x1b[0m`);
  console.log(`  Baseline: ${baseline.length} files, ${Object.keys(INJECTORS).length} injector types`);
  console.log(`  Rates:    ${INJECTION_RATES.map((r) => `${Math.round(r * 100)}%`).join(", ")}`);
  console.log(`  Working:  ${rootDir}\n`);

  const rows: Row[] = [];
  for (const rate of INJECTION_RATES) {
    const variant = injectAll(baseline, rate);
    const variantDir = join(rootDir, `rate-${Math.round(rate * 100)}`);
    await writeFixture(variantDir, variant);
    const result = await scanRepo(variantDir);
    rows.push({
      label: `${Math.round(rate * 100)}%`,
      rate,
      composite: result.composite,
      drift: result.drift,
      findings: result.findings,
    });
  }

  console.log(`${pad("inject", 10)} ${pad("composite", 12)} ${pad("drift", 8)} ${pad("findings", 10)} ${"Δ comp"}`);
  console.log("─".repeat(60));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const delta = i === 0 ? "—" : (r.composite - rows[i - 1].composite).toFixed(1);
    console.log(`${pad(r.label, 10)} ${pad(r.composite.toFixed(1), 12)} ${pad(r.drift.toFixed(1), 8)} ${pad(String(r.findings), 10)} ${delta}`);
  }

  const mono = checkMonotonic(rows);
  const resp = checkResponsiveness(rows);
  console.log();
  console.log(`monotonicity:   ${mono.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m " + mono.violations.join("; ")}`);
  console.log(`responsiveness: ${resp.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${resp.note}`);

  await rm(rootDir, { recursive: true, force: true });

  if (!mono.ok || !resp.ok) {
    console.log(`\n\x1b[31mCalibration failed.\x1b[0m Scoring formula changes may have broken monotonicity or responsiveness.`);
    process.exit(1);
  }
  console.log(`\n\x1b[32mCalibration passed.\x1b[0m`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
