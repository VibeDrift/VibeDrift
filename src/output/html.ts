import type { ScanResult, Finding, DriftFindingReport } from "../core/types.js";
import { getVersion } from "../core/version.js";
import { buildFixPromptMarkdown, buildFullFixPlanMarkdown, findingKey, type FixPromptContext } from "./fix-prompt.js";
import { estimateScoreAfterFixes } from "../scoring/engine.js";
import { hasMeaningfulImpact } from "./fix-plan-select.js";
import { getAnalyzerKind, DRIFT_DISPLAY_CATEGORIES } from "../scoring/categories.js";
import { applicableCategoryCount, compositeScopeNote } from "./terminal.js";
import { formatCount } from "./format.js";
import { hasFloorTrip } from "./floor-badge.js";

const SCORING_CATEGORY_LABELS: Record<string, string> = {
  architecturalConsistency: "Architectural",
  redundancy: "Redundancy",
  dependencyHealth: "Dependencies",
  securityPosture: "Security Consistency",
  intentClarity: "Intent Clarity",
};

const SCORING_CATEGORY_ORDER = [
  "architecturalConsistency",
  "redundancy",
  "dependencyHealth",
  "securityPosture",
  "intentClarity",
] as const;

function buildFixPromptContext(result: ScanResult): FixPromptContext {
  const projectName = result.context.rootDir.split("/").pop() ?? "project";
  return {
    projectName,
    language: result.context.dominantLanguage,
    fileCount: result.context.files.length,
  };
}

/**
 * Top-N findings across all categories, ranked by consistencyImpact.
 * Ignores findings without an impact score (they didn't pass through scoring).
 */
function topImpactFindings(result: ScanResult, n = 5): Finding[] {
  return [...result.findings]
    .filter(hasMeaningfulImpact)
    .sort((a, b) => (b.consistencyImpact ?? 0) - (a.consistencyImpact ?? 0))
    .slice(0, n);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ──── Visual mapping: scores / grades / drift → status tokens ────
// The report uses a single status ramp (good → grade-b → warn → caution → bad)
// for grades and severities only. Everything else stays neutral. These helpers
// keep that mapping in one place so colour never drifts between sections.

interface GradeTokens { letter: string; color: string; tint: string; }

/** Grade + colour token + tint for a 0..max score (higher = better). */
function gradeTokens(score: number, max: number): GradeTokens {
  const pct = max > 0 ? (score / max) * 100 : 0;
  if (pct >= 90) return { letter: "A", color: "var(--good)", tint: "var(--good-tint)" };
  if (pct >= 75) return { letter: "B", color: "var(--grade-b)", tint: "var(--good-tint)" };
  if (pct >= 50) return { letter: "C", color: "var(--warn)", tint: "var(--warn-tint)" };
  if (pct >= 25) return { letter: "D", color: "var(--caution)", tint: "var(--caution-tint)" };
  return { letter: "F", color: "var(--bad)", tint: "var(--bad-tint)" };
}

/** Status colour for a percentage where higher = better (category bars). */
function pctToken(pct: number): string {
  if (pct >= 90) return "var(--good)";
  if (pct >= 75) return "var(--grade-b)";
  if (pct >= 50) return "var(--warn)";
  if (pct >= 25) return "var(--caution)";
  return "var(--bad)";
}

/** Status colour for a drift value 0..100 where higher = worse (file rows). */
function driftToken(drift: number): string {
  if (drift >= 75) return "var(--bad)";
  if (drift >= 50) return "var(--caution)";
  if (drift >= 25) return "var(--warn)";
  return "var(--good)";
}

/** Severity → badge class used in the findings library. */
function sevBadgeClass(sev: string): string {
  if (sev === "error") return "bad";
  if (sev === "warning") return "warn";
  return "caution";
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Split a path into a dimmed directory prefix + emphasised basename. */
function pathParts(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf("/");
  return i >= 0 ? { dir: p.slice(0, i + 1), base: p.slice(i + 1) } : { dir: "", base: p };
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? ".../" + parts.slice(-2).join("/") : p;
}

// ──── Extract intent patterns from drift findings ────

interface IntentPattern {
  category: string;
  label: string;
  dominantCount: number;
  totalRelevant: number;
  consistency: number;
}

function extractIntentPatterns(result: ScanResult): IntentPattern[] {
  const patterns: IntentPattern[] = [];
  const seen = new Set<string>();

  for (const d of (result.driftFindings ?? [])) {
    const key = d.driftCategory + "::" + (d.subCategory ?? "") + "::" + d.dominantPattern;
    if (seen.has(key)) continue;
    seen.add(key);

    // Use subCategory for architectural_consistency to get precise labels
    const subCatNames: Record<string, string> = {
      data_access: "Data Access",
      error_handling: "Error Handling",
      dependency_injection: "Dependency Injection",
      configuration: "Configuration",
    };

    const catNames: Record<string, string> = {
      architectural_consistency: "Architecture",
      security_posture: "Security",
      semantic_duplication: "Duplication",
      naming_conventions: "Naming",
      phantom_scaffolding: "Scaffolding",
    };

    // Prefer subCategory label for architectural findings, fallback to category
    const category = (d.driftCategory === "architectural_consistency" && d.subCategory)
      ? (subCatNames[d.subCategory] ?? catNames[d.driftCategory] ?? d.driftCategory)
      : (catNames[d.driftCategory] ?? d.driftCategory);

    // Skip "no clear dominant" cards — they add confusion, not clarity
    if (d.consistencyScore < 60) continue;

    patterns.push({
      category,
      label: d.dominantPattern,
      dominantCount: d.dominantCount,
      totalRelevant: d.totalRelevantFiles,
      consistency: d.consistencyScore,
    });
  }

  // Add Code DNA patterns
  const dna = result.codeDnaResult;
  if (dna?.patternDistributions?.length > 0) {
    const patternCounts = new Map<string, number>();
    for (const pd of dna.patternDistributions) {
      patternCounts.set(pd.dominantPattern, (patternCounts.get(pd.dominantPattern) ?? 0) + 1);
    }
    let dominant = "";
    let maxC = 0;
    for (const [p, c] of patternCounts) {
      if (c > maxC) { maxC = c; dominant = p; }
    }
    if (dominant && !seen.has("codedna::" + dominant)) {
      patterns.push({
        category: "Architecture",
        label: dominant,
        dominantCount: maxC,
        totalRelevant: dna.patternDistributions.length,
        consistency: Math.round((maxC / dna.patternDistributions.length) * 100),
      });
    }
  }

  return patterns;
}

// ──── Build coherence data per file ────

interface FileCoherence {
  path: string;
  score: number;
  alignments: { category: string; matches: boolean; actual?: string }[];
  alignmentPct: number;
  driftCount: number;
  staticCount: number;
}

function buildDriftFileMap(result: ScanResult): Map<string, { category: string; pattern: string }[]> {
  const driftFiles = new Map<string, { category: string; pattern: string }[]>();
  for (const d of (result.driftFindings ?? [])) {
    for (const df of d.deviatingFiles) {
      if (!driftFiles.has(df.path)) driftFiles.set(df.path, []);
      const catKey = (d.driftCategory === "architectural_consistency" && d.subCategory)
        ? d.driftCategory + "::" + d.subCategory
        : d.driftCategory;
      driftFiles.get(df.path)!.push({ category: catKey, pattern: df.detectedPattern });
    }
  }
  return driftFiles;
}

function buildCategorySet(result: ScanResult): Map<string, string> {
  const subCatNames: Record<string, string> = {
    data_access: "Data Access",
    error_handling: "Error Handling",
    dependency_injection: "Dep. Injection",
    configuration: "Configuration",
  };
  const baseCatNames: Record<string, string> = {
    security_posture: "Security",
    naming_conventions: "Naming",
    phantom_scaffolding: "Scaffolding",
  };

  const catSet = new Map<string, string>();
  for (const d of (result.driftFindings ?? [])) {
    if (d.driftCategory === "architectural_consistency" && d.subCategory) {
      const label = subCatNames[d.subCategory] ?? d.subCategory;
      catSet.set(d.driftCategory + "::" + d.subCategory, label);
    } else if (baseCatNames[d.driftCategory]) {
      catSet.set(d.driftCategory, baseCatNames[d.driftCategory]);
    }
  }
  return catSet;
}

function buildCodeDnaPatternData(result: ScanResult): { projectDominantPattern: string; filePatternMap: Map<string, string> } {
  const filePatternMap = new Map<string, string>();
  let projectDominantPattern = "";
  const dna = result.codeDnaResult;

  if (dna?.patternDistributions?.length > 0) {
    const patternCounts = new Map<string, number>();
    for (const pd of dna.patternDistributions) {
      if (pd.dominantPattern !== "none") {
        patternCounts.set(pd.dominantPattern, (patternCounts.get(pd.dominantPattern) ?? 0) + 1);
      }
      filePatternMap.set(pd.relativePath, pd.dominantPattern);
    }
    let maxC = 0;
    for (const [p, c] of patternCounts) {
      if (c > maxC) { maxC = c; projectDominantPattern = p; }
    }
  }
  return { projectDominantPattern, filePatternMap };
}

function buildFileCoherence(result: ScanResult): FileCoherence[] {
  const entries = [...result.perFileScores.entries()];
  const driftFiles = buildDriftFileMap(result);
  const catSet = buildCategorySet(result);

  const { projectDominantPattern, filePatternMap } = buildCodeDnaPatternData(result);
  if (projectDominantPattern) {
    catSet.set("codedna_architecture", "Architecture");
  }

  const categories = [...catSet.values()];
  const catKeys = [...catSet.keys()];

  return entries.map(([path, data]) => {
    const deviations = driftFiles.get(path) ?? [];
    const alignments = catKeys.map((key, i) => {
      if (key === "codedna_architecture") {
        // Check file's pattern against project dominant
        const filePattern = filePatternMap.get(path);
        if (!filePattern || filePattern === "none") {
          return { category: categories[i], matches: true }; // no pattern data = assume aligned
        }
        const matches = filePattern === projectDominantPattern;
        return { category: categories[i], matches, actual: matches ? undefined : filePattern };
      }
      const dev = deviations.find((d) => d.category === key);
      return { category: categories[i], matches: !dev, actual: dev?.pattern };
    });
    const matchCount = alignments.filter((a) => a.matches).length;
    const driftCount = data.findings.filter((f) => f.tags?.includes("drift") || f.tags?.includes("codedna")).length;
    const staticCount = data.findings.filter((f) => !f.tags?.includes("drift") && !f.tags?.includes("codedna")).length;

    return {
      path,
      score: data.score,
      alignments,
      alignmentPct: categories.length > 0 ? Math.round((matchCount / categories.length) * 100) : 100,
      driftCount,
      staticCount,
    };
  }).sort((a, b) => a.alignmentPct - b.alignmentPct || a.score - b.score);
}

// ════════════════════════════════════════════════════════════════════════
//  PRESENTATION
//  All sections share one token system (see STYLE) and one status ramp.
//  Dark is the default; light is first-class; print reuses the light tokens.
// ════════════════════════════════════════════════════════════════════════

function langPills(result: ScanResult): string {
  const total = result.context.files.length || 1;
  return [...result.context.languageBreakdown.entries()]
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, 3)
    .map(([l, s]) => `<span class="va-pill">${esc(cap(l))} <b>${Math.round((s.files / total) * 100)}%</b></span>`)
    .join("");
}

function buildReportHeader(result: ScanResult, mode: "summary" | "detailed", summaryUrl: string, findingCount: number): string {
  const name = result.context.rootDir.split("/").pop() ?? "project";
  const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = (result.scanTimeMs / 1000).toFixed(1);
  const back = mode === "detailed"
    ? `<a href="${esc(summaryUrl)}" class="va-back" target="_top">Back to summary</a>`
    : "";
  const tag = mode === "detailed" ? `<span class="va-tag">Detailed report</span>` : "";
  const findingsPill = mode === "detailed" && findingCount > 0
    ? `<span class="va-pill"><b class="num">${findingCount}</b> findings</span>`
    : "";

  return `${back}
  <header class="va-head" id="report-header">
    <div>
      <div class="va-brand"><span class="b"></span>VibeDrift</div>
      <div class="va-titlerow"><h1 class="va-title">${esc(name)}</h1>${tag}</div>
      <div class="va-pills">
        <span class="va-pill">${date}</span>
        <span class="va-pill"><b class="num">${result.context.files.length}</b> files</span>
        <span class="va-pill"><b class="num">${formatCount(result.context.totalLines)}</b> lines</span>
        ${findingsPill}
        ${langPills(result)}
        <span class="va-pill">scanned in <b>${time}s</b></span>
      </div>
    </div>
    <button class="theme-toggle" id="reportTheme" title="Toggle light / dark" aria-label="Toggle light or dark theme">◐</button>
  </header>`;
}

function buildStickyHeader(result: ScanResult): string {
  const projectName = result.context.rootDir.split("/").pop() ?? "project";
  const g = gradeTokens(result.compositeScore, result.maxCompositeScore);
  return `<div class="sticky-header" id="sticky-header">
    <div class="sh-left"><span class="sh-dot"></span><span class="sh-name">VibeDrift &middot; ${esc(projectName)}</span></div>
    <div class="sh-right">
      <span class="num" style="font-weight:600;color:${g.color}">${result.compositeScore.toFixed(1)}/${result.maxCompositeScore}</span>
      <span class="sh-grade" style="background:${g.tint};color:${g.color}">${g.letter}</span>
    </div>
  </div>`;
}

function verdictText(letter: string): string {
  switch (letter) {
    case "A": return "Highly consistent. Your codebase closely follows the patterns it already uses.";
    case "B": return "Consistent overall. A few files drift from the patterns your codebase already follows; the fixes below close the gap.";
    case "C": return "Mostly consistent. A handful of files drift from the patterns your codebase already follows. The fixes below close most of the gap.";
    case "D": return "Inconsistent in several areas. Multiple files diverge from your codebase's own dominant patterns.";
    default: return "Highly inconsistent. Many files diverge from the patterns the rest of the codebase follows.";
  }
}

function buildSummaryHero(result: ScanResult, detailedUrl: string): string {
  const { compositeScore, maxCompositeScore, scores } = result;
  const g = gradeTokens(compositeScore, maxCompositeScore);
  const pct = maxCompositeScore > 0 ? (compositeScore / maxCompositeScore) * 100 : 0;

  // Honest scope qualifier: the composite is a geometric mean over only the
  // applicable categories, so when some cat-cards render N/A the headline /100
  // spans N<5 categories. Surface it near the hero so the score is never read
  // as a full five-category verdict. Mirrors the terminal renderer.
  const scopeNote = compositeScopeNote(applicableCategoryCount(scores), DRIFT_DISPLAY_CATEGORIES.length);
  const scopeLine = scopeNote
    ? `<p class="va-def">Composite ${esc(scopeNote.replace(/^\(|\)$/g, ""))} — the remaining categories had no signals in this repo.</p>`
    : "";

  // Trend: only claim an after-fix uplift when the projection actually moves.
  const top5 = topImpactFindings(result, 5);
  let trend = "";
  if (top5.length > 0) {
    const after = estimateScoreAfterFixes(result.findings, top5, result.context.totalLines, result.context);
    const gain = after.compositeScore - compositeScore;
    if (gain > 0.3) {
      const proj = gradeTokens(after.compositeScore, after.maxCompositeScore);
      trend = proj.letter !== g.letter
        ? `<span class="va-trend">on track for a <b>${proj.letter}</b> after the fixes below</span>`
        : `<span class="va-trend"><b>+${gain.toFixed(1)}</b> after the fixes below</span>`;
    }
  }

  const bandDefs: { letter: string; label: string }[] = [
    { letter: "A", label: "A 90+" },
    { letter: "B", label: "B 75–89" },
    { letter: "C", label: "C 50–74" },
    { letter: "D", label: "D 25–49" },
    { letter: "F", label: "F under 25" },
  ];
  const bands = bandDefs.map((b) =>
    b.letter === g.letter
      ? `<span class="va-band on" style="background:${g.color};border-color:${g.color}">${b.label}</span>`
      : `<span class="va-band">${b.label}</span>`,
  ).join("");

  const fixAction = top5.length > 0
    ? `<a class="btn btn-primary" href="#fix-first">Fix the top drifts</a>`
    : "";

  // Floor-gate badge (render-only): reuses the existing .badge.warn chip
  // (yellow accent, no new color) already used in the findings library.
  // Never changes compositeScore or g.letter above — see the grade-invariance
  // test in test/unit/output/floor-badge.test.ts.
  const floorTrip = hasFloorTrip(result.findings);
  const floorBadge = floorTrip.tripped
    ? `<span class="badge warn" title="${esc(floorTrip.reasons.join(", "))}">Security floor tripped</span>`
    : "";

  return `<section class="va-hero">
    <div class="va-hero-top">
      <div class="va-scorewrap">
        <span class="va-score num" style="color:${g.color}">${compositeScore.toFixed(1)}<span class="s"> /${maxCompositeScore}</span></span>
        <span class="va-grade" style="background:${g.tint};color:${g.color}">${g.letter}</span>
        ${floorBadge}
      </div>
      ${trend}
    </div>
    <div class="va-track"><i style="width:${pct.toFixed(1)}%;background:${g.color}"></i></div>
    <div class="va-ticks"><span class="num">0</span><span class="num">50</span><span class="num">100</span></div>
    <p class="va-verdict">${verdictText(g.letter)}</p>
    <p class="va-def"><b>Vibe Drift Score:</b> how consistently your codebase follows the patterns it already uses. Higher means more consistent.</p>
    ${scopeLine}
    <div class="va-bands">${bands}</div>
    <div class="va-actions">
      ${fixAction}
      <a class="btn btn-link" href="${esc(detailedUrl)}" target="_blank" rel="noopener">Open detailed report</a>
    </div>
  </section>`;
}

function buildCategoryBreakdown(result: ScanResult): string {
  const scores = result.scores as unknown as Record<string, { score: number; maxScore: number; applicable: boolean }>;
  // Floor-gate badge (render-only): folded into the Security Consistency
  // card's gloss note below. Never affects the card's score/color — see the
  // grade-invariance test in test/unit/output/floor-badge.test.ts.
  const floorTrip = hasFloorTrip(result.findings);
  // Dependency Health is not shown on the drift score display — it has no drift
  // detector and lives on the Hygiene track. Exclude it from the drift cards.
  const cards = SCORING_CATEGORY_ORDER.filter((cat) => cat !== "dependencyHealth").map((cat) => {
    const s = scores[cat];
    const label = esc(SCORING_CATEGORY_LABELS[cat]);
    const floorNote = cat === "securityPosture" && floorTrip.tripped
      ? `<div class="note"><span class="badge warn">Security floor</span> ${esc(floorTrip.reasons.join(", "))}. Fix before shipping (does not change the score).</div>`
      : "";
    const gloss =
      cat === "securityPosture"
        ? `<div class="note">Consistency of this repo's own auth and validation patterns, not the absence of vulnerabilities.</div>${floorNote}`
        : "";
    if (!s || !s.applicable) {
      // These drift detectors ran but found no applicable code in this repo.
      const naNote = "No findings in this repo";
      return `<div class="va-cat na"><div class="top"><span class="name">${label}</span></div><div class="val">N/A</div><div class="note">${naNote}</div>${gloss}</div>`;
    }
    const catPct = s.maxScore > 0 ? (s.score / s.maxScore) * 100 : 0;
    const col = pctToken(catPct);
    return `<div class="va-cat">
      <div class="top"><span class="name">${label}</span><span class="gdot" style="background:${col}"></span></div>
      <div class="val num">${s.score.toFixed(1)}<span class="s"> /${s.maxScore}</span></div>
      <div class="t"><i style="width:${catPct.toFixed(0)}%;background:${col}"></i></div>
      ${gloss}
    </div>`;
  }).join("");

  return `<section class="va-sect">
    <div class="va-sect-h"><h3>Category breakdown</h3><span class="meta">each scored out of 20</span></div>
    <div class="va-cats">${cards}</div>
  </section>`;
}

// Summary "Fix first". Exported + unit-tested: must render the projection in
// one scale (composite score + composite delta) and never throw.
export function buildFixPlanWidget(result: ScanResult): string {
  const top = topImpactFindings(result, 5);
  if (top.length === 0) {
    return `<section class="va-sect" id="fix-first">
      <div class="va-sect-h"><h3>Fix first</h3></div>
      <p class="va-sub">No drift findings with measurable impact. Your codebase is well-aligned — or the detectors didn't find peer baselines strong enough to flag deviations.</p>
    </section>`;
  }

  const after = estimateScoreAfterFixes(result.findings, top, result.context.totalLines, result.context);
  // Project in ONE scale: the composite score and its composite-point delta.
  // The per-item impact chips are a separate per-finding ranking signal and are
  // deliberately NOT summed into the headline — the composite is a geometric
  // mean, so its delta is not equal to the sum of per-item impacts.
  const projG = gradeTokens(after.compositeScore, after.maxCompositeScore);

  const rows = top.map((f) => {
    const impact = (f.consistencyImpact ?? 0).toFixed(2);
    const loc = f.locations[0];
    const fileLine = loc ? `${loc.file}${loc.line ? `:${loc.line}` : ""}` : "(project-wide)";
    const key = findingKey(f);
    return `<div class="va-fix-row">
      <input class="va-check" type="checkbox" aria-label="Mark fixed">
      <div class="va-fix-body">
        <span class="impact num">+${impact} to score</span>
        <div class="ttl">${esc(f.message.replace(/^DRIFT:\s*/, ""))}</div>
        <div class="src mono">${esc(fileLine)}</div>
      </div>
      <button class="va-copy" data-copy-id="${esc(key)}">Copy AI prompt</button>
    </div>`;
  }).join("");

  return `<section class="va-sect" id="fix-first">
    <div class="va-sect-h">
      <h3>Fix first</h3>
      <button class="va-copy" data-copy-id="__full_fix_plan__">Copy all as AI context</button>
    </div>
    <div class="va-fix">
      ${rows}
      <div class="va-fix-foot">
        <div class="big">Fixing all ${top.length} raises your score to <b class="num">${after.compositeScore.toFixed(1)}/${after.maxCompositeScore}</b>, a grade ${projG.letter} <span class="va-proj">(projected)</span>.</div>
        <div class="small">Closing several drifts together adds a little less than each on its own.</div>
      </div>
    </div>
  </section>`;
}

function buildDriftConcentration(result: ScanResult, detailedUrl: string): string {
  if (!result.perFileScores || result.perFileScores.size === 0) return "";

  type Row = { file: string; score: number; findingCount: number; weight: number };
  const rows: Row[] = [];
  for (const entry of result.perFileScores.values()) {
    if (entry.findings.length === 0) continue;
    const weight = entry.findings.reduce(
      (s, f) => s + (f.severity === "error" ? 3 : f.severity === "warning" ? 1.5 : 0.5) * (f.confidence ?? 1.0),
      0,
    );
    rows.push({ file: entry.file, score: entry.score, findingCount: entry.findings.length, weight });
  }
  if (rows.length === 0) return "";

  rows.sort((a, b) => {
    const delta = (a.score - a.weight * 5) - (b.score - b.weight * 5);
    if (delta !== 0) return delta;
    return a.file.localeCompare(b.file);
  });

  const shown = rows.slice(0, 5);
  const remaining = rows.length - shown.length;

  const fileRows = shown.map((r) => {
    const drift = Math.max(0, 100 - r.score);
    const col = driftToken(drift);
    const { dir, base } = pathParts(r.file);
    return `<div class="va-frow">
      <span class="va-path"><span class="dir">${esc(dir)}</span><span class="base">${esc(base)}</span></span>
      <span class="va-fbar"><span class="t"><i style="width:${drift}%;background:${col}"></i></span><span class="drift num">${drift}/100</span><span class="findings num">${r.findingCount}</span></span>
    </div>`;
  }).join("");

  const more = remaining > 0
    ? `<div class="va-more"><a href="${esc(detailedUrl)}" target="_blank" rel="noopener">${remaining} more file${remaining === 1 ? "" : "s"} in the detailed report &rarr;</a></div>`
    : "";

  return `<section class="va-sect">
    <div class="va-sect-h"><h3>Where drift concentrates</h3><span class="meta">${shown.length} most-drifted file${shown.length === 1 ? "" : "s"}</span></div>
    <div class="va-frow-h"><span>File</span><span>Drift &amp; findings</span></div>
    <div class="va-files">${fileRows}</div>
    ${more}
  </section>`;
}

// ──── Detailed report sections ────

function buildScoreRecap(result: ScanResult): string {
  const { compositeScore, maxCompositeScore } = result;
  const g = gradeTokens(compositeScore, maxCompositeScore);
  const scores = result.scores as unknown as Record<string, { score: number; maxScore: number; applicable: boolean }>;

  // Dependency Health is not shown on the drift score display (no drift
  // detector; lives on the Hygiene track). Exclude it from the drift bars.
  const bars = SCORING_CATEGORY_ORDER.filter((cat) => cat !== "dependencyHealth").map((cat) => {
    const s = scores[cat];
    const label = esc(SCORING_CATEGORY_LABELS[cat]);
    if (!s || !s.applicable) {
      return `<div class="dr-bar na"><span class="nm">${label}</span><span class="t"></span><span class="vl">N/A</span></div>`;
    }
    const catPct = s.maxScore > 0 ? (s.score / s.maxScore) * 100 : 0;
    const col = pctToken(catPct);
    return `<div class="dr-bar"><span class="nm">${label}</span><span class="t"><i style="width:${catPct.toFixed(0)}%;background:${col}"></i></span><span class="vl num">${s.score.toFixed(1)}/${s.maxScore}</span></div>`;
  }).join("");

  return `<section class="va-sect" style="margin-top:var(--sp-5)">
    <div class="va-sect-h"><h3>Score recap</h3><span class="meta">the same categories as the summary</span></div>
    <div class="dr-recap">
      <div class="dr-scorebox">
        <div class="dr-score num" style="color:${g.color}">${compositeScore.toFixed(1)}<span class="s"> /${maxCompositeScore}</span></div>
        <div class="dr-grade" style="color:${g.color};background:${g.tint}">Grade ${g.letter}</div>
      </div>
      <div class="dr-bars">${bars}</div>
    </div>
  </section>`;
}

function buildCodebaseIntent(result: ScanResult): string {
  const patterns = extractIntentPatterns(result);
  if (patterns.length === 0) return "";

  const cards = patterns.slice(0, 8).map((p) => {
    const warn = p.consistency < 80 ? " warn" : "";
    return `<div class="intent-card${warn}">
      <div class="pat">${esc(p.label)}</div>
      <div class="src">${esc(p.category)}</div>
      <div class="agree"><b>${p.dominantCount} of ${p.totalRelevant}</b> files agree</div>
    </div>`;
  }).join("");

  return `<section class="va-sect">
    <div class="va-sect-h"><h3>Codebase intent</h3><span class="meta">conventions VibeDrift inferred</span></div>
    <p class="va-sub">The patterns your codebase already follows. Drift is measured against these, not an external standard.</p>
    <div class="intent-grid">${cards}</div>
  </section>`;
}

function buildIntentCoherenceHeatmap(result: ScanResult): string {
  const files = buildFileCoherence(result);
  if (files.length === 0) return "";
  const categories = files[0]?.alignments.map((a) => a.category) ?? [];
  if (categories.length === 0) return "";

  // Drifting files first; cap the visible rows so the table stays contained.
  const drifting = files.filter((f) => f.alignmentPct < 100);
  const visible = (drifting.length > 0 ? drifting : files).slice(0, 12);
  const hidden = (drifting.length > 0 ? drifting.length : files.length) - visible.length;

  const headCells = categories.map((c) => `<th class="c hm-cat">${esc(c)}</th>`).join("");

  const bodyRows = visible.map((f) => {
    const cells = f.alignments.map((a) => {
      if (a.matches) return `<td class="c hm-cat"><span class="cell al-c"></span></td>`;
      const cls = f.alignmentPct < 50 ? "dv-c" : "wn-c";
      return `<td class="c hm-cat"><span class="cell ${cls}"></span></td>`;
    }).join("");
    const issues = f.alignments.filter((a) => !a.matches).map((a) => esc(a.actual ?? a.category)).slice(0, 2).join(", ");
    const { dir, base } = pathParts(f.path);
    return `<tr>
      <td class="file"><span class="dir">${esc(dir)}</span>${esc(base)}</td>
      ${cells}
      <td class="c alignv">${f.alignmentPct}%</td>
      <td class="issue">${issues || "—"}</td>
    </tr>`;
  }).join("");

  const more = hidden > 0 ? `<div class="hm-more">+ ${hidden} more file${hidden === 1 ? "" : "s"} with drift</div>` : "";

  return `<section class="va-sect">
    <div class="va-sect-h"><h3>Intent coherence</h3><span class="meta">per-file, per-category</span></div>
    <p class="va-sub">Each cell shows whether a file follows the dominant pattern for that category. Scan a column to find a drifting category, a row to find a drifting file.</p>
    <div class="hm-legend">
      <span class="k"><span class="hm-sq al"></span> Follows the pattern</span>
      <span class="k"><span class="hm-sq dv"></span> Deviates</span>
      <span class="k" style="color:var(--text-tertiary)">colour depth = severity</span>
    </div>
    <div class="hm-wrap">
      <table class="hm">
        <thead><tr><th>File</th>${headCells}<th class="c">Align</th><th>Issue</th></tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
      ${more}
    </div>
  </section>`;
}

const DRIFT_CAT_LABEL: Record<string, string> = {
  architectural_consistency: "Architectural consistency",
  security_posture: "Security consistency",
  semantic_duplication: "Semantic duplication",
  naming_conventions: "Convention drift",
  phantom_scaffolding: "Phantom scaffolding",
  import_style: "Import style drift",
  export_style: "Export style drift",
  async_patterns: "Async pattern drift",
};
const DRIFT_CAT_BADGE: Record<string, string> = {
  architectural_consistency: "Architectural",
  security_posture: "Security",
  semantic_duplication: "Duplication",
  naming_conventions: "Convention",
  phantom_scaffolding: "Scaffolding",
  import_style: "Convention",
  export_style: "Convention",
  async_patterns: "Convention",
};

/** Best-matching embedded-prompt key for a drift finding; always resolvable. */
function promptKeyForDrift(result: ScanResult, d: DriftFindingReport): string {
  const head = d.finding.slice(0, 30);
  const f = result.findings.find((f) =>
    f.analyzerId === "drift-" + d.driftCategory &&
    (f.message.replace(/^DRIFT:\s*/, "") === d.finding || f.message.includes(head)));
  return f ? findingKey(f) : "__full_fix_plan__";
}

function buildDriftFindingsLibrary(result: ScanResult): string {
  const order = ["architectural_consistency", "security_posture", "semantic_duplication", "naming_conventions", "phantom_scaffolding", "import_style", "export_style", "async_patterns"];
  const groups = order.map((cat) => ({
    cat,
    label: DRIFT_CAT_LABEL[cat] ?? cat,
    // result.driftFindings already excludes below-floor route-consistency
    // security findings (scoredDriftView at the scan source), so no per-widget
    // gate is needed here.
    findings: (result.driftFindings ?? []).filter((f) => f.driftCategory === cat),
  })).filter((g) => g.findings.length > 0);
  if (groups.length === 0) return "";

  const total = groups.reduce((s, g) => s + g.findings.length, 0);

  const sections = groups.map((g) => {
    const cards = g.findings.map((d) => {
      const total = d.totalRelevantFiles || 1;
      const dom = d.dominantCount;
      const dev = Math.max(0, total - dom);
      const domPct = Math.round((dom / total) * 100);
      const devPct = 100 - domPct;
      const badgeClass = sevBadgeClass(d.severity);
      const badgeText = esc(DRIFT_CAT_BADGE[d.driftCategory] ?? "Drift");

      const firstDev = d.deviatingFiles[0];
      const ev = firstDev?.evidence?.[0];
      const evidence = ev
        ? `<div class="evidence"><div class="loc">${esc(firstDev.path)}${ev.line ? ":" + ev.line : ""}</div><div class="code"><span class="del">${esc(ev.code.slice(0, 160))}</span></div></div>`
        : "";

      const devFiles = d.deviatingFiles.slice(0, 3).map((f) => f.path).join(", ");
      const devLabel = d.deviatingFiles.length > 0
        ? `Deviating: ${esc(devFiles)}${d.deviatingFiles.length > 3 ? ` (+${d.deviatingFiles.length - 3} more)` : ""}`
        : "";
      const rec = d.recommendation
        ? `<div class="rec"><b>Fix:</b> ${esc(d.recommendation)}</div>`
        : "";
      const key = promptKeyForDrift(result, d);

      return `<div class="finding">
        <div class="ft"><div class="title">${esc(d.finding)}</div><span class="badge ${badgeClass}">${badgeText}</span></div>
        <div class="propbar"><span class="seg dom" style="flex-basis:${domPct}%">${dom} of ${total}: ${esc(d.dominantPattern)}</span><span class="seg dev" style="flex-basis:${devPct}%">${dev} deviate${dev === 1 ? "s" : ""}</span></div>
        <div class="propcap">${esc(d.dominantPattern)} is the dominant pattern (${dom} of ${total} files, ${domPct}% consistent).</div>
        ${evidence}
        ${rec}
        <div class="ffoot">${devLabel ? `<span class="files">${devLabel}</span>` : "<span></span>"}<button class="va-copy" data-copy-id="${esc(key)}">Copy AI prompt</button></div>
      </div>`;
    }).join("");

    return `<div class="find-group">
      <div class="gh">${esc(g.label)} <span class="ct">${g.findings.length} finding${g.findings.length === 1 ? "" : "s"}</span></div>
      ${cards}
    </div>`;
  }).join("");

  return `<section class="va-sect">
    <div class="va-sect-h"><h3>Drift findings</h3><span class="meta">${total} finding${total === 1 ? "" : "s"}, grouped by category</span></div>
    ${sections}
  </section>`;
}

function buildFileRankingAccordion(result: ScanResult): string {
  const entries = [...result.perFileScores.entries()];
  const withFindings = entries.filter(([, v]) => v.findings.length > 0).sort((a, b) => a[1].score - b[1].score);
  if (withFindings.length === 0) return "";

  const items = withFindings.slice(0, 25).map(([file, data], i) => {
    const drift = Math.max(0, 100 - data.score);
    const { dir, base } = pathParts(file);

    // Dedup findings the same way the old ranking did, then list a few.
    const seen = new Set<string>();
    const keyOf = (f: Finding) =>
      ["duplicates", "codedna-fingerprint", "codedna-opseq", "ml-duplicate"].includes(f.analyzerId)
        ? `dup::${f.locations.map((l) => l.file).filter(Boolean).sort().join("::") || f.message}`
        : `${f.analyzerId}::${f.message}`;
    const deduped = data.findings.filter((f) => { const k = keyOf(f); if (seen.has(k)) return false; seen.add(k); return true; });
    const list = deduped.slice(0, 6).map((f) => {
      const loc = f.locations[0];
      const where = loc ? `${(loc.file.split("/").pop() ?? loc.file)}${loc.line ? ":" + loc.line : ""}` : "";
      return `<li>${esc(f.message.replace(/^DRIFT:\s*/, "").slice(0, 110))}${where ? ` <span class="mono">· ${esc(where)}</span>` : ""}</li>`;
    }).join("");

    return `<details${i === 0 ? " open" : ""}>
      <summary><span class="rpath"><span class="dir">${esc(dir)}</span>${esc(base)}</span><span class="rdrift">drift ${drift}/100</span><span class="rcount">${data.findings.length} finding${data.findings.length === 1 ? "" : "s"}</span></summary>
      <div class="rbody"><ul>${list || "<li>Findings for this file.</li>"}</ul></div>
    </details>`;
  }).join("");

  return `<section class="va-sect">
    <div class="va-sect-h"><h3>File ranking</h3><span class="meta">most-drifted files first</span></div>
    <div class="rank">${items}</div>
  </section>`;
}

function buildPatternConsensus(result: ScanResult): string {
  const drift = (result.driftFindings ?? []).filter((d) => d.totalRelevantFiles >= 3 && d.dominantCount > 0);
  if (drift.length === 0) return "";

  // Least agreement first — the contested axes are where the codebase
  // disagrees with itself, which is the interesting signal.
  const rows = [...drift]
    .sort((a, b) => a.consistencyScore - b.consistencyScore)
    .slice(0, 10)
    .map((d) => {
      const cat = `${d.driftCategory.replace(/_/g, " ")}${d.subCategory ? ` · ${d.subCategory.replace(/_/g, " ")}` : ""}`;
      const col = pctToken(d.consistencyScore);
      return `<div class="crow">
        <div class="cinfo"><div class="nm">${esc(cap(cat))}</div><div class="pat">dominant: ${esc(d.dominantPattern)}</div></div>
        <div class="cbar"><span class="t"><i style="width:${d.consistencyScore}%;background:${col}"></i></span><span class="v num">${d.dominantCount}/${d.totalRelevantFiles} · ${d.consistencyScore}%</span></div>
      </div>`;
    }).join("");

  return `<section class="va-sect">
    <div class="va-sect-h"><h3>Pattern consensus</h3><span class="meta">least agreement first</span></div>
    <p class="va-sub">How strongly each detected axis agrees on a single dominant pattern. The contested axes are where your codebase disagrees with itself.</p>
    <div class="consensus">${rows}</div>
  </section>`;
}

function buildHygiene(result: ScanResult): string {
  const hygiene = result.findings.filter((f) => getAnalyzerKind(f.analyzerId) === "hygiene");
  if (hygiene.length === 0) return "";

  const sorted = [...hygiene].sort((a, b) => {
    const sev = { error: 0, warning: 1, info: 2 };
    return (sev[a.severity as keyof typeof sev] ?? 2) - (sev[b.severity as keyof typeof sev] ?? 2);
  });

  const rows = sorted.slice(0, 10).map((f) => {
    const sevLabel = f.severity === "error" ? "Error" : f.severity === "warning" ? "Warn" : "Info";
    const loc = f.locations[0];
    const where = loc ? `${shortPath(loc.file)}${loc.line ? ":" + loc.line : ""}` : "";
    return `<div class="hyg-row"><span class="sev">${sevLabel}</span><span class="txt">${esc(f.message.slice(0, 110))}</span><span class="file">${esc(where)}</span></div>`;
  }).join("");

  const more = sorted.length > 10 ? `<div class="hyg-row"><span class="sev"></span><span class="txt" style="color:var(--text-tertiary)">+ ${sorted.length - 10} more hygiene checks</span><span class="file"></span></div>` : "";

  return `<section class="va-sect">
    <div class="va-sect-h"><h3>Hygiene</h3><span class="meta">not part of your Vibe Drift Score</span></div>
    <div class="hyg">
      <p class="hyg-note">General code-quality checks (complexity, duplication, dead code). Useful context, but they don't measure drift, so they're excluded from the score.</p>
      ${rows}
      ${more}
    </div>
  </section>`;
}

function buildDeepScanSection(result: ScanResult): string {
  const ml = result.findings.filter((f) => f.tags?.includes("ml"));
  const hasDeep = !!result.aiSummary || !!result.coherenceReport || (result.deepInsights?.length ?? 0) > 0 || ml.length > 0;

  if (hasDeep) {
    const blocks: string[] = [];

    if (result.coherenceReport) {
      const c = result.coherenceReport;
      const issues = (c.rankedIssues ?? []).slice(0, 6).map((i) => {
        const where = i.locations.length ? `<div class="src mono">${esc(i.locations.slice(0, 3).join(", "))}</div>` : "";
        const why = i.why ? `<div class="propcap">${esc(i.why)}</div>` : "";
        const fix = i.fix ? `<div class="rec"><b>Fix:</b> ${esc(i.fix)}</div>` : "";
        return `<div class="finding"><div class="ft"><div class="title">${esc(i.title)}</div><span class="badge ${sevBadgeClass(i.severity === "critical" || i.severity === "high" ? "error" : i.severity === "medium" ? "warning" : "info")}">${esc(i.severity)}</span></div>${where}${why}${fix}</div>`;
      }).join("");
      blocks.push(`<div class="find-group"><div class="gh">Coherence audit <span class="ct">grade ${esc(c.coherenceGrade)} · ${c.coherenceScore}/100</span></div>${c.verdict ? `<p class="va-sub">${esc(c.verdict)}</p>` : ""}${issues}</div>`);
    }

    if (result.aiSummary) {
      const hl = (result.aiSummary.highlights ?? []).map((h) => `<li>${esc(h)}</li>`).join("");
      blocks.push(`<div class="find-group"><div class="gh">AI summary</div><div class="finding"><p class="va-sub" style="margin:0">${esc(result.aiSummary.summary)}</p>${hl ? `<div class="rbody"><ul>${hl}</ul></div>` : ""}</div></div>`);
    }

    const insights = result.deepInsights ?? [];
    if (insights.length > 0) {
      const cards = insights.map((ins) => `<div class="finding"><div class="ft"><div class="title">${esc(ins.title)}</div><span class="badge ${sevBadgeClass(ins.severity)}">${esc(ins.category)}</span></div><div class="propcap">${esc(ins.description)}</div>${ins.recommendation ? `<div class="rec"><b>Fix:</b> ${esc(ins.recommendation)}</div>` : ""}</div>`).join("");
      blocks.push(`<div class="find-group"><div class="gh">Deep insights <span class="ct">${insights.length}</span></div>${cards}</div>`);
    }

    if (ml.length > 0) {
      const cards = ml.slice(0, 8).map((f) => `<div class="finding"><div class="ft"><div class="title">${esc(f.message)}</div><span class="badge ${sevBadgeClass(f.severity)}">AI</span></div>${f.locations.length ? `<div class="src mono">${esc(f.locations.map((l) => l.file).filter(Boolean).slice(0, 3).join(", "))}</div>` : ""}</div>`).join("");
      blocks.push(`<div class="find-group"><div class="gh">AI inference <span class="ct">${ml.length}</span></div>${cards}</div>`);
    }

    return `<section class="va-sect">
      <div class="va-sect-h"><h3>Deep scan results</h3><span class="meta">AI pass, graded against your own patterns</span></div>
      ${blocks.join("")}
    </section>`;
  }

  // Free scan: an honest locked teaser. Counts come only from real local
  // signals — we do not invent deep-scan findings before the deep scan ran.
  const teaseCount = (result.teaseMessages ?? []).length;
  const reimpl = result.reimplementationCandidates ?? 0;
  if (teaseCount === 0 && reimpl === 0) {
    return `<section class="va-sect">
      <div class="va-sect-h"><h3>Go deeper with a deep scan</h3><span class="meta">free once a month</span></div>
      <div class="locked">
        <p class="lhead">Your free scan ran the local detectors. A <b>deep scan</b> adds an AI pass they can't do: semantic-duplicate confirmation, intent lie-detection, and a coherence audit graded against your own patterns.</p>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:16px">
          <a class="btn btn-primary" href="https://vibedrift.ai" target="_blank" rel="noopener">Run a deep scan</a>
          <span class="lcmd"><code>vibedrift login</code>, then <code>vibedrift . --deep</code>. No card required.</span>
        </div>
      </div>
    </section>`;
  }

  const cards: string[] = [];
  if (reimpl > 0) cards.push(`<div class="lcard"><div class="n num">${reimpl}</div><div class="l">same-name reimplementations a deep scan would confirm</div></div>`);
  if (teaseCount > 0) cards.push(`<div class="lcard"><div class="n num">${teaseCount}</div><div class="l">finding${teaseCount === 1 ? "" : "s"} the local pass flagged for AI confirmation</div></div>`);

  return `<section class="va-sect">
    <div class="va-sect-h"><h3>Go deeper with a deep scan</h3><span class="meta">free once a month</span></div>
    <div class="locked">
      <p class="lhead">Your free scan ran the local detectors. A <b>deep scan</b> adds an AI pass they can't do, graded against your own patterns. Here is what the local pass already flagged, ready to confirm:</p>
      <div class="lcards">${cards.join("")}</div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <a class="btn btn-primary" href="https://vibedrift.ai" target="_blank" rel="noopener">Run a deep scan</a>
        <span class="lcmd"><code>vibedrift login</code>, then <code>vibedrift . --deep</code>. No card required.</span>
      </div>
    </div>
  </section>`;
}

function buildFooter(result: ScanResult, mode: "summary" | "detailed"): string {
  const hasDeep = result.findings.some((f) => f.tags?.includes("ml")) || !!result.aiSummary;
  const score = result.compositeScore;
  const max = result.maxCompositeScore;
  const badgeColor = score >= 75 ? "brightgreen" : score >= 50 ? "yellow" : "red";
  const badgeMd = `[![VibeDrift Score](https://img.shields.io/badge/VibeDrift-${encodeURIComponent(score.toFixed(0) + "/" + max)}-${badgeColor})](https://vibedrift.ai)`;

  const disclosure = hasDeep
    ? `Function snippets were sent to VibeDrift's AI API for analysis. No full files were transmitted; snippets are processed in memory and not stored.`
    : `Your source code never leaves your machine. VibeDrift sends one anonymous event per scan and per report open (counts and timing only, no code, no file contents, no paths) to improve its detectors. Turn it off with <code class="mono">--local-only</code>.`;

  const upsell = (mode === "summary" && !hasDeep)
    ? `<div class="va-upsell"><b>Catch what static analysis misses:</b> semantic duplicates, intent mismatches, and the full coherence audit. Your first deep scan each month is free. Run <code>vibedrift login</code>, then <code>vibedrift . --deep</code>. No card required.</div>`
    : "";

  const badge = mode === "summary"
    ? `<div class="va-badge">Add to your README: <code class="mono" data-copy="${esc(badgeMd)}" title="Click to copy">${esc(score.toFixed(0))}/${max} badge</code></div>`
    : "";

  const update = result.updateCheck?.outdated
    ? `<div class="va-upsell" style="border-left-color:var(--warn)"><b>New version available: ${esc(result.updateCheck.latest)}</b> (you're on ${esc(result.updateCheck.current)}). Each release sharpens detectors. Update with <code data-copy="vibedrift update" title="Click to copy">vibedrift update</code>.</div>`
    : "";

  return `<footer class="va-foot">
    <div class="va-foot-actions">
      <button class="va-ghost" id="vdExportCsv">Export CSV</button>
      <button class="va-ghost" id="vdExportPdf">Export PDF</button>
    </div>
    <p class="va-disclosure">${disclosure}</p>
    <div class="va-rescan">Re-align the top drifts and re-scan: <code class="mono" data-copy="vibedrift ." title="Click to copy">vibedrift .</code></div>
    ${upsell}
    ${update}
    ${badge}
    <div class="va-credit">Generated by VibeDrift v${getVersion()} &middot; ${result.context.files.length} files &middot; ${formatCount(result.context.totalLines)} lines &middot; ${(result.scanTimeMs / 1000).toFixed(1)}s</div>
    <div class="va-credit">vibedrift.ai &nbsp;·&nbsp; Built by the creator of <a href="https://thevibelang.org">VibeLang</a></div>
  </footer>`;
}

// ──── Embedded data for client-side exports ────

function buildEmbeddedData(result: ScanResult): string {
  const dna = result.codeDnaResult;

  const data = {
    version: getVersion(),
    project: result.context.rootDir.split("/").pop() ?? "project",
    score: result.compositeScore,
    maxScore: result.maxCompositeScore,
    fileCount: result.context.files.length,
    totalLines: result.context.totalLines,
    scanTimeMs: result.scanTimeMs,
    // result.driftFindings already excludes below-floor security findings
    // (scoredDriftView at the scan source), so the client-side "Export CSV"
    // data cannot list one under "DRIFT FINDINGS" either.
    driftFindings: (result.driftFindings ?? []).map((d) => ({
      severity: d.severity,
      category: d.driftCategory,
      finding: d.finding,
      dominant: d.dominantPattern,
      consistency: d.consistencyScore,
      devFiles: d.deviatingFiles.map((f) => f.path).join("; "),
      recommendation: d.recommendation,
    })),
    findings: result.findings.map((f) => ({
      severity: f.severity,
      analyzer: f.analyzerId,
      message: f.message,
      file: f.locations[0]?.file ?? "",
      line: f.locations[0]?.line ?? "",
      confidence: Math.round(f.confidence * 100),
    })),
    fileScores: [...result.perFileScores.entries()].sort((a, b) => a[1].score - b[1].score).map(([path, data]) => ({
      file: path,
      score: data.score,
      findings: data.findings.length,
    })),
    codeDna: dna ? {
      sequences: (dna.sequenceSimilarities ?? []).map((s: any) => ({
        a: s.functionA.name + "() in " + (s.functionA.relativePath || s.functionA.file),
        b: s.functionB.name + "() in " + (s.functionB.relativePath || s.functionB.file),
        pct: Math.round(s.similarity * 100),
      })),
      deviations: (dna.deviationJustifications ?? []).map((dj: any) => ({
        file: dj.relativePath || dj.file,
        verdict: dj.verdict,
        pattern: dj.deviatingPattern + " vs " + dj.dominantPattern,
      })),
    } : null,
    deepInsights: (result.deepInsights ?? []).map((ins) => ({
      severity: ins.severity,
      title: ins.title,
      description: ins.description,
      recommendation: ins.recommendation ?? "",
    })),
  };

  // Escape "</" so a finding message, file path, or project name containing
  // "</script>" can't terminate the data <script> block early (matches the
  // escaping already applied to the prompts blob below).
  return JSON.stringify(data).replace(/<\//g, "<\\/");
}

// Copied to the clipboard when a FREE user clicks a "Copy AI Prompt" button.
// Fix prompts are a paid feature, so the report source never carries the real
// prompt markdown for a free plan — only this upsell.
const FIX_PROMPT_UPSELL =
  "VibeDrift fix prompts are a Pro feature. Your findings, scores, and dominant patterns are free on every plan; the copy-ready, peer-grounded fix for each one is part of the paid deep scan. Run `vibedrift upgrade` to unlock.";

export function buildEmbeddedPrompts(result: ScanResult, isPaid: boolean): string {
  const map: Record<string, string> = {};
  if (!isPaid) {
    // Paid-only: emit the SAME keys so the copy buttons still resolve, but every
    // value is the upsell — no fix-prompt markdown reaches a free report's source.
    for (const f of result.findings) {
      map[findingKey(f)] = FIX_PROMPT_UPSELL;
      for (const filePath of f.metadata?.legacyFiles ?? []) {
        map[`${findingKey(f)}-legacy-${filePath}`] = FIX_PROMPT_UPSELL;
      }
    }
    map.__full_fix_plan__ = FIX_PROMPT_UPSELL;
    return JSON.stringify(map).replace(/<\//g, "<\\/");
  }
  const ctx = buildFixPromptContext(result);
  for (const f of result.findings) {
    // Standard drift fix prompt (default mode)
    map[findingKey(f)] = buildFixPromptMarkdown(f, ctx);
    // Per-legacy-file migration prompts when this finding has a pivot
    const legacyFiles = f.metadata?.legacyFiles ?? [];
    for (const filePath of legacyFiles) {
      const key = `${findingKey(f)}-legacy-${filePath}`;
      map[key] = buildFixPromptMarkdown(f, ctx, "legacy", filePath);
    }
  }
  map.__full_fix_plan__ = buildFullFixPlanMarkdown(topImpactFindings(result, 10), ctx);
  return JSON.stringify(map).replace(/<\//g, "<\\/");
}

// ──── Stylesheet (token system shared by both reports) ────

const STYLE = `
:root{
  --bg-page:#0C0D0F;--bg-surface:#15171B;--bg-elevated:#1E2127;--bg-code:#101216;
  --border:#262A31;--border-strong:#3A3F47;
  --text-primary:#E9EAE6;--text-secondary:#9DA2AB;--text-tertiary:#7C828B;
  --brand:#FFD000;--brand-strong:#FFDC3A;--on-brand:#1A1505;
  --good:#3FB950;--grade-b:#57C257;--warn:#E0A93A;--caution:#EF8B46;--bad:#F0556B;
  --good-tint:rgba(63,185,80,.13);--warn-tint:rgba(224,169,58,.14);--caution-tint:rgba(239,139,70,.14);--bad-tint:rgba(240,85,107,.13);
  --r:12px;--r-sm:8px;
  --fs-display:60px;--fs-h1:23px;--fs-h2:17px;--fs-h3:14px;--fs-lead:16px;--fs-body:14px;--fs-small:13px;--fs-label:12px;
  --sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:24px;--sp-6:32px;--sp-7:48px;
  --font-sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --font-mono:'IBM Plex Mono',ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;
}
html[data-theme="light"]{
  --bg-page:#FFFFFF;--bg-surface:#F6F7F9;--bg-elevated:#FFFFFF;--bg-code:#F0F2F5;
  --border:#E4E7EC;--border-strong:#CBD1D9;
  --text-primary:#191D22;--text-secondary:#4C535C;--text-tertiary:#6B727B;
  --brand:#F5C400;--brand-strong:#E0B400;--on-brand:#1A1505;
  --good:#1A7F37;--grade-b:#2DA44E;--warn:#9A6700;--caution:#BC4C00;--bad:#CF222E;
  --good-tint:rgba(26,127,55,.10);--warn-tint:rgba(154,103,0,.10);--caution-tint:rgba(188,76,0,.10);--bad-tint:rgba(207,34,46,.09);
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
html,body{overflow-x:hidden}
body{background:var(--bg-page);color:var(--text-primary);font-family:var(--font-sans);font-size:var(--fs-body);line-height:1.6;-webkit-font-smoothing:antialiased}
*{font-variant-ligatures:none}
.mono,.num,code{font-family:var(--font-mono)}
.num{font-variant-numeric:tabular-nums}
a{color:var(--text-primary);text-decoration:underline;text-decoration-color:var(--border-strong);text-underline-offset:3px}
a:hover{text-decoration-color:var(--brand)}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:4px}
.page{max-width:880px;margin:0 auto;padding:36px 28px 64px}

/* sticky mini-header */
.sticky-header{position:fixed;top:0;left:0;right:0;height:44px;background:var(--bg-surface);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 24px;z-index:100;opacity:0;pointer-events:none;transition:opacity .18s;font-size:13px}
.sticky-header.visible{opacity:1;pointer-events:auto}
.sh-left{display:flex;align-items:center;gap:9px;color:var(--text-secondary)}
.sh-dot{width:9px;height:9px;border-radius:2px;background:var(--brand)}
.sh-name{font-weight:600;color:var(--text-primary);font-size:12.5px}
.sh-right{display:flex;align-items:center;gap:8px}
.sh-grade{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:6px;font-weight:700;font-size:12px}

/* header */
.va-head{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--sp-4);flex-wrap:wrap}
.va-back{font-size:12px;color:var(--text-secondary);text-decoration:none;display:inline-block;margin-bottom:10px}
.va-back::before{content:"← ";color:var(--text-tertiary)}
.va-brand{display:flex;align-items:center;gap:9px;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--text-secondary)}
.va-brand .b{width:9px;height:9px;border-radius:2px;background:var(--brand)}
.va-titlerow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.va-title{font-size:var(--fs-h1);font-weight:700;margin:8px 0 0;letter-spacing:-.01em;color:var(--text-primary)}
.va-tag{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;padding:3px 8px}
.va-pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.va-pill{font-size:12px;color:var(--text-secondary);background:var(--bg-surface);border:1px solid var(--border);border-radius:999px;padding:3px 10px}
.va-pill b{color:var(--text-primary);font-weight:600}
.theme-toggle{font-size:18px;line-height:1;background:var(--bg-surface);border:1px solid var(--border);color:var(--text-secondary);width:34px;height:34px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none}
.theme-toggle:hover{border-color:var(--border-strong);color:var(--text-primary)}

/* verdict hero */
.va-hero{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r);padding:var(--sp-5);margin-top:var(--sp-5)}
.va-hero-top{display:flex;align-items:baseline;gap:var(--sp-4);flex-wrap:wrap}
.va-scorewrap{display:flex;align-items:baseline;gap:10px}
.va-score{font-size:var(--fs-display);font-weight:700;line-height:.9;letter-spacing:-.02em}
.va-score .s{font-size:20px;color:var(--text-tertiary);font-weight:500}
.va-grade{display:inline-flex;align-items:center;justify-content:center;min-width:38px;height:38px;padding:0 10px;border-radius:9px;font-size:20px;font-weight:700;align-self:center}
.va-trend{font-size:13px;color:var(--text-secondary);margin-left:auto;align-self:center}
.va-trend b{color:var(--good);font-weight:600}
.va-track{position:relative;height:8px;background:var(--bg-code);border-radius:5px;margin:18px 0 6px;overflow:hidden}
.va-track i{position:absolute;left:0;top:0;bottom:0;border-radius:5px;transition:width .6s cubic-bezier(.2,.7,.3,1)}
.va-ticks{display:flex;justify-content:space-between;font-size:11px;color:var(--text-tertiary)}
.va-verdict{font-size:var(--fs-lead);line-height:1.55;margin:18px 0 0;max-width:62ch;color:var(--text-primary)}
.va-def{font-size:13px;color:var(--text-secondary);margin:10px 0 0;max-width:62ch}
.va-def b{color:var(--text-primary)}
.va-bands{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px}
.va-band{font-size:11px;color:var(--text-tertiary);border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-variant-numeric:tabular-nums}
.va-band.on{color:var(--on-brand);font-weight:600}
.va-actions{display:flex;gap:12px;align-items:center;margin-top:20px;flex-wrap:wrap}
.btn{font:inherit;font-size:14px;font-weight:600;border-radius:9px;padding:10px 18px;cursor:pointer;border:1px solid transparent;text-decoration:none;display:inline-block}
.btn-primary{background:var(--brand);color:var(--on-brand);border-color:var(--brand)}
.btn-primary:hover{background:var(--brand-strong);border-color:var(--brand-strong)}
.btn-link{background:transparent;color:var(--text-secondary);border-color:var(--border);font-weight:500}
.btn-link:hover{border-color:var(--border-strong);color:var(--text-primary)}

/* section shell */
.va-sect{margin-top:var(--sp-7)}
.va-sect-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:var(--sp-4)}
.va-sect-h h3{font-size:var(--fs-h2);font-weight:600;margin:0;color:var(--text-primary)}
.va-sect-h .meta{font-size:12px;color:var(--text-tertiary)}
.va-sub{font-size:13px;color:var(--text-secondary);margin:-6px 0 16px;max-width:64ch}

/* category scorecard (summary) */
.va-cats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.va-cat{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r-sm);padding:14px}
.va-cat .top{display:flex;align-items:center;justify-content:space-between}
.va-cat .name{font-size:12px;font-weight:600;color:var(--text-secondary)}
.va-cat .gdot{width:9px;height:9px;border-radius:50%}
.va-cat .val{font-size:24px;font-weight:700;margin:8px 0 0}
.va-cat .val .s{font-size:13px;color:var(--text-tertiary);font-weight:500}
.va-cat .t{height:5px;border-radius:3px;background:var(--bg-code);margin-top:10px;overflow:hidden}
.va-cat .t i{display:block;height:100%;border-radius:3px}
.va-cat.na .val{color:var(--text-tertiary);font-size:18px}
.va-cat .note{font-size:11px;color:var(--text-tertiary);margin-top:8px}

/* fix first */
.va-fix{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
.va-fix-row{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:start;padding:16px;border-top:1px solid var(--border)}
.va-fix-row:first-child{border-top:0}
.va-check{appearance:none;-webkit-appearance:none;width:18px;height:18px;border:1.5px solid var(--border-strong);border-radius:5px;cursor:pointer;margin-top:2px;position:relative;flex:none;background:transparent}
.va-check:checked{background:var(--brand);border-color:var(--brand)}
.va-check:checked::after{content:"✓";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--on-brand);font-size:12px;font-weight:700}
.va-fix-body .impact{display:inline-block;font-size:11px;font-weight:600;color:var(--text-primary);background:var(--bg-elevated);border:1px solid var(--border);border-radius:5px;padding:2px 7px;margin-bottom:7px}
.va-fix-body .ttl{font-size:14px;font-weight:500;color:var(--text-primary);line-height:1.45}
.va-fix-body .src{font-size:12.5px;color:var(--text-secondary);margin-top:5px;overflow-wrap:anywhere}
.va-fix-foot{padding:16px;border-top:1px solid var(--border);background:var(--bg-elevated)}
.va-fix-foot .big{font-size:14px;color:var(--text-primary)}
.va-fix-foot .big b{color:var(--good)}
.va-fix-foot .va-proj{color:var(--text-tertiary);font-weight:400}
.va-fix-foot .small{font-size:12px;color:var(--text-tertiary);margin-top:4px}

/* copy button */
.va-copy{font:inherit;font-size:12px;font-weight:500;color:var(--text-secondary);background:transparent;border:1px solid var(--border);border-radius:7px;padding:6px 11px;cursor:pointer;white-space:nowrap}
.va-copy:hover{border-color:var(--brand-strong);color:var(--text-primary)}

/* where drift concentrates */
.va-files{display:flex;flex-direction:column;gap:2px}
.va-frow{display:grid;grid-template-columns:1fr 38%;gap:10px 16px;align-items:center;padding:12px 8px;border-radius:8px}
.va-frow:hover{background:var(--bg-surface)}
.va-path{min-width:0;overflow-wrap:anywhere;font-family:var(--font-mono);font-size:13px}
.va-path .dir{color:var(--text-tertiary)}
.va-path .base{color:var(--text-primary);font-weight:500}
.va-fbar{display:flex;align-items:center;gap:10px;min-width:0}
.va-fbar .t{flex:1;height:7px;border-radius:4px;background:var(--bg-code);overflow:hidden;min-width:24px}
.va-fbar .t i{display:block;height:100%;border-radius:4px}
.va-fbar .drift{font-size:12px;color:var(--text-secondary);white-space:nowrap}
.va-fbar .findings{font-size:11px;color:var(--text-tertiary);white-space:nowrap;background:var(--bg-surface);border:1px solid var(--border);border-radius:999px;padding:1px 8px}
.va-frow-h{display:grid;grid-template-columns:1fr 38%;gap:16px;padding:0 8px 8px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-tertiary)}
.va-more{font-size:13px;margin-top:12px;padding-left:8px}

/* score recap (detailed) */
.dr-recap{display:grid;grid-template-columns:auto 1fr;gap:28px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r);padding:var(--sp-5);align-items:center}
.dr-scorebox{text-align:center;padding-right:28px;border-right:1px solid var(--border)}
.dr-score{font-size:52px;font-weight:700;line-height:.9}
.dr-score .s{font-size:16px;color:var(--text-tertiary);font-weight:500}
.dr-grade{display:inline-block;margin-top:8px;font-size:13px;font-weight:600;border-radius:6px;padding:3px 12px}
.dr-bars{display:flex;flex-direction:column;gap:11px}
.dr-bar{display:grid;grid-template-columns:130px 1fr 70px;gap:12px;align-items:center}
.dr-bar .nm{font-size:13px;color:var(--text-secondary)}
.dr-bar .t{height:7px;border-radius:4px;background:var(--bg-code);overflow:hidden}
.dr-bar .t i{display:block;height:100%;border-radius:4px}
.dr-bar .vl{font-size:12.5px;color:var(--text-primary);text-align:right}
.dr-bar.na .vl{color:var(--text-tertiary)}

/* intent cards */
.intent-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.intent-card{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r-sm);padding:14px}
.intent-card .pat{font-size:14px;font-weight:600;font-family:var(--font-mono)}
.intent-card .src{font-size:11px;color:var(--text-tertiary);margin-top:6px}
.intent-card .agree{font-size:12px;color:var(--text-secondary);margin-top:8px}
.intent-card .agree b{color:var(--good);font-weight:600}
.intent-card.warn .agree b{color:var(--warn)}

/* heatmap */
.hm-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--text-secondary);margin-bottom:12px;align-items:center}
.hm-legend .k{display:inline-flex;align-items:center;gap:6px}
.hm-sq{width:13px;height:13px;border-radius:3px;display:inline-block}
.hm-sq.al{background:var(--good)}
.hm-sq.dv{background:var(--bad)}
.hm-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--r-sm)}
.hm{width:100%;border-collapse:collapse;min-width:520px}
.hm th{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em;color:var(--text-tertiary);padding:11px 12px;text-align:left;background:var(--bg-surface);border-bottom:1px solid var(--border)}
.hm th.c,.hm td.c{text-align:center;width:54px}
.hm td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle}
.hm tr:last-child td{border-bottom:0}
.hm .file{font-family:var(--font-mono);font-size:12.5px;white-space:nowrap}
.hm .file .dir{color:var(--text-tertiary)}
.hm .cell{width:16px;height:16px;border-radius:4px;display:inline-block}
.hm .al-c{background:var(--good)}.hm .dv-c{background:var(--bad)}.hm .wn-c{background:var(--warn)}
.hm .alignv{font-variant-numeric:tabular-nums;color:var(--text-secondary)}
.hm .issue{color:var(--text-secondary);font-size:12.5px}
.hm-more{font-size:13px;padding:12px;color:var(--text-secondary)}

/* findings library */
.find-group{margin-bottom:20px}
.find-group>.gh{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:10px}
.find-group>.gh .ct{font-size:11px;color:var(--text-tertiary);font-weight:500;background:var(--bg-surface);border:1px solid var(--border);border-radius:999px;padding:1px 8px}
.finding{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:10px}
.finding .ft{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;flex-wrap:wrap}
.finding .title{font-size:14px;font-weight:600;line-height:1.4}
.badge{font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border-radius:5px;padding:2px 7px;white-space:nowrap}
.badge.warn{background:var(--warn-tint);color:var(--warn)}
.badge.caution{background:var(--caution-tint);color:var(--caution)}
.badge.bad{background:var(--bad-tint);color:var(--bad)}
.propbar{display:flex;height:30px;border-radius:7px;overflow:hidden;margin:12px 0 6px;border:1px solid var(--border);font-size:11.5px;font-weight:600}
.propbar .seg{display:flex;align-items:center;padding:0 10px;white-space:nowrap;overflow:hidden}
.propbar .dom{background:var(--good-tint);color:var(--good)}
.propbar .dev{background:var(--bad-tint);color:var(--bad);justify-content:flex-end;margin-left:auto}
.propcap{font-size:12px;color:var(--text-tertiary);margin-bottom:12px}
.evidence{background:var(--bg-code);border:1px solid var(--border);border-radius:7px;padding:10px 12px;font-family:var(--font-mono);font-size:12.5px;overflow-x:auto;margin-bottom:4px}
.evidence .loc{color:var(--text-tertiary);font-size:11px;margin-bottom:5px}
.evidence .code{color:var(--text-primary);white-space:pre-wrap;word-break:break-word}
.evidence .code .del{color:var(--bad)}
.finding .rec{font-size:13px;color:var(--text-secondary);margin-top:12px}
.finding .rec b{color:var(--text-primary);font-weight:600}
.finding .src{font-size:12px;color:var(--text-tertiary);margin-top:6px;overflow-wrap:anywhere}
.finding .ffoot{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap}
.finding .files{font-size:12px;color:var(--text-tertiary);overflow-wrap:anywhere}

/* file ranking accordion */
.rank details{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:8px}
.rank summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:1fr auto auto;gap:14px;align-items:center;padding:13px 16px 13px 32px;position:relative}
.rank summary::-webkit-details-marker{display:none}
.rank summary::before{content:"▸";color:var(--text-tertiary);position:absolute;left:14px;transition:transform .15s}
.rank details[open] summary::before{transform:rotate(90deg)}
.rank .rpath{font-family:var(--font-mono);font-size:13px;overflow-wrap:anywhere}
.rank .rpath .dir{color:var(--text-tertiary)}
.rank .rdrift{font-size:12px;color:var(--text-secondary);white-space:nowrap}
.rank .rcount{font-size:11px;color:var(--text-tertiary);background:var(--bg-elevated);border:1px solid var(--border);border-radius:999px;padding:1px 8px;white-space:nowrap}
.rank .rbody{padding:0 16px 14px 32px;border-top:1px solid var(--border)}
.rank .rbody ul{list-style:none;margin:0;padding:0}
.rank .rbody li{font-size:13px;color:var(--text-secondary);margin:8px 0}
.rank .rbody .mono{font-size:12px;color:var(--text-tertiary)}

/* pattern consensus */
.consensus{display:flex;flex-direction:column;gap:10px}
.crow{display:grid;grid-template-columns:1fr 220px;gap:16px;align-items:center}
.crow .cinfo .nm{font-size:13px;color:var(--text-primary)}
.crow .cinfo .pat{font-size:11.5px;color:var(--text-tertiary);margin-top:2px}
.crow .cbar{display:flex;align-items:center;gap:10px}
.crow .cbar .t{flex:1;height:8px;border-radius:4px;background:var(--bg-code);overflow:hidden}
.crow .cbar .t i{display:block;height:100%}
.crow .cbar .v{font-size:12px;color:var(--text-secondary);white-space:nowrap}

/* hygiene */
.hyg{background:var(--bg-page);border:1px dashed var(--border);border-radius:var(--r);padding:16px}
.hyg-note{font-size:12px;color:var(--text-tertiary);margin:0 0 12px}
.hyg-row{display:grid;grid-template-columns:64px 1fr auto;gap:12px;align-items:baseline;padding:9px 0;border-top:1px solid var(--border)}
.hyg-row:first-of-type{border-top:0}
.hyg-row .sev{font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-tertiary)}
.hyg-row .txt{font-size:13px;color:var(--text-secondary)}
.hyg-row .file{font-size:11.5px;color:var(--text-tertiary);font-family:var(--font-mono);white-space:nowrap}

/* locked deep scan */
.locked{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r);padding:var(--sp-5)}
.locked .lhead{font-size:14px;color:var(--text-primary);max-width:62ch;line-height:1.55}
.locked .lhead b{font-weight:600}
.lcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0 18px}
.lcard{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--r-sm);padding:14px}
.lcard .n{font-size:24px;font-weight:700;color:var(--brand)}
.lcard .l{font-size:12.5px;color:var(--text-secondary);margin-top:4px}
.locked .lcmd{font-size:13px;color:var(--text-secondary)}
.locked .lcmd code{background:var(--bg-code);border:1px solid var(--border);border-radius:5px;padding:2px 7px;color:var(--text-primary);font-size:12px}

/* footer */
.va-foot{margin-top:var(--sp-7);border-top:1px solid var(--border);padding-top:var(--sp-5)}
.va-foot-actions{display:flex;gap:10px;flex-wrap:wrap}
.va-ghost{font:inherit;font-size:13px;color:var(--text-secondary);background:transparent;border:1px solid var(--border);border-radius:8px;padding:8px 14px;cursor:pointer}
.va-ghost:hover{border-color:var(--border-strong);color:var(--text-primary)}
.va-disclosure{font-size:12.5px;color:var(--text-secondary);line-height:1.6;margin:18px 0 0;max-width:64ch}
.va-disclosure code{background:var(--bg-code);border:1px solid var(--border);border-radius:5px;padding:1px 6px;font-size:12px;color:var(--text-primary)}
.va-rescan{font-size:13px;color:var(--text-secondary);margin-top:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.va-rescan code{background:var(--bg-code);border:1px solid var(--border);border-radius:6px;padding:3px 9px;color:var(--text-primary);font-size:12.5px;cursor:pointer}
.va-upsell{margin-top:18px;background:var(--bg-surface);border:1px solid var(--border);border-left:3px solid var(--brand);border-radius:8px;padding:14px 16px;font-size:13px;color:var(--text-secondary);line-height:1.6;max-width:64ch}
.va-upsell b{color:var(--text-primary);font-weight:600}
.va-upsell code{background:var(--bg-code);border:1px solid var(--border);border-radius:5px;padding:2px 7px;color:var(--text-primary);font-size:12px;cursor:pointer}
.va-badge{margin-top:18px;font-size:12px;color:var(--text-tertiary)}
.va-badge code{background:var(--bg-code);border:1px solid var(--border);border-radius:5px;padding:2px 7px;color:var(--text-secondary);cursor:pointer;margin-left:4px}
.va-credit{margin-top:14px;font-size:12px;color:var(--text-tertiary)}

/* toast */
.va-toast{position:fixed;bottom:24px;right:24px;background:var(--good);color:#06120a;font-size:13px;font-weight:600;padding:10px 16px;border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s;pointer-events:none;z-index:600}
.va-toast.show{opacity:1;transform:none}

@media(max-width:640px){
  .page{padding:18px 14px 48px}
  .va-hero{padding:18px}
  .va-score{font-size:46px}
  .va-trend{margin-left:0;width:100%;margin-top:4px}
  .va-cats{grid-template-columns:1fr}
  .va-fix-row{grid-template-columns:auto 1fr;row-gap:6px}
  .va-copy.full{grid-column:1 / -1}
  .va-fix-row .va-copy{grid-column:1 / -1;justify-self:start;margin-left:32px}
  .va-frow{grid-template-columns:1fr;gap:8px}
  .va-frow-h{display:none}
  .va-fbar{justify-content:flex-start}
  .va-sect{margin-top:34px}
  .dr-recap{grid-template-columns:1fr;gap:18px}
  .dr-scorebox{border-right:0;border-bottom:1px solid var(--border);padding:0 0 16px;display:flex;align-items:baseline;gap:14px;justify-content:flex-start}
  .dr-grade{margin-top:0}
  .dr-bar{grid-template-columns:110px 1fr 62px}
  .hm-cat{display:none}
  .hm{min-width:0}
  .hm .file{white-space:normal;overflow-wrap:anywhere}
  .crow{grid-template-columns:1fr;gap:6px}
  .hyg-row{grid-template-columns:56px 1fr}
  .hyg-row .file{grid-column:2;white-space:normal;overflow-wrap:anywhere}
  .va-toast{left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));text-align:center}
  .sticky-header{padding:0 12px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
@media print{
  :root{
    --bg-page:#fff;--bg-surface:#f6f7f9;--bg-elevated:#fff;--bg-code:#f0f2f5;
    --border:#e4e7ec;--border-strong:#cbd1d9;
    --text-primary:#191d22;--text-secondary:#4c535c;--text-tertiary:#6b727b;
    --good:#1a7f37;--grade-b:#2da44e;--warn:#9a6700;--caution:#bc4c00;--bad:#cf222e;
  }
  .sticky-header,.theme-toggle,.va-foot-actions,.va-copy,.va-toast,.btn{display:none!important}
  .page{max-width:100%;padding:0}
  .va-sect{page-break-inside:avoid;margin-top:28px}
  a{text-decoration:none}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;

// ──── Main Report ────

export function renderHtmlReport(
  result: ScanResult,
  mode: "summary" | "detailed" = "summary",
  urls: { detailedUrl?: string; summaryUrl?: string } = {},
  opts: { scanId?: string; beaconApiUrl?: string; isPaid?: boolean } = {},
): string {
  const projectName = result.context.rootDir.split("/").pop() ?? "project";
  const detailedUrl = urls.detailedUrl ?? "vibedrift-report-detailed.html";
  const summaryUrl = urls.summaryUrl ?? "vibedrift-report.html";
  const findingCount = result.findings.length;

  const body = mode === "summary"
    ? `${buildReportHeader(result, "summary", summaryUrl, findingCount)}
${buildSummaryHero(result, detailedUrl)}
${buildCategoryBreakdown(result)}
${buildFixPlanWidget(result)}
${buildDriftConcentration(result, detailedUrl)}
${buildFooter(result, "summary")}`
    : `${buildReportHeader(result, "detailed", summaryUrl, findingCount)}
${buildScoreRecap(result)}
${buildCodebaseIntent(result)}
${buildIntentCoherenceHeatmap(result)}
${buildDriftFindingsLibrary(result)}
${buildFileRankingAccordion(result)}
${buildPatternConsensus(result)}
${buildHygiene(result)}
${buildDeepScanSection(result)}
${buildFooter(result, "detailed")}`;

  const beacon = opts.scanId ? `
// Report-open beacon — fires once when the report loads in a browser.
(function(){
  try{
    var url="${opts.beaconApiUrl ?? "https://vibedrift-api.fly.dev"}/v1/beacon/report-open";
    fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({scan_id:"${opts.scanId}",opened_at:new Date().toISOString()})}).catch(function(){});
  }catch(e){}
})();` : "";

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark light">
<title>VibeDrift Report &mdash; ${esc(projectName)}</title>
<script>(function(){try{var t=localStorage.getItem('vibedrift-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<style>${STYLE}</style>
</head>
<body>
${buildStickyHeader(result)}
<div class="page">
${body}
</div>
<div class="va-toast" id="vd-toast" role="status" aria-live="polite"></div>

<script>
window.__VIBEDRIFT_DATA = ${buildEmbeddedData(result)};
window.__VIBEDRIFT_PROMPTS = ${buildEmbeddedPrompts(result, opts.isPaid ?? false)};
${beacon}
</script>

<script>
(function(){
  var root=document.documentElement;

  // Theme toggle (persisted; pre-paint script in <head> avoids the flash).
  var tbtn=document.getElementById('reportTheme');
  if(tbtn)tbtn.addEventListener('click',function(){
    var next=root.getAttribute('data-theme')==='light'?'dark':'light';
    root.setAttribute('data-theme',next);
    try{localStorage.setItem('vibedrift-theme',next);}catch(e){}
  });

  // Toast
  function toast(msg){
    var t=document.getElementById('vd-toast');
    if(!t)return;
    t.textContent=msg;t.classList.add('show');
    clearTimeout(t._t);t._t=setTimeout(function(){t.classList.remove('show');},1700);
  }

  function fallbackCopy(text){
    try{
      var ta=document.createElement('textarea');ta.value=text;
      ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.focus();ta.select();
      var ok=document.execCommand('copy');document.body.removeChild(ta);return ok;
    }catch(e){return false;}
  }
  function copyText(text,okMsg){
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){toast(okMsg);},function(){toast(fallbackCopy(text)?okMsg:'Copy failed');});
    }else{toast(fallbackCopy(text)?okMsg:'Clipboard not available');}
  }

  // Copy AI prompt (resolves an id against the embedded prompts map).
  document.querySelectorAll('[data-copy-id]').forEach(function(b){
    b.addEventListener('click',function(){
      var map=window.__VIBEDRIFT_PROMPTS||{};
      var text=map[b.getAttribute('data-copy-id')];
      if(!text){toast('Copy failed — prompt missing');return;}
      copyText(text,'AI prompt copied to clipboard');
    });
  });
  // Copy literal text (re-scan command, badge markdown).
  document.querySelectorAll('[data-copy]').forEach(function(b){
    b.addEventListener('click',function(){copyText(b.getAttribute('data-copy'),'Copied to clipboard');});
  });

  // Sticky mini-header reveals once the main header scrolls out of view.
  var hdr=document.getElementById('report-header');
  var sticky=document.getElementById('sticky-header');
  if(hdr&&sticky&&'IntersectionObserver' in window){
    new IntersectionObserver(function(e){sticky.classList.toggle('visible',!e[0].isIntersecting);},{threshold:0}).observe(hdr);
  }

  // Export: PDF via the browser's print dialog.
  var pdf=document.getElementById('vdExportPdf');
  if(pdf)pdf.addEventListener('click',function(){window.print();});

  // Export: CSV built from the embedded report data.
  var csv=document.getElementById('vdExportCsv');
  if(csv)csv.addEventListener('click',function(){
    var d=window.__VIBEDRIFT_DATA;
    if(!d){toast('Report data not available');return;}
    var q=function(v){var s=String(v);return /[",\\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
    var row=function(){return Array.prototype.slice.call(arguments).map(q).join(',');};
    var L=[];
    L.push('VIBEDRIFT REPORT');
    L.push(row('Project',d.project));
    L.push(row('Score',d.score+'/'+d.maxScore));
    L.push(row('Files',d.fileCount));
    L.push(row('Lines',d.totalLines));
    L.push('');
    L.push('DRIFT FINDINGS');
    L.push(row('Severity','Category','Finding','Dominant Pattern','Consistency %','Deviating Files','Recommendation'));
    (d.driftFindings||[]).forEach(function(f){L.push(row(f.severity,f.category,f.finding,f.dominant,f.consistency,f.devFiles,f.recommendation));});
    L.push('');
    L.push('ALL FINDINGS');
    L.push(row('Severity','Analyzer','Message','File','Line','Confidence'));
    (d.findings||[]).forEach(function(f){L.push(row(f.severity,f.analyzer,f.message,f.file,f.line,f.confidence));});
    L.push('');
    L.push('FILE SCORES');
    L.push(row('File','Score','Findings'));
    (d.fileScores||[]).forEach(function(f){L.push(row(f.file,f.score,f.findings));});
    var blob=new Blob([L.join('\\n')],{type:'text/csv'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=d.project+'-vibedrift.csv';a.click();URL.revokeObjectURL(a.href);
    toast('CSV downloaded');
  });
})();
</script>
</body>
</html>`;
}
