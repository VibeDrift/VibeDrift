/**
 * Precision/recall/F1 calibration over a SYNTHETIC labeled corpus.
 *
 * For each drift type we inject a known mutation into a uniform baseline, derive
 * the ground-truth labels by diffing (the files whose content changed ARE the
 * injected drift), scan, and classify each detector's findings against the
 * labels. The clean baseline contributes the false-positive floor.
 *
 * Unlike run.ts (which only checks the score drops monotonically — a test any
 * threshold passes), this measures whether detectors are actually ACCURATE.
 *
 * Run: `npm run calibrate`. Writes a JSON baseline to test/calibration/reports/.
 */
import { mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { buildAnalysisContext } from "../../src/core/discovery.js";
import { parseFiles } from "../../src/utils/ast.js";
import { createAnalyzerRegistry } from "../../src/analyzers/index.js";
import { runDriftDetection } from "../../src/drift/index.js";
import type { Finding } from "../../src/core/types.js";
import { generateBaseline, type BaselineFile } from "./baseline.js";
import { INJECTORS } from "./injectors.js";
import { classify, findingCategory, type CategoryMetrics, type DriftLabel, type ScoredFinding } from "./metrics.js";

// Each injector's expected detector category (what a correct detector emits).
// security_floor -> "security-floor": the floor rules (private-key, aws-key,
// go-tls-skip-verify, ...) are emitted under analyzerId "security-floor"
// (src/analyzers/security.ts), tagged ["security", ...] rather than
// ["drift", ...], so `findingCategory` (metrics.ts) falls through to the
// analyzerId itself rather than a driftCategory tag. Verified empirically
// against a scored injected corpus before wiring this in — see task-7-report.md.
const INJECTOR_CATEGORY: Record<string, string> = {
  naming: "naming_conventions",
  architectural: "architectural_consistency",
  error_handling: "architectural_consistency",
  security: "security_posture",
  security_floor: "security-floor",
};
const INJECT_RATE = 0.34; // ~2 of 6 eligible files — a clear minority = unambiguous drift

// Absolute-floor calibration gate (Phase 2 acceptance criterion): the
// high-precision security-floor rules (private-key, aws-key,
// go-tls-skip-verify, ...) must hold precision >= 0.95 on the clean-baseline
// + injected corpus, or the run fails. Do not lower this to make a run pass —
// a drop below 0.95 means the floor rules are false-firing on clean code and
// that is a real bug to fix, not a threshold to soften.
const FLOOR_CATEGORY = INJECTOR_CATEGORY.security_floor;
const FLOOR_PRECISION_GATE = 0.95;

async function writeFixture(root: string, files: BaselineFile[]): Promise<void> {
  await rm(root, { recursive: true, force: true });
  for (const f of files) {
    const full = join(root, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content);
  }
}

async function scan(root: string): Promise<Finding[]> {
  const { ctx } = await buildAnalysisContext(root);
  await parseFiles(ctx.files);
  const findings: Finding[] = [];
  for (const a of createAnalyzerRegistry()) findings.push(...(await a.analyze(ctx)));
  findings.push(...runDriftDetection(ctx).findings);
  return findings;
}

function scored(findings: Finding[]): ScoredFinding[] {
  return findings.map((f) => ({
    category: findingCategory(f),
    files: [...new Set(f.locations.map((l) => l.file).filter((x): x is string => !!x))],
  }));
}

function diffLabels(baseline: BaselineFile[], injected: BaselineFile[], category: string): DriftLabel[] {
  const base = new Map(baseline.map((f) => [f.path, f.content]));
  return injected.filter((f) => base.get(f.path) !== f.content).map((f) => ({ category, file: f.path }));
}

interface Agg { tp: number; fp: number; fn: number; }

function mergeInto(agg: Map<string, Agg>, metrics: CategoryMetrics[]): void {
  for (const m of metrics) {
    const a = agg.get(m.category) ?? { tp: 0, fp: 0, fn: 0 };
    a.tp += m.tp; a.fp += m.fp; a.fn += m.fn;
    agg.set(m.category, a);
  }
}

function finalize(agg: Map<string, Agg>) {
  const rows = [];
  for (const [category, a] of [...agg.entries()].sort()) {
    const precision = a.tp + a.fp === 0 ? null : a.tp / (a.tp + a.fp);
    const recall = a.tp + a.fn === 0 ? null : a.tp / (a.tp + a.fn);
    const f1 = precision == null || recall == null || precision + recall === 0 ? (precision === 0 || recall === 0 ? 0 : null) : (2 * precision * recall) / (precision + recall);
    rows.push({ category, ...a, precision, recall, f1 });
  }
  return rows;
}

const fmt = (x: number | null) => (x == null ? "  n/a" : x.toFixed(2).padStart(5));

async function main(): Promise<void> {
  const baseline = generateBaseline();
  const root = join(tmpdir(), `vibedrift-pr-${Date.now()}`);
  const agg = new Map<string, Agg>();

  console.log("\n\x1b[1mVibeDrift calibration — precision / recall / F1 (synthetic labeled corpus)\x1b[0m");
  console.log(`  Baseline: ${baseline.length} files · injectors: ${Object.keys(INJECTOR_CATEGORY).join(", ")}\n`);

  // 1. Clean baseline → every finding is a false positive (the FP floor).
  await writeFixture(join(root, "clean"), baseline);
  mergeInto(agg, classify(scored(await scan(join(root, "clean"))), []));

  // 2. Each injector → TP/FN for its category, FP for spurious fires.
  for (const [key, category] of Object.entries(INJECTOR_CATEGORY)) {
    const variant = INJECTORS[key](baseline, INJECT_RATE);
    const labels = diffLabels(baseline, variant, category);
    if (labels.length === 0) { console.log(`  ⚠ injector '${key}' mutated 0 files — skipped`); continue; }
    const dir = join(root, key);
    await writeFixture(dir, variant);
    mergeInto(agg, classify(scored(await scan(dir)), labels));
  }

  const allRows = finalize(agg);
  // Only the INJECTED categories have synthetic ground truth — those are the
  // ones we can fairly score. Other categories that fire on the templated
  // baseline (semantic_duplication, dead-code, phantom_scaffolding — the 6
  // near-identical, consumer-less handlers legitimately trip them) have no
  // ground truth here and are reported separately as un-measured.
  const injectedCats = new Set(Object.values(INJECTOR_CATEGORY));
  const rows = allRows.filter((r) => injectedCats.has(r.category));
  const unmeasured = allRows.filter((r) => !injectedCats.has(r.category) && (r.fp ?? 0) > 0);

  console.log("  MEASURED (injected drift — synthetic ground truth)");
  console.log("  category                       TP  FP  FN   prec  recall    F1");
  console.log("  ----------------------------------------------------------------");
  for (const r of rows) {
    console.log(`  ${r.category.padEnd(28)} ${String(r.tp).padStart(3)} ${String(r.fp).padStart(3)} ${String(r.fn).padStart(3)}   ${fmt(r.precision)}  ${fmt(r.recall)}  ${fmt(r.f1)}`);
  }
  if (unmeasured.length) {
    console.log("\n  UN-MEASURED (fire on the templated baseline; no ground truth — not scored)");
    console.log(`    ${unmeasured.map((r) => `${r.category}(${r.fp})`).join(", ")}`);
  }

  // Gate: the floor rules must hold >= FLOOR_PRECISION_GATE precision on the
  // clean baseline (step 1 above, already merged into `agg`) + the injected
  // corpus. This is the one row in `rows` this script actually enforces —
  // everything else here is report-only. A drop below the gate means the
  // floor rules are false-firing on clean code; fix the rule, do not lower
  // the gate.
  const floorRow = rows.find((r) => r.category === FLOOR_CATEGORY);

  const report = { generatedAt: new Date().toISOString(), injectRate: INJECT_RATE, measured: rows, unmeasured };
  const reportDir = join(process.cwd(), "test/calibration/reports");
  await mkdir(reportDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  await writeFile(join(reportDir, `pr-${stamp}.json`), JSON.stringify(report, null, 2));
  await writeFile(join(reportDir, "latest.json"), JSON.stringify(report, null, 2));
  console.log(`\n  Baseline written to test/calibration/reports/latest.json`);
  await rm(root, { recursive: true, force: true });

  if (!floorRow || floorRow.precision == null) {
    throw new Error(
      `security floor calibration gate: no measurable '${FLOOR_CATEGORY}' findings. The injector produced no signal to score.`,
    );
  }
  if (floorRow.precision < FLOOR_PRECISION_GATE) {
    throw new Error(
      `security floor calibration gate FAILED: precision ${floorRow.precision.toFixed(3)} < ${FLOOR_PRECISION_GATE} ` +
        `(tp=${floorRow.tp} fp=${floorRow.fp} fn=${floorRow.fn}). The security-floor rules are false-firing on the clean corpus; ` +
        `investigate the rule, do not lower this gate.`,
    );
  }
  console.log(`  \x1b[32m✓\x1b[0m security floor precision gate: ${floorRow.precision.toFixed(3)} >= ${FLOOR_PRECISION_GATE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
