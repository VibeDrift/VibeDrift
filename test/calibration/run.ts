/**
 * Scoring calibration runner.
 *
 * Generates baseline → injects drift at increasing rates → runs the full
 * scan pipeline against each variant → measures two INDEPENDENT properties.
 *
 *   MONOTONICITY (enforced, exits 1 on violation): more injected drift must
 *   never produce a HIGHER composite. This is a correctness property. A score
 *   that rises when a problem is added contradicts the whole premise of the
 *   tool, so it blocks.
 *
 *   RESPONSIVENESS (report-only): each 25% more injected drift should drop the
 *   composite by at least REQUIRED_DROP_PER_25PCT. This is a SENSITIVITY
 *   property, not a correctness one — a score can be perfectly honest about
 *   direction and still too flat to be useful.
 *
 * They are reported separately, and only monotonicity gates, because they fail
 * for different reasons and conflating them is how this command spent months
 * red: a single exit code could not distinguish "the score lies" from "the
 * score is compressed", so neither got fixed. The threshold below was
 * calibrated against pre-v18 scoring and has not been re-derived for the
 * current formula; re-deriving it by picking whatever number makes today's
 * fixture pass would be fitting the gate to the test, so it stays report-only
 * until the scoring-algorithm work sets it deliberately.
 *
 * Intended as a pre-publish gate. Run via `npm run calibrate:monotonic`.
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
/** Report-only target; see the module header for why it does not gate. */
const REQUIRED_DROP_PER_25PCT = 3.0;

/**
 * Tolerance on the monotonicity check. NOT zero, deliberately, and the reason
 * is measured rather than assumed.
 *
 * This harness injects drift by REWRITING files, so the fixture GROWS: 369
 * total lines at 0%, 374 at 10%. A category's clean credit is evidence-weighted
 * by line count (`NO_FINDING_PRIOR + (1 - NO_FINDING_PRIOR) * evidence` in
 * scoring/engine.ts), so five extra lines lift every category's ceiling a
 * little. Instrumented at both rates on 2026-09-04:
 *
 *   0%   arch 0.825  redundancy 0.825  security N/A     -> composite 82.5
 *   10%  arch 0.830  redundancy 0.830  security 0.830   -> composite 83.0
 *
 * Both always-measured categories rose 0.005 purely from the extra lines, and
 * securityPosture entered at exactly the base mean (0.830), contributing
 * nothing — which is the surface-category clamp working as intended. So the
 * +0.5 step is the fixture getting bigger, not the score rewarding drift.
 *
 * That is why this is not the same measurement as
 * `test/unit/scoring/monotonicity.test.ts`, which holds the corpus fixed and
 * pins the real property (removing any finding never lowers the composite)
 * across 200 randomized trials. Half a point is small enough to still catch a
 * genuine inversion (the pre-v18 failure was +0.7) and large enough not to
 * fire on this fixture's own growth. If the baseline fixture changes size,
 * re-instrument before touching this number.
 */
const MONOTONIC_TOLERANCE = 0.5;

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
    if (cur.composite > prev.composite + MONOTONIC_TOLERANCE) {
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
  console.log(`monotonicity   (GATE):        ${mono.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m " + mono.violations.join("; ")}`);
  console.log(`responsiveness (report-only): ${resp.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[33m!\x1b[0m"} ${resp.note}`);

  // The narrowest margin on the monotonicity check, so a run that passes with
  // nothing to spare is visible rather than indistinguishable from a
  // comfortable pass.
  let worstRise = -Infinity;
  for (let i = 1; i < rows.length; i++) {
    worstRise = Math.max(worstRise, rows[i].composite - rows[i - 1].composite);
  }
  const margin = MONOTONIC_TOLERANCE - worstRise;
  console.log(
    `  monotonicity margin: ${margin.toFixed(1)}pt (largest rise ${worstRise.toFixed(1)}, tolerance ${MONOTONIC_TOLERANCE})`,
  );

  await rm(rootDir, { recursive: true, force: true });

  if (!mono.ok) {
    console.log(`\n\x1b[31mCalibration failed.\x1b[0m The composite rose as injected drift rose — a scoring inversion.`);
    process.exit(1);
  }
  if (!resp.ok) {
    console.log(
      `\n\x1b[33mMonotonicity gate passed; responsiveness is below target and is NOT gating.\x1b[0m`,
    );
    console.log(
      `  Tracked, not enforced: the threshold predates the current scoring formula. Do not raise or lower it to make a run pass.`,
    );
  } else {
    console.log(`\n\x1b[32mCalibration passed.\x1b[0m`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
