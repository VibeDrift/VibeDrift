/**
 * Terminal output renderer for VibeDrift scan reports.
 *
 * Formats the full scan result (findings, category scores, deep insights)
 * as a colorized, human-readable terminal report using chalk. Also provides
 * a structured JSON renderer for piping to files or CI systems.
 */

import chalk from "chalk";
import type { ScanResult, Finding } from "../core/types.js";
import { CATEGORY_CONFIG, ALL_CATEGORIES, getAnalyzerKind } from "../scoring/categories.js";
import { scoreBar, padRight, formatCount } from "./format.js";
import { scorePercentiles } from "../scoring/engine.js";
import { isPeerGroundedEntitled, type Plan } from "../auth/plan.js";

/**
 * Public GitHub repo for the post-scan "star us" CTA. Empty string keeps the
 * CTA hidden — decided (with Sami) to gate the star line until the
 * open-source CLI repo is public, so we never ship a link to a missing repo.
 * To switch it on: set this to "https://github.com/<org>/<repo>".
 */
export const GITHUB_REPO_URL = "";

/**
 * Post-scan "star us" line. Returns an empty array (renders nothing) when no
 * public repo is configured, so the CTA stays off until GITHUB_REPO_URL is
 * set. One dim, post-value line when enabled.
 */
export function renderStarCta(repoUrl: string = GITHUB_REPO_URL): string[] {
  if (!repoUrl) return [];
  return [
    chalk.dim(`  ★ Find VibeDrift useful? Star us: ${chalk.underline.cyan(repoUrl)}`),
  ];
}
import { getLanguageDisplayName } from "../core/language.js";
import type { SupportedLanguage } from "../core/types.js";
import { getVersion } from "../core/version.js";
import { estimateScoreAfterFixes } from "../scoring/engine.js";
import { hasMeaningfulImpact } from "./fix-plan-select.js";
import { relativeTime } from "./history-diff.js";

function severityIcon(severity: Finding["severity"]): string {
  switch (severity) {
    case "error": return chalk.red("\u2718");
    case "warning": return chalk.yellow("\u26A0");
    case "info": return chalk.blue("\u2139");
  }
}

function scoreColorFn(score: number, max: number): typeof chalk {
  const ratio = score / max;
  if (ratio >= 0.8) return chalk.green;
  if (ratio >= 0.5) return chalk.yellow;
  return chalk.red;
}

/**
 * One-line "why this matters" for each finding category. Turns
 * abstract consistency points into a concrete consequence the user
 * can feel — the shift from "interesting" to "I should fix this."
 */
function findingConsequence(f: Finding): string | null {
  const id = f.analyzerId;
  const tags = f.tags ?? [];

  // Intent divergence overrides category-level consequence
  if (f.metadata?.intentDivergence) {
    return "The code contradicts the team's own declared convention";
  }

  // Drift detectors — match by tag or analyzerId prefix
  if (tags.includes("architectural_consistency") || id.startsWith("drift-architectural")) {
    return "New code in this directory will copy the wrong pattern";
  }
  if (tags.includes("security_posture") || id.startsWith("drift-security")) {
    return "Unprotected routes may be exposed in production";
  }
  if (tags.includes("semantic_duplication") || id.startsWith("drift-semantic")) {
    return "When one copy changes, the others silently diverge";
  }
  if (tags.includes("naming_conventions") || id.startsWith("drift-naming") || id.startsWith("drift-convention")) {
    return "Inconsistent naming makes grep and refactoring unreliable";
  }
  if (tags.includes("phantom_scaffolding") || id.startsWith("drift-phantom")) {
    return "Dead code inflates the project and misleads AI agents";
  }
  if (id.startsWith("drift-import") || id.startsWith("drift-export")) {
    return "Refactors that touch one import style will miss the other";
  }
  if (id.startsWith("drift-async")) {
    return "Mixed async patterns make error handling unpredictable";
  }
  if (id.startsWith("drift-return")) {
    return "Callers can't trust a consistent return shape across handlers";
  }
  if (id.startsWith("drift-logging")) {
    return "Inconsistent logging makes debugging harder in production";
  }
  if (id.startsWith("drift-comment")) {
    return "Mixed doc styles confuse tooling and new contributors";
  }
  if (id.startsWith("drift-state")) {
    return "Competing state strategies cause subtle UI bugs";
  }
  if (id.startsWith("drift-test")) {
    return "Inconsistent test structure makes coverage gaps harder to spot";
  }

  // Static analyzers
  if (id === "security") {
    return "Hardcoded secrets or injection risks may be in production";
  }
  if (id === "dead-code") {
    return "Unused exports bloat the bundle and mislead AI agents";
  }
  if (id === "duplicates" || id === "codedna-fingerprint" || id === "codedna-opseq") {
    return "Duplicate logic will diverge silently over time";
  }
  if (id === "codedna-pattern" || id === "codedna-deviation") {
    return "New code in this directory will copy the wrong pattern";
  }
  if (id === "complexity" || id === "intent-clarity") {
    return "Complex or unclear functions are the first to break during refactors";
  }
  if (id === "dependencies") {
    return "Missing or phantom deps will break the build for other developers";
  }
  if (id === "todo-density") {
    return "TODO clusters signal unfinished work that may ship to production";
  }
  if (id === "error-handling") {
    return "Empty catches silently swallow errors — bugs manifest far from the cause";
  }
  if (id === "language-specific") {
    return "Language idiom violations cause subtle runtime issues";
  }

  return null;
}

function isDriftFinding(f: Finding): boolean {
  return f.analyzerId.startsWith("drift-") ||
    f.analyzerId.startsWith("codedna-") ||
    (f.tags ?? []).includes("drift");
}

/**
 * Priority multiplier for Fix Plan sorting. High-stakes categories
 * (security, architectural drift) bubble to the top even if their raw
 * consistency impact is lower than a naming or complexity finding.
 */
function findingPriority(f: Finding): number {
  const id = f.analyzerId;
  const tags = f.tags ?? [];
  const sev = f.severity === "error" ? 3 : f.severity === "warning" ? 2 : 1;

  // Security — always top priority
  if (id === "security" || tags.includes("security_posture") || id.startsWith("drift-security")) return 10 * sev;
  // Architectural drift — competing patterns are the core VibeDrift signal
  if (tags.includes("architectural_consistency") || id.startsWith("drift-architectural") || id === "codedna-pattern" || id === "codedna-deviation") return 8 * sev;
  // Intent divergence — team said one thing, code does another
  if (f.metadata?.intentDivergence) return 8 * sev;
  // Semantic duplication — silent divergence risk
  if (id === "codedna-fingerprint" || id === "codedna-opseq" || id === "duplicates" || tags.includes("semantic_duplication")) return 6 * sev;
  // Dependencies — build-breaking
  if (id === "dependencies") return 5 * sev;
  // Error handling — production risk
  if (id === "error-handling") return 5 * sev;
  // Everything else (naming, complexity, todos, imports, etc.)
  return 2 * sev;
}

function renderFixPlan(result: ScanResult, driftFirst = false, maxItems = 5): string[] {
  const lines: string[] = [];
  const allSorted = [...result.findings]
    .filter(hasMeaningfulImpact)
    .sort((a, b) => (b.consistencyImpact ?? 0) - (a.consistencyImpact ?? 0));

  let top: Finding[];
  if (driftFirst) {
    // Sort by priority (security > arch drift > duplication > deps > rest)
    // then by consistency impact within each tier. Ensures the non-logged-
    // in user sees the highest-stakes findings first — security flaws,
    // architectural contradictions, behavioral anomalies — not just
    // whatever has the most consistency points.
    const prioritySorted = [...allSorted].sort((a, b) => {
      const pDiff = findingPriority(b) - findingPriority(a);
      if (pDiff !== 0) return pDiff;
      return (b.consistencyImpact ?? 0) - (a.consistencyImpact ?? 0);
    });
    // Deduplicate by analyzer — show at most 1 finding per analyzer type
    // to maximize variety in the preview.
    const seen = new Set<string>();
    const diverse: Finding[] = [];
    for (const f of prioritySorted) {
      const key = f.analyzerId;
      if (seen.has(key) && diverse.length < maxItems) {
        // Allow a second from the same analyzer only if we're short of the cap
        if (diverse.length >= 3) continue;
      }
      seen.add(key);
      diverse.push(f);
      if (diverse.length >= maxItems) break;
    }
    top = diverse;
  } else {
    top = allSorted.slice(0, maxItems);
  }

  if (top.length === 0) return lines;

  lines.push(chalk.bold("\u2500\u2500 Fix Plan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"));
  lines.push(chalk.dim("  Highest-impact drifts to re-align first."));
  lines.push("");

  let sumImpact = 0;
  top.forEach((f, idx) => {
    const impact = f.consistencyImpact ?? 0;
    sumImpact += impact;
    const loc = f.locations[0];
    const where = loc ? `${loc.file}${loc.line ? ":" + loc.line : ""}` : "(project-wide)";
    const msg = f.message.replace(/^DRIFT:\s*/, "").slice(0, 90);
    const impactStr = chalk.green(`+${impact.toFixed(1)}pts`);
    const div = f.metadata?.intentDivergence;
    const divergenceTag = div ? chalk.yellow(" [declared divergence]") : "";
    lines.push(`  ${chalk.bold(`${idx + 1}.`)} ${msg}${divergenceTag}`);
    lines.push(`     ${chalk.dim(where)}  ${impactStr}${chalk.dim(" consistency")}`);
    const consequence = findingConsequence(f);
    if (consequence) {
      lines.push(chalk.yellow(`     → ${consequence}`));
    }
    if (div) {
      lines.push(chalk.dim(`     Declared in ${div.source}:${div.line} — code disagrees with the team's stated convention.`));
    }
  });

  // Projected score if top drifts are fixed
  const after = estimateScoreAfterFixes(result.findings, top, result.context.totalLines, result.context);
  const gain = after.compositeScore - result.compositeScore;
  const currentPct = result.maxCompositeScore > 0 ? (result.compositeScore / result.maxCompositeScore) * 100 : 0;
  const afterPct = after.maxCompositeScore > 0 ? (after.compositeScore / after.maxCompositeScore) * 100 : 0;
  const currentGrade = currentPct >= 90 ? "A" : currentPct >= 75 ? "B" : currentPct >= 50 ? "C" : currentPct >= 25 ? "D" : "F";
  const afterGrade = afterPct >= 90 ? "A" : afterPct >= 75 ? "B" : afterPct >= 50 ? "C" : afterPct >= 25 ? "D" : "F";

  lines.push("");
  if (gain > 0.5) {
    const approx = Math.round(after.compositeScore / 5) * 5;
    lines.push(`  Fix these ${top.length} → projected ~${chalk.green(approx + "/" + after.maxCompositeScore)} ${currentGrade !== afterGrade ? chalk.green(`(${currentGrade} → ${afterGrade})`) : `(${currentGrade})`}`);
  }
  lines.push("");

  // Legacy migration summary — soft, informational. Shows up only when
  // pivot detection identified files on an older dominant pattern.
  const pivotFindings = result.findings.filter((f) => f.metadata?.pivot);
  if (pivotFindings.length > 0) {
    const totalLegacy = pivotFindings.reduce((n, f) => n + (f.metadata?.legacyFiles?.length ?? 0), 0);
    if (totalLegacy > 0) {
      lines.push(chalk.bold("\u2500\u2500 Legacy \u2500 migrate when convenient \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"));
      for (const f of pivotFindings) {
        const pivot = f.metadata!.pivot!;
        const legacyFiles = f.metadata?.legacyFiles ?? [];
        if (legacyFiles.length === 0) continue;
        lines.push(`  ${chalk.yellow(pivot.fromPattern)} ${chalk.dim("→")} ${chalk.green(pivot.toPattern)}  ${chalk.dim(`(${legacyFiles.length} file${legacyFiles.length === 1 ? "" : "s"})`)}`);
        for (const path of legacyFiles.slice(0, 3)) {
          lines.push(`     ${chalk.dim(path)}`);
        }
        if (legacyFiles.length > 3) {
          lines.push(chalk.dim(`     …and ${legacyFiles.length - 3} more`));
        }
      }
      lines.push(chalk.dim("  These aren't drift — they're on the pre-pivot pattern. Migrate as part of the next refactor."));
      lines.push("");
    }
  }

  return lines;
}

function renderFindingsForCategory(
  catName: string,
  catApplicable: boolean,
  catFindings: Finding[],
  emptyLabel: string,
): string[] {
  const lines: string[] = [];

  if (!catApplicable) {
    lines.push(chalk.dim(`\u2500\u2500 ${catName} (N/A) \u2500\u2500\u2500`));
    lines.push(chalk.dim("  Not applicable for this project's languages"));
    lines.push("");
    return lines;
  }

  lines.push(chalk.bold(`\u2500\u2500 ${catName} ${"─".repeat(Math.max(0, 48 - catName.length))}`));

  if (catFindings.length === 0) {
    lines.push(chalk.green(`  \u2713 ${emptyLabel}`));
  } else {
    for (const finding of catFindings) {
      lines.push(`  ${severityIcon(finding.severity)} ${finding.message}`);
      if (finding.locations.length > 0 && finding.locations.length <= 5) {
        for (const loc of finding.locations) {
          const lineStr = loc.line ? `:${loc.line}` : "";
          lines.push(chalk.dim(`    ${loc.file}${lineStr}`));
        }
      } else if (finding.locations.length > 5) {
        for (const loc of finding.locations.slice(0, 3)) {
          const lineStr = loc.line ? `:${loc.line}` : "";
          lines.push(chalk.dim(`    ${loc.file}${lineStr}`));
        }
        lines.push(chalk.dim(`    ... and ${finding.locations.length - 3} more`));
      }
    }
  }
  lines.push("");
  return lines;
}

function renderFindingsList(result: ScanResult): string[] {
  const lines: string[] = [];
  // Drift findings only — hygiene findings render separately in their own
  // pane below so they don't contaminate the Vibe Drift Score narrative.
  const driftFindings = result.findings.filter((f) => getAnalyzerKind(f.analyzerId) === "drift");
  for (const cat of ALL_CATEGORIES) {
    const config = CATEGORY_CONFIG[cat];
    const s = result.scores[cat];

    const driftIds = config.analyzers.filter((a) => a.kind === "drift").map((a) => a.id);
    const catFindings = driftFindings.filter((f) => driftIds.includes(f.analyzerId));

    lines.push(...renderFindingsForCategory(
      config.name,
      s.applicable,
      catFindings,
      "No drift detected",
    ));
  }
  return lines;
}

/**
 * Scan-over-scan diff banner.
 *
 * Rendered right under the header when a prior scan exists for this
 * project. Shows:
 *   - How long ago the previous scan ran.
 *   - Number of drift findings resolved and newly introduced.
 *   - Composite score delta (green up-arrow / red down-arrow).
 *
 * Silent when there's no prior scan or when --no-compare was passed.
 * Renders a "comparison unavailable" line when the prior scan predates
 * the digest schema — gives the user enough context that the missing
 * diff isn't interpreted as "nothing changed."
 *
 * Also silently suppresses itself when the previous scan used a different
 * scoring methodology (see the version-mismatch guard below).
 */
function renderDiffBanner(result: ScanResult): string[] {
  // When the previous scan was computed under a different SCORING_VERSION,
  // the methodology differs (e.g. different scale, or different detectors
  // counted), so BOTH the score delta AND the resolved/new finding counts
  // would be artifacts of OUR change, not the user's code. Suppress the whole
  // diff banner SILENTLY — no banner, no "version" jargon. The one-time
  // scoring-refined notice (src/core/scoring-notice.ts) explains the shift.
  if (result.previousScoresMismatch === "scoring-version-mismatch") return [];
  const diff = result.diff;
  if (!diff) return [];

  const lines: string[] = [];
  const when = relativeTime(diff.fromTimestamp);

  if (diff.incomparable) {
    lines.push(chalk.dim(`  ℹ Previous scan (${when}) predates the diff schema — fresh baseline.`));
    lines.push("");
    return lines;
  }

  const resolved = diff.driftFindingsDiff.resolved.length + diff.findingsDiff.resolved.length;
  const added = diff.driftFindingsDiff.new.length + diff.findingsDiff.new.length;
  if (resolved === 0 && added === 0 && diff.scoreDelta === 0) {
    // Nothing changed — a one-liner is plenty.
    lines.push(chalk.dim(`  📈 Since last scan (${when}): no changes`));
    lines.push("");
    return lines;
  }

  lines.push(chalk.bold(`  📈 Since last scan (${when})`));
  if (resolved > 0) {
    const driftResolved = diff.driftFindingsDiff.resolved.length;
    const hygieneResolved = diff.findingsDiff.resolved.length;
    lines.push(
      chalk.green(`     ✓ Resolved: ${resolved} finding${resolved === 1 ? "" : "s"}`) +
        chalk.dim(` (${driftResolved} drift, ${hygieneResolved} hygiene)`),
    );
  }
  if (added > 0) {
    const driftAdded = diff.driftFindingsDiff.new.length;
    const hygieneAdded = diff.findingsDiff.new.length;
    lines.push(
      chalk.red(`     ✗ New: ${added} finding${added === 1 ? "" : "s"}`) +
        chalk.dim(` (${driftAdded} drift, ${hygieneAdded} hygiene)`),
    );
    // Surface the top 3 new drift findings — these are the ones the user
    // most likely just introduced and should triage first.
    const topNewDrift = diff.driftFindingsDiff.new.slice(0, 3);
    for (const d of topNewDrift) {
      lines.push(chalk.dim(`        • ${d.message.slice(0, 90)}`));
    }
  }
  if (diff.scoreDelta !== 0) {
    const arrow = diff.scoreDelta > 0 ? "▲" : "▼";
    const color = diff.scoreDelta > 0 ? chalk.green : chalk.red;
    lines.push(color(`     ${arrow} Vibe Drift Score: ${diff.scoreDelta > 0 ? "+" : ""}${diff.scoreDelta.toFixed(1)}`));
  }
  lines.push("");
  return lines;
}

/**
 * Hygiene pane — generic non-drift findings (complexity, dead-code, TODOs,
 * generic security regex, outdated deps, empty catches, etc.). Rendered
 * below the drift findings with an explicit label that these do NOT
 * affect the Vibe Drift Score. Users still want to see them; we just
 * don't let them dilute the identity.
 *
 * Returns [] when there are zero hygiene findings — no need to render an
 * empty pane that looks like a bug.
 */
function renderHygienePane(result: ScanResult): string[] {
  const hygieneFindings = result.findings.filter(
    (f) => getAnalyzerKind(f.analyzerId) === "hygiene",
  );
  if (hygieneFindings.length === 0) return [];

  const lines: string[] = [];
  lines.push(chalk.bold.yellow("\u2500\u2500 Hygiene findings (not part of Vibe Drift Score) \u2500\u2500\u2500\u2500\u2500\u2500"));
  lines.push(chalk.dim("  Generic hygiene checks — complexity, dead code, TODOs, generic"));
  lines.push(chalk.dim("  security and dependency issues. These feed the Hygiene Score"));
  lines.push(chalk.dim(`  (${result.hygieneScore.toFixed(0)}/${result.maxHygieneScore}), not the drift composite.`));
  lines.push("");

  for (const cat of ALL_CATEGORIES) {
    const config = CATEGORY_CONFIG[cat];
    const s = result.hygieneScores[cat];
    if (!s.applicable) continue; // Skip N/A hygiene categories silently

    const hygieneIds = config.analyzers.filter((a) => a.kind === "hygiene").map((a) => a.id);
    const catFindings = hygieneFindings.filter((f) => hygieneIds.includes(f.analyzerId));
    if (catFindings.length === 0) continue; // Don't show empty hygiene categories

    lines.push(...renderFindingsForCategory(
      config.name,
      true,
      catFindings,
      "No hygiene issues",
    ));
  }
  return lines;
}

/**
 * Count the drift categories that actually scored. The composite is a
 * geometric mean over only the APPLICABLE categories (see scoring/engine.ts),
 * so this is the true denominator behind the headline "X/100" — which can be
 * fewer than the five total categories when some are N/A (not applicable for
 * the project's languages, or no drift surface was measured).
 *
 * Pure and unit-tested so the headline can never silently imply a full
 * five-category verdict when the score really spans N<5.
 */
export function applicableCategoryCount(scores: ScanResult["scores"]): number {
  let n = 0;
  for (const cat of ALL_CATEGORIES) {
    if (scores[cat]?.applicable) n++;
  }
  return n;
}

/**
 * Honest scope qualifier for the composite headline. Returns "" when the
 * score spans every category (no qualifier needed); otherwise a dim-able note
 * like "(over 3 of 5 categories)" so the reader knows the /100 is a partial
 * verdict. Does NOT fabricate scores for N/A categories — it only labels.
 */
export function compositeScopeNote(applicable: number, total: number): string {
  if (applicable >= total) return "";
  return `(over ${applicable} of ${total} categories)`;
}

function renderCategoryBars(result: ScanResult): string[] {
  const lines: string[] = [];
  lines.push(chalk.bold("\u2500\u2500 Vibe Drift Score \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"));

  for (const cat of ALL_CATEGORIES) {
    const config = CATEGORY_CONFIG[cat];
    const s = result.scores[cat];
    const label = padRight(config.name, 28);

    if (!s.applicable) {
      lines.push(chalk.dim(`  ${label}   N/A — not scored`));
    } else {
      const color = scoreColorFn(s.score, s.maxScore);
      const bar = color(scoreBar(s.score, s.maxScore));
      let deltaStr = "";
      if (s.delta !== undefined && s.delta !== 0) {
        const dColor = s.delta > 0 ? chalk.green : chalk.red;
        const arrow = s.delta > 0 ? "\u25B2" : "\u25BC";
        deltaStr = " " + dColor(`${arrow}${Math.abs(s.delta).toFixed(1)}`);
      }
      lines.push(`  ${label} ${color(`${s.score.toFixed(0).padStart(2)}/${s.maxScore}`)}  ${bar}${deltaStr}`);
    }
  }

  lines.push(`  ${"─".repeat(34)}`);
  const totalColor = scoreColorFn(result.compositeScore, result.maxCompositeScore);
  // Honest scope qualifier: the composite is a geometric mean over only the
  // applicable categories, so when some render N/A the /100 spans N<5
  // categories. Append a dim note so the headline never reads as a full
  // five-category verdict.
  const scopeNote = compositeScopeNote(
    applicableCategoryCount(result.scores),
    ALL_CATEGORIES.length,
  );
  const scopeSuffix = scopeNote ? `  ${chalk.dim(scopeNote)}` : "";
  lines.push(`  ${padRight("Vibe Drift Score:", 28)} ${totalColor(`${result.compositeScore.toFixed(0)}/${result.maxCompositeScore}`)}${scopeSuffix}`);
  // Hygiene composite — only rendered when there's a non-zero hygiene
  // surface (some hygiene category applies). Presented as a separate
  // scalar so it's clearly NOT part of the drift score.
  if (result.maxHygieneScore > 0) {
    const hygieneColor = scoreColorFn(result.hygieneScore, result.maxHygieneScore);
    lines.push(`  ${chalk.dim(padRight("Hygiene Score:", 28))} ${hygieneColor(`${result.hygieneScore.toFixed(0)}/${result.maxHygieneScore}`)}`);
  }
  // One-line gloss so a first-time reader understands what each
  // scalar represents. Dim so it's easy to skip once internalized.
  lines.push("");
  lines.push(chalk.dim("  Vibe Drift Score — how consistent your code is with its own dominant patterns."));
  if (result.maxHygieneScore > 0) {
    lines.push(chalk.dim("  Hygiene Score — generic quality checks (complexity, dead code, TODOs, …). Independent of drift."));
  }
  lines.push("");
  return lines;
}

/**
 * Peer-percentile line — places the composite against a bundled corpus of
 * real-world repos in the same language. The percentile itself is a free,
 * local computation (already on `result.percentile`); the GATE on whether to
 * surface it is the shared `isPeerGroundedEntitled` predicate, the same one the
 * MCP tools consume, so CLI and MCP can never diverge on free-vs-paid.
 *
 * Render matrix:
 *   - No corpus data for the language (percentile === null): render NOTHING for
 *     everyone — including Free. We deliberately suppress the Free teaser too,
 *     so we never advertise a capability that would currently return nothing
 *     (the placeholder-artifact case until the corpus build lands).
 *   - Pro/entitled + data present: the real percentile line.
 *   - Free + data present: a single locked teaser line.
 */
function renderPeerPercentile(result: ScanResult, plan?: Plan): string[] {
  const pct = result.percentile;
  // No corpus data for this language → suppress for everyone (no empty tease).
  if (pct == null) return [];

  if (isPeerGroundedEntitled(plan)) {
    const lang = result.peerLanguage ?? "comparable";
    const cohort = result.peerLanguage ? scorePercentiles.languages[result.peerLanguage] : undefined;
    const n = cohort?.n ?? 0;
    const pctStr = Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1);
    const vs = n > 0 ? ` (vs ${formatCount(n)} real-world repos)` : "";
    return [
      `  ${chalk.bold("Peer percentile:")} ${chalk.cyan(`lower drift than ${pctStr}% of comparable ${lang} repos`)}${chalk.dim(vs)}`,
      "",
    ];
  }

  // Free + data present → one locked teaser line.
  return [
    chalk.dim(`  🔒 Peer percentile (Pro): see how your drift compares to real-world repos — upgrade at vibedrift.ai`),
    "",
  ];
}

function renderScoreSection(result: ScanResult): string[] {
  const lines: string[] = [];

  const banner = `  VibeDrift v${getVersion()}  `;
  const border = "\u2500".repeat(banner.length);
  lines.push(chalk.cyan(`\u256D${border}\u256E`));
  lines.push(chalk.cyan(`\u2502${banner}\u2502`));
  lines.push(chalk.cyan(`\u2570${border}\u256F`));
  lines.push("");

  const langCounts = new Map<string, number>();
  for (const f of result.context.files) {
    if (f.language) {
      const label = getLanguageDisplayName(f.language as SupportedLanguage);
      langCounts.set(label, (langCounts.get(label) ?? 0) + 1);
    }
  }
  const langStr = [...langCounts.entries()].map(([l, c]) => `${l}: ${c}`).join(", ");

  lines.push(chalk.dim(`Scanning: ${result.context.rootDir}`));
  lines.push(chalk.dim(`Files: ${result.context.files.length} (${langStr}) | Lines: ${formatCount(result.context.totalLines)} | Time: ${(result.scanTimeMs / 1000).toFixed(1)}s`));
  lines.push("");

  // Declared-conventions banner. Silent when no intent hints were found
  // or when every hint is below the confidence floor. Otherwise shows
  // which patterns the user has declared (from CLAUDE.md, AGENTS.md,
  // .cursorrules, etc.) so they know VibeDrift read and weighted those
  // declarations.
  const hints = result.context.intentHints ?? [];
  const consumableHints = hints.filter((h) => h.confidence >= 0.6);
  if (consumableHints.length > 0) {
    // Deduplicate labels so `named exports` declared in two files shows
    // once. Sort alphabetically for deterministic output across re-scans.
    const labels = [...new Set(consumableHints.map((h) => h.label))].sort();
    const sources = [...new Set(consumableHints.map((h) => h.source))].sort();
    lines.push(chalk.bold.cyan(`  📘 Declared conventions (from ${sources.join(", ")})`));
    lines.push(chalk.dim(`     ${labels.join(" · ")}`));
    lines.push("");
  }

  return lines;
}

function renderCoherenceReport(result: ScanResult): string[] {
  const c = result.coherenceReport;
  if (!c) return [];

  const sevColor: Record<string, (s: string) => string> = {
    critical: chalk.red.bold,
    high: chalk.red,
    medium: chalk.yellow,
    low: chalk.dim,
  };

  const lines: string[] = [];
  lines.push(chalk.bold("── Coherence Audit (AI-Powered) ───────────────────"));
  const gradeStr = c.coherenceGrade ? `${c.coherenceGrade} (${c.coherenceScore}/100)` : `${c.coherenceScore}/100`;
  lines.push(`  ${chalk.bold("Coherence:")} ${chalk.cyan(gradeStr)} — graded against this codebase's own patterns`);
  if (c.verdict) lines.push(chalk.dim(`  ${c.verdict}`));
  lines.push("");

  if (c.rankedIssues.length > 0) {
    for (const issue of c.rankedIssues.slice(0, 6)) {
      const color = sevColor[issue.severity] ?? chalk.yellow;
      lines.push(`  ${color(`${issue.rank}. [${issue.severity.toUpperCase()}]`)} ${chalk.bold(issue.title)}`);
      if (issue.pattern) lines.push(chalk.dim(`     breaks pattern: ${issue.pattern}`));
      if (issue.locations.length > 0) lines.push(chalk.dim(`     at: ${issue.locations.slice(0, 3).join(", ")}`));
      if (issue.why) lines.push(chalk.dim(`     why: ${issue.why.slice(0, 160)}`));
      if (issue.fix) lines.push(chalk.green(`     → ${issue.fix.slice(0, 200)}`));
      lines.push("");
    }
  }

  if (c.strengths.length > 0) {
    lines.push(chalk.dim("  Already coherent:"));
    for (const s of c.strengths.slice(0, 3)) lines.push(chalk.dim(`    ✓ ${s}`));
    lines.push("");
  }

  return lines;
}

/**
 * Top-of-output update nudge. Renders a prominent banner when the registry
 * reported a strictly-newer STABLE release (`@vibedrift/cli@latest`, fetched
 * dynamically and cached 24h). Empty under `--local-only` / when telemetry is
 * off (`updateCheck` is null there), so the zero-network guarantee still holds.
 * Shown for both signed-out and signed-in scans.
 */
function renderUpdateBanner(result: ScanResult): string[] {
  if (!result.updateCheck?.outdated) return [];
  const { current, latest } = result.updateCheck;
  return [
    chalk.yellow.bold(`  ⬆  Update available: v${latest}`) +
      chalk.dim(` (latest stable) — you're on v${current}`),
    chalk.dim("     Newer releases sharpen the detectors and ship fixes. Update for better results:"),
    "       " +
      chalk.bold.cyan("npm i -g @vibedrift/cli@latest") +
      chalk.dim("   ·   or run ") +
      chalk.bold("vibedrift update"),
    "",
  ];
}

export function renderTerminalOutput(result: ScanResult, opts?: { brief?: boolean; plan?: Plan }): string {
  if (opts?.brief) {
    return renderBriefOutput(result, opts.plan);
  }

  const lines: string[] = [
    ...renderUpdateBanner(result),
    ...renderScoreSection(result),
    ...renderDiffBanner(result),
    ...renderCategoryBars(result),
    ...renderPeerPercentile(result, opts?.plan),
    ...renderFixPlan(result),
    ...renderFindingsList(result),
    ...renderHygienePane(result),
  ];

  // Coherence report \u2014 the deep-scan hero (paid). Leads the deep section.
  lines.push(...renderCoherenceReport(result));

  // Deep insights
  if (result.deepInsights.length > 0) {
    lines.push(chalk.bold("\u2500\u2500 Deep Analysis (AI-Powered) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"));
    for (const insight of result.deepInsights.slice(0, 10)) {
      const icon = severityIcon(insight.severity);
      lines.push(`  ${icon} [${insight.category}] ${insight.title}`);
      lines.push(chalk.dim(`    ${insight.description.slice(0, 120)}${insight.description.length > 120 ? "..." : ""}`));
      if (insight.recommendation) {
        lines.push(chalk.green(`    \u2192 ${insight.recommendation.slice(0, 100)}`));
      }
    }
    lines.push("");
  }

  // Tease — deep scan conversion nudge
  if (result.teaseMessages.length > 0) {
    const teaseCount = result.teaseMessages.length;
    lines.push(chalk.bold("\u2500\u2500 Deep Analysis Preview \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"));
    for (const msg of result.teaseMessages) {
      lines.push(chalk.dim(`  \u00B7 ${msg}`));
    }
    lines.push("");
    lines.push(chalk.bgYellow.black.bold(`  \uD83D\uDD0D  ${teaseCount} additional AI findings available with deep scan  `));
    lines.push(chalk.yellow(`    Run ${chalk.bold("vibedrift . --deep")} to reveal them. 1 free deep scan/month.`));
    lines.push("");
  }

  // Reimplementation teaser — count only, never unconfirmed pairs (honest upsell).
  const reimplCount = result.reimplementationCandidates ?? 0;
  if (reimplCount > 0) {
    lines.push(chalk.yellow(`  🔁  ${reimplCount} possible redundant reimplementation${reimplCount === 1 ? "" : "s"} — run a deep scan to confirm which are real`));
    lines.push("");
  }

  // The update nudge now renders as a banner at the TOP of the output
  // (renderUpdateBanner), so it's the first thing a user sees.

  // Post-scan "star us" CTA — hidden until a public repo is configured.
  lines.push(...renderStarCta());

  return lines.join("\n");
}

/**
 * Brief terminal output for unauthenticated users.
 * Shows: score, category bars, top findings — enough to prove value,
 * not enough to replace the full report.
 *
 * `concise: true` is the authenticated-summary variant: it caps the Fix Plan
 * at the top 3 items so stdout stays a tight, scannable high-level summary
 * (score, bars, hygiene, three fixes). The full detail lives in the HTML
 * report the CLI writes and serves.
 */
function renderBriefOutput(result: ScanResult, plan?: Plan, opts?: { concise?: boolean }): string {
  const maxFixes = opts?.concise ? 3 : 5;
  const lines: string[] = [
    ...renderUpdateBanner(result),
    ...renderScoreSection(result),
    ...renderCategoryBars(result),
    ...renderPeerPercentile(result, plan),
    ...renderFixPlan(result, true, maxFixes),  // drift-first mix, capped
  ];

  return lines.join("\n");
}

/**
 * Concise authenticated summary for the default (html) format. Renders the
 * update banner, scan header, Vibe Drift Score with category bars and the
 * Hygiene Score, and the top 3 fixes — a tight high-level summary, not the
 * wall-of-text full report. The complete findings list, hygiene pane, and
 * per-directory drift detail all live in the HTML report the CLI saves and
 * serves alongside this summary.
 */
export function renderConciseSummary(result: ScanResult, plan?: Plan): string {
  return renderBriefOutput(result, plan, { concise: true });
}

export function renderJsonOutput(result: ScanResult): string {
  return JSON.stringify(
    {
      version: getVersion(),
      project: result.context.rootDir,
      fileCount: result.context.files.length,
      totalLines: result.context.totalLines,
      dominantLanguage: result.context.dominantLanguage,
      scanTimeMs: result.scanTimeMs,
      scores: result.scores,
      compositeScore: result.compositeScore,
      maxCompositeScore: result.maxCompositeScore,
      // Peer percentile against the bundled corpus (null when no corpus data
      // for the language — the current placeholder case). Free/local computation.
      percentile: result.percentile ?? null,
      peerLanguage: result.peerLanguage,
      hygieneScores: result.hygieneScores,
      hygieneScore: result.hygieneScore,
      maxHygieneScore: result.maxHygieneScore,
      findings: result.findings,
      deepInsights: result.deepInsights,
      // The deep-scan coherence audit (AI-powered) — included so --json / CI /
      // analytics consumers can read the same hero report the terminal and HTML
      // render. Undefined on free or non-deep scans.
      coherenceReport: result.coherenceReport,
      perFileScores: Object.fromEntries(result.perFileScores),
    },
    null,
    2,
  );
}
