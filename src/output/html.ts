import type { ScanResult, Finding, DriftFindingReport } from "../core/types.js";
import { getVersion } from "../core/version.js";
import { buildFixPromptMarkdown, buildFullFixPlanMarkdown, findingKey, type FixPromptContext } from "./fix-prompt.js";
import { estimateScoreAfterFixes } from "../scoring/engine.js";
import { getAnalyzerKind } from "../scoring/categories.js";
import { formatCount } from "./format.js";

const SCORING_CATEGORY_LABELS: Record<string, string> = {
  architecturalConsistency: "Architectural",
  redundancy: "Redundancy",
  dependencyHealth: "Dependencies",
  securityPosture: "Security",
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
    .filter((f) => typeof f.consistencyImpact === "number" && f.consistencyImpact > 0)
    .sort((a, b) => (b.consistencyImpact ?? 0) - (a.consistencyImpact ?? 0))
    .slice(0, n);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function gradeFor(score: number, max: number): { letter: string; color: string } {
  const pct = max > 0 ? (score / max) * 100 : 0;
  if (pct >= 90) return { letter: "A", color: "var(--grade-a)" };
  if (pct >= 75) return { letter: "B", color: "var(--grade-b)" };
  if (pct >= 50) return { letter: "C", color: "var(--grade-c)" };
  if (pct >= 25) return { letter: "D", color: "var(--grade-d)" };
  return { letter: "F", color: "var(--grade-f)" };
}

function sevColor(sev: string): string {
  if (sev === "error") return "var(--drift-red)";
  if (sev === "warning") return "var(--drift-orange)";
  return "var(--info-blue)";
}

function sevLabel(sev: string): string {
  if (sev === "error") return "CRITICAL";
  if (sev === "warning") return "WARNING";
  return "INFO";
}

function scoreColor(score: number): string {
  if (score <= 25) return "var(--drift-red)";
  if (score <= 50) return "var(--drift-orange)";
  if (score <= 75) return "var(--drift-amber)";
  if (score <= 90) return "var(--grade-b)";
  return "var(--grade-a)";
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

// ──── Section Builders ────

function buildHeader(result: ScanResult): string {
  const name = result.context.rootDir.split("/").pop() ?? "project";
  const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = (result.scanTimeMs / 1000).toFixed(1);
  const langs = [...result.context.languageBreakdown.entries()]
    .sort((a, b) => b[1].files - a[1].files)
    .map(([l, s]) => `${l.charAt(0).toUpperCase() + l.slice(1)} (${Math.round((s.files / result.context.files.length) * 100)}%)`)
    .join(", ");

  return `<header id="report-header" style="padding:32px 0 24px;border-bottom:1px solid var(--border)">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="display:inline-block;width:10px;height:10px;background:var(--brand-cyan)"></span><span class="label" style="margin-bottom:0;letter-spacing:2px">VIBEDRIFT REPORT</span></div>
      <div class="heading" style="font-size:24px;font-weight:700;color:var(--text-primary);text-transform:uppercase;letter-spacing:-0.5px">${esc(name)}</div>
    </div>
    <div style="text-align:right;font-size:13px;color:var(--text-secondary)">
      <div>${date} &middot; ${time}s</div>
      <div>${result.context.files.length} files &middot; ${formatCount(result.context.totalLines)} LOC</div>
      <div style="color:var(--text-tertiary)">${langs}</div>
    </div>
  </div>
</header>`;
}

function buildIntentDefinition(patterns: IntentPattern[]): string {
  if (patterns.length === 0) return "";

  const cards = patterns.map((p) => {
    return `<div style="background:var(--bg-surface);border-left:3px solid var(--intent-green);border-radius:0;padding:14px 16px;min-width:160px;flex:1">
      <div class="label" style="color:var(--text-tertiary)">${esc(p.category)}</div>
      <div style="font-size:14px;font-weight:500;color:var(--text-primary);margin:4px 0">${esc(p.label)}</div>
      <div class="mono" style="font-size:12px;color:var(--intent-green)">${p.dominantCount} of ${p.totalRelevant} files (${p.consistency}%)</div>
    </div>`;
  }).join("");

  return `<section class="section">
  <div class="label">CODEBASE INTENT</div>
  <div style="display:flex;gap:12px;flex-wrap:wrap">${cards}</div>
</section>`;
}

function buildCoherenceMatrix(files: FileCoherence[]): string {
  if (files.length === 0) return "";

  const categories = files[0]?.alignments.map((a) => a.category) ?? [];
  if (categories.length === 0) return "";

  // Split into aligned (100%) and drifting
  const aligned = files.filter((f) => f.alignmentPct === 100);
  const drifting = files.filter((f) => f.alignmentPct < 100).sort((a, b) => a.alignmentPct - b.alignmentPct);

  const colHeaders = categories.map((c) =>
    `<th style="padding:6px 12px;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;text-align:center;font-weight:600">${esc(c)}</th>`
  ).join("");

  function buildAlignmentCells(f: FileCoherence): { cells: string; deviations: string[] } {
    const deviations: string[] = [];
    const cells = f.alignments.map((a) => {
      if (a.matches) return `<td style="text-align:center;padding:6px 12px;color:var(--intent-green);font-size:14px">&#9679;</td>`;
      const devColor = f.alignmentPct <= 25 ? "var(--drift-red)" : f.alignmentPct <= 50 ? "var(--drift-orange)" : "var(--drift-amber)";
      deviations.push(`${a.category}: ${a.actual ?? "deviates"}`);
      return `<td style="text-align:center;padding:6px 12px;color:${devColor};font-size:13px" data-tooltip="${esc(a.actual ?? "deviates")}">&#9670;</td>`;
    }).join("");
    return { cells, deviations };
  }

  function buildDeviationSummary(deviations: string[]): string {
    return deviations.length > 0
      ? `<td style="padding:6px 12px;font-size:11px;color:var(--text-secondary);max-width:250px">${deviations.map((d) => esc(d)).join("; ")}</td>`
      : `<td style="padding:6px 12px;font-size:11px;color:var(--intent-green)">Fully aligned</td>`;
  }

  function fileRow(f: FileCoherence, open?: boolean): string {
    const pctColor = f.alignmentPct >= 100 ? "var(--intent-green)" : f.alignmentPct >= 50 ? "var(--drift-amber)" : "var(--drift-red)";
    const bgTint = f.alignmentPct < 50 ? "var(--tint-red)" : f.alignmentPct < 100 ? "var(--tint-amber)" : "transparent";
    const { cells, deviations } = buildAlignmentCells(f);
    const summary = buildDeviationSummary(deviations);

    return `<tr style="background:${bgTint}" id="file-${esc(f.path.replace(/[^a-zA-Z0-9]/g, "-"))}">
      <td class="mono" style="padding:6px 12px;font-size:12px;color:var(--text-secondary);white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis" data-scroll-to="rank-${esc(f.path.replace(/[^a-zA-Z0-9]/g, "-"))}">${esc(f.path)}</td>
      ${cells}
      <td class="mono" style="padding:6px 12px;text-align:right;font-weight:600;color:${pctColor}">${f.alignmentPct}%</td>
      ${summary}
    </tr>`;
  }

  const colCount = categories.length + 3; // file + categories + align + summary

  // Show first 3 aligned, then collapse rest in a native <details>
  const alignedRows = aligned.slice(0, 3).map((f) => fileRow(f)).join("");
  const collapsedAligned = aligned.length > 3
    ? `<tr><td colspan="${colCount}" style="padding:0"><details style="margin:0">
         <summary style="cursor:pointer;padding:8px 16px;font-size:12px;color:var(--text-tertiary);list-style:none;display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.02)">
           <span class="chevron">&#9654;</span> ${aligned.length - 3} more files at 100% alignment
         </summary>
         <table style="width:100%;border-collapse:collapse">${aligned.slice(3).map((f) => fileRow(f)).join("")}</table>
       </details></td></tr>` : "";

  // Collapse files with identical single-issue deviations to reduce noise
  // e.g., "8 files deviate on naming only (camelCase)" as a collapsed row
  const singleIssueDrifting = new Map<string, FileCoherence[]>(); // deviation key → files
  const multiIssueDrifting: FileCoherence[] = [];

  for (const f of drifting) {
    const devs = f.alignments.filter((a) => !a.matches);
    if (devs.length === 1) {
      const key = `${devs[0].category}: ${devs[0].actual ?? "deviates"}`;
      if (!singleIssueDrifting.has(key)) singleIssueDrifting.set(key, []);
      singleIssueDrifting.get(key)!.push(f);
    } else {
      multiIssueDrifting.push(f);
    }
  }

  // Render multi-issue files individually (these are the interesting ones)
  let driftingRows = multiIssueDrifting.map((f) => fileRow(f)).join("");

  // Render single-issue groups: if >=4 files share the same deviation, collapse them
  for (const [devKey, files2] of singleIssueDrifting) {
    if (files2.length >= 4) {
      // Show first file, then collapse the rest in a native <details>
      driftingRows += fileRow(files2[0]);
      driftingRows += `<tr><td colspan="${colCount}" style="padding:0"><details style="margin:0">
        <summary style="cursor:pointer;padding:8px 16px;font-size:12px;color:var(--text-tertiary);list-style:none;display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.02)">
          <span class="chevron">&#9654;</span> ${files2.length - 1} more files with same drift <span style="color:var(--drift-orange)">(${esc(devKey)})</span>
        </summary>
        <table style="width:100%;border-collapse:collapse">${files2.slice(1).map((f) => fileRow(f)).join("")}</table>
      </details></td></tr>`;
    } else {
      driftingRows += files2.map((f) => fileRow(f)).join("");
    }
  }

  // Summary bar
  const total = files.length;
  const fullAlign = aligned.length;
  const partial = drifting.filter((f) => f.alignmentPct >= 50).length;
  const significant = drifting.filter((f) => f.alignmentPct > 0 && f.alignmentPct < 50).length;
  const critical = drifting.filter((f) => f.alignmentPct === 0).length;
  const coherencePct = total > 0 ? Math.round((fullAlign / total) * 100) : 100;

  const barSegments = [
    { pct: (fullAlign / total) * 100, color: "var(--intent-green)" },
    { pct: (partial / total) * 100, color: "var(--drift-amber)" },
    { pct: (significant / total) * 100, color: "var(--drift-orange)" },
    { pct: (critical / total) * 100, color: "var(--drift-red)" },
  ].filter((s) => s.pct > 0).map((s) =>
    `<div style="width:${s.pct}%;height:100%;background:${s.color}"></div>`
  ).join("");

  return `<section class="section">
  <div class="label">INTENT COHERENCE</div>
  <div style="display:flex;gap:20px;margin-bottom:16px;font-size:12px;color:var(--text-secondary);flex-wrap:wrap;align-items:center">
    <span style="display:flex;align-items:center;gap:5px"><span style="color:var(--intent-green);font-size:14px">&#9679;</span> Follows dominant pattern</span>
    <span style="display:flex;align-items:center;gap:5px"><span style="color:var(--drift-amber);font-size:13px">&#9670;</span> Deviates from intent</span>
    <span style="display:flex;align-items:center;gap:5px"><span style="color:var(--drift-orange);font-size:13px">&#9670;</span> Multiple deviations</span>
    <span style="display:flex;align-items:center;gap:5px"><span style="color:var(--drift-red);font-size:13px">&#9670;</span> Critical drift</span>
  </div>
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="padding:6px 12px;text-align:left;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">File</th>
        ${colHeaders}
        <th style="padding:6px 12px;text-align:right;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Align</th>
        <th style="padding:6px 12px;text-align:left;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Issue</th>
      </tr></thead>
      <tbody>
        ${driftingRows}
        ${alignedRows}
        ${collapsedAligned}
      </tbody>
    </table>
  </div>
  <div style="margin-top:16px">
    <div style="display:flex;height:6px;border-radius:0;overflow:hidden;gap:2px">${barSegments}</div>
    <div style="display:flex;gap:16px;margin-top:6px;font-size:12px;color:var(--text-tertiary);flex-wrap:wrap">
      <span style="color:var(--intent-green)">${fullAlign} aligned</span>
      ${partial > 0 ? `<span style="color:var(--drift-amber)">${partial} partial</span>` : ""}
      ${significant > 0 ? `<span style="color:var(--drift-orange)">${significant} significant</span>` : ""}
      ${critical > 0 ? `<span style="color:var(--drift-red)">${critical} critical</span>` : ""}
      <span style="margin-left:auto;font-weight:500;color:var(--text-secondary)">${coherencePct}% intent coherence</span>
    </div>
  </div>
</section>`;
}

function buildAiSummaryWidget(result: ScanResult): string {
  const ai = result.aiSummary;
  if (!ai) return "";

  const highlights = (ai.highlights ?? []).map((h) =>
    `<li style="margin:4px 0;font-size:13px;color:var(--text-primary)">${esc(h)}</li>`
  ).join("");

  return `<section class="section" style="margin-bottom:32px">
  <div style="background:rgba(255,208,0,0.03);border:1px solid var(--border);border-radius:0;padding:24px 28px;position:relative;overflow:hidden">
    <div style="position:absolute;top:0;left:0;width:3px;height:100%;background:var(--border)"></div>
    <div class="score-layout" style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap">
      <div style="flex:1;min-width:280px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="font-size:16px">&#129302;</span>
          <span class="label" style="margin-bottom:0">AI SUMMARY</span>
        </div>
        <p style="font-size:15px;color:var(--text-primary);line-height:1.7;margin:0">${esc(ai.summary)}</p>
      </div>
      ${highlights ? `<div style="min-width:200px;max-width:300px;background:var(--bg-surface);border-radius:0;padding:14px 18px">
        <div style="font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Key Takeaways</div>
        <ul style="list-style:none;padding:0;margin:0">${highlights}</ul>
      </div>` : ""}
    </div>
    <div style="margin-top:10px;font-size:10px;color:var(--text-tertiary)">Generated by Claude Haiku</div>
  </div>
</section>`;
}

function buildCoherenceReportWidget(result: ScanResult): string {
  const c = result.coherenceReport;
  if (!c) return "";

  const sevColor: Record<string, string> = {
    critical: "#ff4d4d", high: "#ff8a3d", medium: "#ffd000", low: "var(--text-tertiary)",
  };

  const issues = (c.rankedIssues ?? []).slice(0, 8).map((i) => {
    const color = sevColor[i.severity] ?? "#ffd000";
    const locs = i.locations.length
      ? `<div style="font-size:11px;color:var(--text-tertiary);margin-top:4px">at ${esc(i.locations.slice(0, 4).join(", "))}</div>`
      : "";
    const pattern = i.pattern ? `<span style="color:var(--text-tertiary)"> · breaks: ${esc(i.pattern)}</span>` : "";
    const why = i.why ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:6px">${esc(i.why)}</div>` : "";
    const fix = i.fix ? `<div style="font-size:13px;color:#3ddc84;margin-top:6px">→ ${esc(i.fix)}</div>` : "";
    return `<li style="margin:0 0 16px 0;padding-left:14px;border-left:3px solid ${color}">
      <div style="font-size:14px;font-weight:600;color:var(--text-primary)">
        <span style="color:${color};text-transform:uppercase;font-size:11px;letter-spacing:.5px">${esc(i.severity)}</span>
        &nbsp;${esc(i.title)}${pattern}
      </div>${locs}${why}${fix}
    </li>`;
  }).join("");

  const strengths = (c.strengths ?? []).slice(0, 3)
    .map((s) => `<li style="margin:4px 0;font-size:13px;color:var(--text-secondary)">✓ ${esc(s)}</li>`).join("");

  const gradeStr = c.coherenceGrade ? `${esc(c.coherenceGrade)} · ${c.coherenceScore}/100` : `${c.coherenceScore}/100`;

  return `<section class="section" style="margin-bottom:32px">
  <div style="background:rgba(0,200,255,0.03);border:1px solid var(--border);border-radius:0;padding:24px 28px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <span style="font-size:16px">&#129518;</span>
      <span class="label" style="margin-bottom:0">COHERENCE AUDIT</span>
      <span style="margin-left:auto;font-size:13px;font-weight:700;color:var(--accent,#00c8ff)">${gradeStr}</span>
    </div>
    ${c.verdict ? `<p style="font-size:15px;color:var(--text-primary);line-height:1.7;margin:0 0 16px">${esc(c.verdict)}</p>` : ""}
    ${issues ? `<ul style="list-style:none;padding:0;margin:0">${issues}</ul>` : ""}
    ${strengths ? `<div style="margin-top:14px"><div style="font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Already coherent</div><ul style="list-style:none;padding:0;margin:0">${strengths}</ul></div>` : ""}
    <div style="margin-top:12px;font-size:10px;color:var(--text-tertiary)">Graded against this codebase's own patterns · VibeDrift deep scan</div>
  </div>
</section>`;
}

function getDriftCats(result: ScanResult) {
  const ds = result.driftScores ?? {};
  return [
    { name: "Architectural Consistency", shortName: "Architecture", score: ds.architectural_consistency?.score ?? 0, max: ds.architectural_consistency?.maxScore ?? 25, findings: ds.architectural_consistency?.findings ?? 0 },
    { name: "Security Posture", shortName: "Security", score: ds.security_posture?.score ?? 0, max: ds.security_posture?.maxScore ?? 25, findings: ds.security_posture?.findings ?? 0 },
    { name: "Semantic Duplication", shortName: "Duplication", score: ds.semantic_duplication?.score ?? 0, max: ds.semantic_duplication?.maxScore ?? 20, findings: ds.semantic_duplication?.findings ?? 0 },
    { name: "Convention Drift", shortName: "Conventions", score: ds.naming_conventions?.score ?? 0, max: ds.naming_conventions?.maxScore ?? 15, findings: ds.naming_conventions?.findings ?? 0 },
    { name: "Phantom Scaffolding", shortName: "Scaffolding", score: ds.phantom_scaffolding?.score ?? 0, max: ds.phantom_scaffolding?.maxScore ?? 15, findings: ds.phantom_scaffolding?.findings ?? 0 },
  ];
}

function buildScoreSection(result: ScanResult): string {
  const { compositeScore, maxCompositeScore } = result;
  const { letter, color } = gradeFor(compositeScore, maxCompositeScore);
  const cats = getDriftCats(result);

  const bars = cats.map((c) => {
    const pct = c.max > 0 ? (c.score / c.max) * 100 : 0;
    const { color: barColor } = gradeFor(c.score, c.max);
    return `<div style="display:flex;align-items:center;gap:10px;margin:6px 0">
      <span style="font-size:13px;color:var(--text-primary);min-width:190px">${esc(c.name)}</span>
      <div style="flex:1;height:6px;border-radius:0;background:var(--border)"><div style="width:${pct}%;height:100%;border-radius:0;background:${barColor}"></div></div>
      <span class="mono" style="font-size:12px;font-weight:600;color:${barColor};min-width:50px;text-align:right">${c.score}/${c.max}</span>
    </div>`;
  }).join("");

  const { hygieneScore, maxHygieneScore } = result;
  const hygieneBlock = maxHygieneScore > 0
    ? `<div style="text-align:center;min-width:120px;padding-left:24px;border-left:1px solid var(--border-subtle)">
        <div class="mono" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:4px">Hygiene Score</div>
        <div class="mono" style="font-size:40px;font-weight:700;color:var(--text-secondary);line-height:1">${hygieneScore}</div>
        <div class="mono" style="font-size:13px;color:var(--text-tertiary)">/ ${maxHygieneScore}</div>
        <div style="margin-top:6px;font-size:11px;color:var(--text-tertiary);max-width:140px;line-height:1.4">Generic quality checks — not part of drift.</div>
      </div>`
    : "";

  // One-line gloss under each scalar so first-time readers know what
  // the numbers actually measure. Kept small and tertiary-tone so it
  // reads as metadata, not a heading.
  const driftGloss = `<div style="margin-top:8px;font-size:11px;color:var(--text-tertiary);max-width:200px;line-height:1.4">How consistent your code is with its own dominant patterns.</div>`;

  return `<section class="section">
  <div class="label">SCORE OVERVIEW</div>
  <div class="score-layout" style="display:flex;gap:40px;align-items:flex-start;flex-wrap:wrap">
    <div style="text-align:center;min-width:120px">
      <div class="mono" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:4px">Vibe Drift Score</div>
      <div class="mono" style="font-size:72px;font-weight:800;color:${color};line-height:1">${compositeScore}</div>
      <div class="mono" style="font-size:16px;color:var(--text-tertiary)">/ ${maxCompositeScore}</div>
      <div style="margin-top:8px"><span style="display:inline-block;padding:4px 14px;border-radius:0;font-size:14px;font-weight:600;background:${color}18;color:${color}">Grade ${letter}</span></div>
      ${driftGloss}
    </div>
    ${hygieneBlock}
    <div style="flex:1;min-width:300px">${bars}</div>
  </div>
</section>`;
}

function buildRadarSection(result: ScanResult): string {
  const cats = getDriftCats(result);
  const n = cats.length;
  if (n === 0) return "";

  // Wider viewBox (520x440) so labels on left/right/bottom aren't clipped.
  // Center shifted right to 260 and down to 200 to balance label room.
  const cx = 260, cy = 200, r = 130, step = (2 * Math.PI) / n;
  let grid = "", dots = "", labels = "";
  const pts: string[] = [];

  // Concentric rings with percentage labels
  for (const ring of [0.25, 0.5, 0.75, 1.0]) {
    grid += `<circle cx="${cx}" cy="${cy}" r="${r * ring}" fill="none" stroke="#1E2A3A" stroke-width="${ring === 1 ? "1" : "0.5"}" stroke-dasharray="${ring < 1 ? "3,3" : "none"}"/>`;
    if (ring < 1) {
      grid += `<text x="${cx + 4}" y="${cy - r * ring + 4}" fill="#3A4555" font-size="9" font-family="-apple-system,sans-serif">${Math.round(ring * 100)}%</text>`;
    }
  }

  // Axis lines and data points
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * step;
    const ex = cx + r * Math.cos(a), ey = cy + r * Math.sin(a);
    grid += `<line x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}" stroke="#1E2A3A" stroke-width="0.5"/>`;

    const ratio = cats[i].max > 0 ? cats[i].score / cats[i].max : 0;
    const px = cx + r * ratio * Math.cos(a), py = cy + r * ratio * Math.sin(a);
    pts.push(`${px},${py}`);
    dots += `<circle cx="${px}" cy="${py}" r="5" fill="var(--text-secondary)" stroke="var(--bg-page)" stroke-width="2"/>`;

    // Labels: full name + score
    const labelDist = r + 35;
    const lx = cx + labelDist * Math.cos(a), ly = cy + labelDist * Math.sin(a);
    const anchor = Math.abs(Math.cos(a)) < 0.3 ? "middle" : Math.cos(a) > 0 ? "start" : "end";
    const { color: catColor } = gradeFor(cats[i].score, cats[i].max);
    labels += `<text x="${lx}" y="${ly - 7}" fill="${catColor}" font-size="12" font-weight="600" font-family="-apple-system,sans-serif" text-anchor="${anchor}" dominant-baseline="middle">${esc(cats[i].shortName)}</text>`;
    labels += `<text x="${lx}" y="${ly + 8}" fill="#5A6A7E" font-size="11" font-weight="500" font-family="'SF Mono',Consolas,monospace" text-anchor="${anchor}" dominant-baseline="middle">${cats[i].score}/${cats[i].max} ${cats[i].findings > 0 ? "(" + cats[i].findings + " drift items)" : ""}</text>`;
  }

  const radar = `<svg viewBox="0 0 520 440" style="width:100%;max-width:560px;height:auto;margin:0 auto;display:block">${grid}<polygon points="${pts.join(" ")}" fill="rgba(255,208,0,0.04)" stroke="rgba(255,208,0,0.3)" stroke-width="1.5"/>${dots}${labels}</svg>`;

  // Find the weakest category for the description
  const weakest = [...cats].sort((a, b) => {
    const pctA = a.max > 0 ? a.score / a.max : 1;
    const pctB = b.max > 0 ? b.score / b.max : 1;
    return pctA - pctB;
  })[0];
  const weakPct = weakest.max > 0 ? Math.round((weakest.score / weakest.max) * 100) : 100;

  const strongest = [...cats].sort((a, b) => {
    const pctA = a.max > 0 ? a.score / a.max : 0;
    const pctB = b.max > 0 ? b.score / b.max : 0;
    return pctB - pctA;
  })[0];
  const strongPct = strongest.max > 0 ? Math.round((strongest.score / strongest.max) * 100) : 0;

  return `<section class="section">
  <div class="label">DRIFT FINGERPRINT</div>
  <p style="font-size:13px;color:var(--text-secondary);margin-bottom:20px;line-height:1.6">
    This radar shows how well your codebase maintains consistency across 8 drift categories.
    The outer edge represents a perfect score in each category. Points closer to the center indicate more drift.
    A balanced shape means consistent quality; an uneven shape reveals where drift concentrates.
  </p>
  ${radar}
  <div style="display:flex;gap:20px;justify-content:center;margin-top:20px;flex-wrap:wrap">
    <div style="background:var(--bg-surface);border-radius:0;padding:12px 18px;text-align:center;min-width:160px">
      <div style="font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Strongest</div>
      <div style="font-size:15px;font-weight:600;color:var(--intent-green)">${esc(strongest.shortName)}</div>
      <div class="mono" style="font-size:12px;color:var(--text-secondary)">${strongPct}% health</div>
    </div>
    <div style="background:var(--bg-surface);border-radius:0;padding:12px 18px;text-align:center;min-width:160px">
      <div style="font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Needs Attention</div>
      <div style="font-size:15px;font-weight:600;color:var(--drift-orange)">${esc(weakest.shortName)}</div>
      <div class="mono" style="font-size:12px;color:var(--text-secondary)">${weakPct}% health${weakest.findings > 0 ? " &middot; " + weakest.findings + " drift items" : ""}</div>
    </div>
  </div>
</section>`;
}

function buildFixFirst(result: ScanResult): string {
  // Category importance: architectural issues always outrank convention issues
  // regardless of how many files are affected. Renaming files is cosmetic
  // compared to fixing raw SQL vs repository pattern inconsistencies.
  const catWeight: Record<string, number> = {
    architectural_consistency: 10,
    security_posture: 8,
    semantic_duplication: 6,
    phantom_scaffolding: 3,
    naming_conventions: 1,
  };

  const ranked = [...(result.driftFindings ?? [])].sort((a, b) => {
    const sev = { error: 3, warning: 2, info: 1 };
    const wA = (catWeight[a.driftCategory] ?? 1) * (sev[a.severity as keyof typeof sev] ?? 0);
    const wB = (catWeight[b.driftCategory] ?? 1) * (sev[b.severity as keyof typeof sev] ?? 0);
    if (wB !== wA) return wB - wA;
    // Tiebreak by file count
    return b.deviatingFiles.length - a.deviatingFiles.length;
  }).slice(0, 3);

  if (ranked.length === 0) return "";

  const cards = ranked.map((d, i) => {
    const severity = d.severity === "error" ? "CRITICAL" : d.severity === "warning" ? "HIGH" : "MEDIUM";
    const sColor = sevColor(d.severity);
    const files = d.deviatingFiles.map((f) => f.path).slice(0, 3);

    // Make recommendations specific with file names and code references
    let recText = d.recommendation ?? "";
    let exampleRef = "";
    if (d.deviatingFiles.length > 0) {
      const firstDev = d.deviatingFiles[0];
      const firstEvidence = firstDev.evidence?.[0];
      // Find files that follow the dominant pattern (for "see example in..." reference)
      const allFiles = [...(result.perFileScores?.keys() ?? [])];
      const deviatingPaths = new Set(d.deviatingFiles.map((f) => f.path));
      const dominantFiles = allFiles.filter((f) => !deviatingPaths.has(f));

      if (recText.includes("Migrate deviating files") || recText.includes("Standardize deviating")) {
        const fileNames = d.deviatingFiles.slice(0, 3).map((f) => f.path.split("/").pop()).join(", ");
        recText = `In ${fileNames}${d.deviatingFiles.length > 3 ? ` (+${d.deviatingFiles.length - 3} more)` : ""}: replace ${firstDev.detectedPattern} with the dominant ${d.dominantPattern} pattern (used by ${d.dominantCount}/${d.totalRelevantFiles} files).`;
        if (firstEvidence) {
          recText += ` See ${firstDev.path.split("/").pop()}:${firstEvidence.line}.`;
        }
      }
      // Add example reference file that follows the dominant pattern
      if (dominantFiles.length > 0) {
        const example = dominantFiles.find((f) => f.includes("handler") || f.includes("service")) ?? dominantFiles[0];
        exampleRef = `Follow the pattern in ${example.split("/").pop()}`;
      }
    }

    return `<div style="background:var(--bg-surface);border-radius:0;padding:20px 24px;margin-bottom:12px;border-left:3px solid ${sColor}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <span class="mono" style="font-size:28px;font-weight:800;color:var(--text-tertiary)">${i + 1}</span>
        <span class="sev-badge" style="background:${sColor}">${severity}</span>
      </div>
      <p style="font-size:15px;font-weight:500;color:var(--text-primary);line-height:1.6;margin:0 0 8px">${esc(recText)}</p>
      <p style="font-size:13px;color:var(--text-secondary);margin:0 0 8px">Impact: Resolves ${d.deviatingFiles.length} deviating file${d.deviatingFiles.length > 1 ? "s" : ""} in ${d.driftCategory.replace(/_/g, " ")}.${exampleRef ? " " + esc(exampleRef) + "." : ""}</p>
      <div class="mono" style="font-size:12px;color:var(--text-secondary)">${files.map((f) => esc(f)).join(" &middot; ")}</div>
    </div>`;
  }).join("");

  return `<section class="section">
  <div class="label">FIX FIRST</div>
  ${cards}
</section>`;
}

function buildDeviatingBlocks(d: DriftFindingReport): string {
  const isConvention = d.driftCategory === "naming_conventions";
  const devByPattern = new Map<string, typeof d.deviatingFiles>();
  for (const df of d.deviatingFiles) {
    const key = df.detectedPattern;
    if (!devByPattern.has(key)) devByPattern.set(key, []);
    devByPattern.get(key)!.push(df);
  }

  const expectedNote = `<span style="font-size:11px;color:var(--text-tertiary);font-weight:400">expected: ${esc(d.dominantPattern)}</span>`;

  if (isConvention && d.deviatingFiles.length > 4) {
    return [...devByPattern.entries()].map(([pattern, files]) => {
      const fileList = files.map((df) => `<div style="padding:2px 0;font-size:12px;color:var(--text-secondary)" class="mono">${esc(df.path)}</div>`).join("");
      return `<div style="background:var(--tint-orange);border-left:3px solid var(--drift-orange);border-radius:0;margin:8px 0">
        <details>
          <summary style="cursor:pointer;padding:12px 16px;list-style:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="chevron">&#9654;</span>
            <span class="label" style="color:var(--drift-orange);margin:0">DRIFT &mdash; ${esc(pattern)}</span>
            ${expectedNote}
            <span style="font-size:12px;color:var(--text-tertiary);margin-left:auto">${files.length} files</span>
          </summary>
          <div style="padding:4px 16px 12px">${fileList}</div>
        </details>
      </div>`;
    }).join("");
  }

  return d.deviatingFiles.slice(0, 6).map((df) => {
    const evidence = df.evidence.slice(0, 3).map((e) =>
      `<div style="background:var(--bg-code);padding:6px 12px;border-radius:0;margin:4px 0;overflow-x:auto" class="mono"><span style="color:var(--text-tertiary);margin-right:12px;user-select:none">${e.line}</span>${esc(e.code.slice(0, 120))}</div>`
    ).join("");
    return `<div style="background:var(--tint-orange);border-left:3px solid var(--drift-orange);border-radius:0;margin:8px 0">
      <details>
        <summary style="cursor:pointer;padding:10px 16px;list-style:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span class="chevron">&#9654;</span>
          <span class="label" style="color:var(--drift-orange);margin:0">DRIFT &mdash; ${esc(df.detectedPattern)}</span>
          <span class="mono" style="font-size:12px;color:var(--text-secondary);margin-left:8px">${esc(df.path)}</span>
          <span style="font-size:11px;color:var(--text-tertiary);margin-left:auto">expected: <span style="color:var(--intent-green)">${esc(d.dominantPattern)}</span></span>
        </summary>
        <div style="padding:4px 16px 12px">${evidence}</div>
      </details>
    </div>`;
  }).join("");
}

function buildDriftRecommendation(d: DriftFindingReport): string {
  let recText = d.recommendation ?? "";
  if (recText && d.deviatingFiles.length > 0) {
    const firstDev = d.deviatingFiles[0];
    const firstEvidence = firstDev.evidence?.[0];
    if (recText.includes("Migrate deviating files") || recText.includes("Standardize deviating")) {
      const fileList = d.deviatingFiles.slice(0, 3).map((f) => f.path.split("/").pop()).join(", ");
      recText = `In ${fileList}${d.deviatingFiles.length > 3 ? ` (+${d.deviatingFiles.length - 3} more)` : ""}: replace ${firstDev.detectedPattern} with the dominant ${d.dominantPattern} pattern (used by ${d.dominantCount}/${d.totalRelevantFiles} files).`;
      if (firstEvidence) {
        recText += ` Example: ${firstDev.path.split("/").pop()}:${firstEvidence.line} currently uses ${firstDev.detectedPattern}.`;
      }
    }
  }
  return recText;
}

function buildDistributionBar(d: DriftFindingReport): string {
  const domPct = d.totalRelevantFiles > 0 ? Math.round((d.dominantCount / d.totalRelevantFiles) * 100) : 0;
  const devPct = 100 - domPct;
  return `<div style="margin:12px 0">
    <div style="display:flex;height:6px;border-radius:0;overflow:hidden;gap:2px">
      <div style="width:${domPct}%;background:var(--intent-green);border-radius:0"></div>
      <div style="width:${devPct}%;background:var(--drift-orange);border-radius:0"></div>
    </div>
    <div style="display:flex;gap:16px;margin-top:4px;font-size:11px;color:var(--text-tertiary)">
      <span>${esc(d.dominantPattern)} (${d.dominantCount})</span>
      <span>Deviating (${d.totalRelevantFiles - d.dominantCount})</span>
      <span style="margin-left:auto">${d.consistencyScore}% consistent</span>
    </div>
  </div>`;
}

function buildDriftFindings(result: ScanResult): string {
  const driftCats = ["architectural_consistency", "security_posture", "semantic_duplication", "naming_conventions", "phantom_scaffolding", "import_style", "export_style", "async_patterns"];
  const catLabels: Record<string, string> = {
    architectural_consistency: "Architectural contradictions",
    security_posture: "Security posture gaps",
    semantic_duplication: "Semantic duplication",
    naming_conventions: "Convention drift",
    phantom_scaffolding: "Phantom scaffolding",
    import_style: "Import style drift",
    export_style: "Export style drift",
    async_patterns: "Async pattern drift",
  };

  const groups = driftCats.map((cat) => ({
    cat,
    label: catLabels[cat] ?? cat,
    findings: (result.driftFindings ?? []).filter((f) => f.driftCategory === cat),
  })).filter((g) => g.findings.length > 0);

  if (groups.length === 0) return "";

  const totalFindings = groups.reduce((s, g) => s + g.findings.length, 0);

  const sections = groups.map((g, gi) => {
    const cards = g.findings.map((d) => {
      const domPctVal = d.totalRelevantFiles > 0 ? Math.round((d.dominantCount / d.totalRelevantFiles) * 100) : 0;
      const closeSplitNote = domPctVal < 70 && domPctVal >= 50
        ? ` <span style="font-size:11px;font-weight:400;color:var(--drift-amber)">(close split at ${domPctVal}%)</span>`
        : "";
      const domBlock = `<div style="background:var(--tint-green);border-left:3px solid var(--intent-green);border-radius:0;padding:12px 16px;margin:8px 0">
        <div class="label" style="color:var(--intent-green);margin-bottom:6px">INTENT (DOMINANT) &mdash; ${esc(d.dominantPattern)} &mdash; ${d.dominantCount} files${closeSplitNote}</div>
      </div>`;

      const devBlocks = buildDeviatingBlocks(d);
      const distBar = buildDistributionBar(d);
      const recText = buildDriftRecommendation(d);

      const closeSplitQualifier = domPctVal < 70 && domPctVal >= 50
        ? `<div style="margin-top:8px;padding:8px 14px;background:var(--tint-amber);border-left:3px solid var(--drift-amber);border-radius:0;font-size:13px;line-height:1.6;color:var(--text-secondary)">
          <strong>${esc(d.dominantPattern)}</strong> is dominant at ${domPctVal}%, but the split is close.
          If your team prefers <strong>${esc(d.deviatingFiles[0]?.detectedPattern ?? "the alternative")}</strong>, adopt that instead.
          The important thing is consistency, not which pattern wins.
        </div>`
        : "";

      const rec = recText ? `<div style="margin-top:12px;padding:10px 16px;background:var(--tint-cyan);border-left:3px solid var(--border);border-radius:0;font-size:14px;line-height:1.6;color:var(--text-primary)">
        <span style="color:var(--text-secondary);font-weight:700;margin-right:4px">&rarr;</span> ${esc(recText)}
      </div>` : "";

      return `<details style="background:var(--bg-surface);border-radius:0;margin-bottom:10px;border:1px solid var(--border)">
        <summary style="cursor:pointer;padding:16px 20px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;list-style:none">
          <span class="chevron">&#9654;</span>
          <span class="sev-badge" style="background:${sevColor(d.severity)}">${sevLabel(d.severity)}</span>
          <span style="font-size:14px;font-weight:500;color:var(--text-primary);flex:1">${esc(d.finding)}</span>
          <span class="mono" style="font-size:12px;color:var(--text-tertiary)">${d.dominantCount}/${d.totalRelevantFiles}</span>
        </summary>
        <div style="padding:4px 20px 20px">
          ${domBlock}
          ${devBlocks}
          ${distBar}
          ${rec}
          ${closeSplitQualifier}
        </div>
      </details>`;
    }).join("");

    return `<details ${gi === 0 ? "open" : ""} style="margin-bottom:8px" id="evidence-${esc(g.cat)}">
      <summary style="cursor:pointer;padding:12px 18px;background:var(--bg-surface);border-radius:0;display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;color:var(--text-primary);list-style:none;border:1px solid var(--border)">
        <span class="chevron">&#9654;</span>
        ${esc(g.label)}
        <span style="margin-left:auto;font-size:12px;color:var(--text-tertiary)">${g.findings.length} finding${g.findings.length > 1 ? "s" : ""}</span>
      </summary>
      <div style="padding:8px 0">${cards}</div>
    </details>`;
  }).join("");

  return `<section class="section">
  <div class="label">DRIFT FINDINGS <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--text-tertiary);margin-left:8px">${totalFindings} cross-file contradictions</span></div>
  ${sections}
</section>`;
}

function buildSecurityMatrix(result: ScanResult): string {
  const secFindings = (result.driftFindings ?? []).filter((d) => d.driftCategory === "security_posture");
  if (secFindings.length === 0) return "";

  const rows = secFindings.flatMap((f) =>
    f.deviatingFiles.map((df) => `<tr style="background:var(--tint-red)">
      <td class="mono" style="padding:8px 12px;border-bottom:1px solid var(--border-subtle);font-size:12px;color:var(--text-primary)">${esc(df.evidence[0]?.code ?? df.path)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid var(--border-subtle);text-align:center;color:var(--drift-red);font-weight:700">&#10007;</td>
      <td class="mono" style="padding:8px 12px;border-bottom:1px solid var(--border-subtle);font-size:12px;color:var(--text-tertiary)">${esc(df.path)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid var(--border-subtle);font-size:11px;color:var(--drift-red)">DRIFT</td>
    </tr>`)
  );

  if (rows.length === 0) return "";

  return `<section class="section">
  <div class="label">SECURITY MATRIX</div>
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Route / Endpoint</th>
        <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Status</th>
        <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">File</th>
        <th style="padding:8px 12px;font-size:11px;color:var(--text-tertiary);font-weight:600"></th>
      </tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  </div>
</section>`;
}

function buildFileRanking(result: ScanResult): string {
  const entries = [...result.perFileScores.entries()];
  const withFindings = entries.filter(([, v]) => v.findings.length > 0).sort((a, b) => a[1].score - b[1].score);
  const clean = entries.filter(([, v]) => v.findings.length === 0);

  if (entries.length === 0) return "";

  const fileCards = withFindings.slice(0, 25).map(([file, data], i) => {
    const color = scoreColor(data.score);
    const { letter } = gradeFor(data.score, 100);
    const driftFindings = data.findings.filter((f) => f.tags?.includes("drift") || f.tags?.includes("codedna"));
    const staticFindings = data.findings.filter((f) => !f.tags?.includes("drift") && !f.tags?.includes("codedna"));

    // Deduplicate findings using semantic key — same issue from different analyzers should collapse
    const seenKeys = new Set<string>();
    function findingKey(f: Finding): string {
      // For duplicate-type findings, normalize by sorted file paths
      if (["duplicates", "codedna-fingerprint", "codedna-opseq", "ml-duplicate"].includes(f.analyzerId)) {
        const files = f.locations.map((l) => l.file).filter(Boolean).sort().join("::");
        return `dup::${files || f.message}`;
      }
      // For all others, use analyzer + message as key
      return `${f.analyzerId}::${f.message}`;
    }
    const dedupedDrift = driftFindings.filter((f) => { const k = findingKey(f); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });
    const dedupedStatic = staticFindings.filter((f) => { const k = findingKey(f); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });

    const findingList = [...dedupedDrift.slice(0, 4), ...dedupedStatic.slice(0, 4)].map((f) => {
      const isDrift = f.tags?.includes("drift") || f.tags?.includes("codedna");
      return `<div style="padding:3px 0;font-size:12px;color:var(--text-secondary);display:flex;align-items:baseline;gap:6px">
        <span style="color:${isDrift ? "var(--drift-orange)" : "var(--text-tertiary)"};font-size:10px;font-weight:600;min-width:42px">${isDrift ? "&#9670; DRIFT" : "&#9679; STATIC"}</span>
        <span>${esc(f.message.slice(0, 90))}${f.message.length > 90 ? "..." : ""}</span>
      </div>`;
    }).join("");

    return `<details ${i === 0 ? "open" : ""} style="margin-bottom:4px" id="rank-${esc(file.replace(/[^a-zA-Z0-9]/g, "-"))}">
      <summary style="cursor:pointer;padding:10px 16px;background:var(--bg-surface);border-radius:0;display:flex;align-items:center;gap:10px;font-size:13px;border:1px solid var(--border);list-style:none">
        <div style="width:4px;height:22px;border-radius:2px;background:${color}"></div>
        <span class="mono" style="color:var(--text-secondary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(file)}</span>
        <span class="mono" style="font-weight:600;color:${color}">${data.score}/100</span>
        <span style="font-size:12px;font-weight:600;color:${color}">${letter}</span>
        <span style="font-size:11px;color:var(--text-tertiary)">${driftFindings.length} drift &middot; ${staticFindings.length} static</span>
      </summary>
      <div style="padding:6px 16px 10px 32px">${findingList}</div>
    </details>`;
  }).join("");

  const cleanSection = clean.length > 0 ? `<details style="margin-top:8px">
    <summary style="cursor:pointer;padding:8px 16px;font-size:12px;color:var(--text-tertiary);list-style:none">&#9472;&#9472; ${clean.length} files with no findings &#9472;&#9472;</summary>
    <div style="padding:4px 16px;font-size:12px;color:var(--text-tertiary)" class="mono">${clean.slice(0, 20).map(([f]) => `<div style="padding:1px 0">${esc(f)} <span style="color:var(--intent-green)">100/100 A &#10003;</span></div>`).join("")}${clean.length > 20 ? `<div style="color:var(--text-tertiary)">&middot;&middot;&middot; ${clean.length - 20} more</div>` : ""}</div>
  </details>` : "";

  return `<section class="section">
  <div class="label">FILE RANKING <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--text-tertiary);margin-left:8px">${entries.length} files scanned</span></div>
  ${fileCards}
  ${cleanSection}
</section>`;
}

function buildMlInsights(result: ScanResult): string {
  const mlFindings = result.findings.filter((f) => f.tags?.includes("ml"));
  if (mlFindings.length === 0) return "";

  const byType: Record<string, typeof mlFindings> = {};
  for (const f of mlFindings) {
    const type = f.analyzerId === "ml-duplicate" ? "Semantic Duplicates"
      : f.analyzerId === "ml-intent" ? "Intent Mismatches"
      : f.analyzerId === "ml-anomaly" ? "Pattern Anomalies" : "Other";
    if (!byType[type]) byType[type] = [];
    byType[type].push(f);
  }

  const sections = Object.entries(byType).map(([type, findings]) => {
    const icon = type === "Semantic Duplicates" ? "&#128257;" : type === "Intent Mismatches" ? "&#127919;" : "&#128270;";
    const typeColor = type === "Semantic Duplicates" ? "var(--drift-red)" : type === "Intent Mismatches" ? "var(--drift-orange)" : "var(--info-blue)";

    const cards = findings.map((f) => {
      const sColor = sevColor(f.severity);
      const files = f.locations.map((l) => l.file).filter(Boolean);
      // Add actionable recommendations for anomalies
      let recommendation = "";
      if (f.analyzerId === "ml-anomaly" && files.length > 0) {
        const funcName = f.message.match(/Pattern outlier: (.+?) doesn/)?.[1]?.split("::").pop() ?? "";
        const fileName = files[0]?.split("/").pop() ?? "";
        if (funcName && fileName) {
          recommendation = `<div style="margin-top:6px;padding:6px 12px;background:var(--tint-cyan);border-left:2px solid var(--border);border-radius:0 4px 4px 0;font-size:12px;color:var(--text-secondary)"><span style="color:var(--text-secondary);font-weight:700;margin-right:4px">&rarr;</span> Consider extracting ${esc(funcName)} from ${esc(fileName)} into a shared utils package, or verify it belongs in this module.</div>`;
        }
      }
      return `<div style="background:var(--bg-surface);border-radius:0;padding:14px 18px;margin-bottom:8px;border-left:3px solid ${sColor}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="sev-badge" style="background:${sColor}">${sevLabel(f.severity)}</span>
          <span style="font-size:14px;font-weight:500;color:var(--text-primary);flex:1">${esc(f.message)}</span>
          <span class="mono" style="font-size:11px;color:var(--text-tertiary)">${Math.round(f.confidence * 100)}%</span>
        </div>
        ${files.length > 0 ? `<div class="mono" style="font-size:12px;color:var(--text-secondary);margin-top:4px">${files.map((fp) => esc(fp)).join(" &middot; ")}</div>` : ""}
        ${recommendation}
      </div>`;
    }).join("");

    return `<details open style="margin-bottom:10px">
      <summary style="cursor:pointer;padding:10px 16px;background:var(--bg-surface);border-radius:0;display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--text-primary);list-style:none;border:1px solid var(--border)">
        <span class="chevron">&#9654;</span>
        <span>${icon}</span>
        <span style="color:${typeColor}">${esc(type)}</span>
        <span style="margin-left:auto;font-size:12px;color:var(--text-tertiary)">${findings.length} finding${findings.length > 1 ? "s" : ""}</span>
      </summary>
      <div style="padding:8px 0">${cards}</div>
    </details>`;
  }).join("");

  return `<section class="section">
  <div class="label">AI ANALYSIS <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--info-blue);margin-left:8px">Deep Layer &middot; Code Embeddings &middot; ${mlFindings.length} findings</span></div>
  <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;line-height:1.6">
    These findings were detected by VibeDrift&rsquo;s AI inference API. Only function snippets (not full files) were sent for analysis &mdash; snippets are processed in memory and not stored.
    Functions were embedded as 768-dimensional vectors and compared for semantic similarity, name-body alignment, and clustering anomalies.
  </p>
  ${sections}
</section>`;
}

function buildStaticFindings(result: ScanResult): string {
  // Hygiene findings = analyzers not grounded in a dominance baseline
  // (complexity, dead-code, TODOs, generic security regex, outdated deps,
  // empty catches, language idioms). These do NOT feed the Vibe Drift
  // Score and render in a clearly-labeled separate pane so users still
  // see them without confusing them with drift signal. Uses the
  // canonical kind lookup rather than a tag heuristic — a drift analyzer
  // that forgets to set the "drift" tag would otherwise leak here.
  const hygieneFindings = result.findings.filter((f) => getAnalyzerKind(f.analyzerId) === "hygiene");
  if (hygieneFindings.length === 0) return "";

  const sorted = [...hygieneFindings].sort((a, b) => {
    const sev = { error: 0, warning: 1, info: 2 };
    return (sev[a.severity as keyof typeof sev] ?? 2) - (sev[b.severity as keyof typeof sev] ?? 2);
  });

  function findingRow(f: typeof sorted[0]): string {
    const sColor = f.severity === "error" ? "var(--drift-orange)" : f.severity === "warning" ? "var(--drift-amber)" : "var(--info-blue)";
    const loc = f.locations[0];
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle)"><span class="sev-badge" style="background:${sColor};font-size:10px">${f.severity === "error" ? "ERROR" : f.severity === "warning" ? "WARN" : "INFO"}</span></td>
      <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle);font-size:12px;color:var(--text-tertiary)">${esc(f.analyzerId)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle);font-size:13px;color:var(--text-primary)">${esc(f.message.slice(0, 80))}${f.message.length > 80 ? "..." : ""}</td>
      <td class="mono" style="padding:6px 10px;border-bottom:1px solid var(--border-subtle);font-size:11px;color:var(--text-secondary);white-space:nowrap">${loc ? esc(shortPath(loc.file)) + (loc.line ? ":" + loc.line : "") : ""}</td>
      <td class="mono" style="padding:6px 10px;border-bottom:1px solid var(--border-subtle);font-size:11px;color:var(--text-tertiary)">${Math.round(f.confidence * 100)}%</td>
    </tr>`;
  }

  const visibleRows = sorted.slice(0, 30).map(findingRow).join("");
  const hiddenRows = sorted.length > 30 ? sorted.slice(30).map(findingRow).join("") : "";

  const overflowSection = hiddenRows
    ? `<details style="margin-top:4px">
        <summary style="cursor:pointer;padding:8px 10px;font-size:12px;color:var(--text-tertiary);list-style:none;display:flex;align-items:center;gap:6px">
          <span class="chevron">&#9654;</span> ${sorted.length - 30} more findings
        </summary>
        <table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>${hiddenRows}</tbody></table>
      </details>`
    : "";

  const hygieneScorePill = result.maxHygieneScore > 0
    ? `<span class="mono" style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-left:8px;padding:2px 8px;border:1px solid var(--border);border-radius:0">Hygiene ${result.hygieneScore}/${result.maxHygieneScore}</span>`
    : "";

  return `<details class="section" id="evidence-static" style="padding:0">
  <summary style="cursor:pointer;padding:20px 28px;list-style:none;display:flex;align-items:center;gap:8px">
    <span class="chevron" style="font-size:11px">&#9654;</span>
    <span class="label" style="margin:0">HYGIENE FINDINGS <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--text-tertiary);margin-left:8px">not part of Vibe Drift Score &middot; ${hygieneFindings.length} findings</span></span>
    ${hygieneScorePill}
  </summary>
  <div style="padding:0 28px 24px">
    <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 14px;line-height:1.6">
      Generic hygiene checks &mdash; complexity, dead code, TODOs, generic security regex, outdated dependencies, empty catches, language idioms. These are useful but have no dominance baseline, so they do NOT feed the Vibe Drift Score. They&rsquo;re scored separately above.
    </p>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:6px 10px;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600" data-sort>Sev</th>
          <th style="text-align:left;padding:6px 10px;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600" data-sort>Analyzer</th>
          <th style="text-align:left;padding:6px 10px;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Finding</th>
          <th style="text-align:left;padding:6px 10px;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">File</th>
          <th style="text-align:right;padding:6px 10px;font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Conf</th>
        </tr></thead>
        <tbody>${visibleRows}</tbody>
      </table>
    </div>
    ${overflowSection}
  </div>
</details>`;
}

function buildDeepInsights(result: ScanResult): string {
  const insights = result.deepInsights ?? [];
  if (insights.length === 0) return "";

  const cards = insights.map((ins) => {
    const sColor = sevColor(ins.severity);
    return `<div style="background:var(--bg-surface);border-left:3px solid var(--info-blue);border-radius:0;padding:16px 20px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span class="sev-badge" style="background:${sColor}">${sevLabel(ins.severity)}</span>
        <span style="font-size:14px;font-weight:500;color:var(--text-primary)">${esc(ins.title)}</span>
      </div>
      <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin:0">${esc(ins.description)}</p>
      ${ins.relatedFiles.length > 0 ? `<div class="mono" style="font-size:11px;color:var(--text-tertiary);margin-top:6px">${ins.relatedFiles.slice(0, 4).map((f) => esc(f)).join(" &middot; ")}</div>` : ""}
      ${ins.recommendation ? `<div style="margin-top:8px;padding:8px 14px;background:var(--tint-cyan);border-left:3px solid var(--border);border-radius:0;font-size:13px;color:var(--text-primary)"><span style="color:var(--text-secondary);font-weight:700;margin-right:4px">&rarr;</span> ${esc(ins.recommendation)}</div>` : ""}
    </div>`;
  }).join("");

  return `<section class="section">
  <div class="label">DEEP ANALYSIS INSIGHTS <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--info-blue);margin-left:8px">AI-powered &middot; ${insights.length} insights</span></div>
  ${cards}
</section>`;
}

/**
 * Locked "AI Analysis" teaser — shown when no deep scan was run
 * but tease data indicates findings the deep scan would catch.
 * Blurred placeholder cards drive conversion to deep scan / signup.
 */
function buildLockedDeepSection(result: ScanResult): string {
  // Only show if no deep insights exist (free scan) and there are tease messages
  if ((result.deepInsights ?? []).length > 0) return "";
  const tease = result.teaseMessages ?? [];
  if (tease.length === 0) return "";

  const lockedCards = tease.map((msg) => {
    return `<div style="background:var(--bg-surface);border-left:3px solid var(--text-tertiary);border-radius:0;padding:16px 20px;margin-bottom:8px;position:relative;overflow:hidden">
      <div style="filter:blur(4px);pointer-events:none;user-select:none">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="sev-badge" style="background:var(--text-tertiary)">AI</span>
          <span style="font-size:14px;font-weight:500;color:var(--text-primary)">AI-detected finding</span>
        </div>
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin:0">${esc(msg.slice(0, 60))}...</p>
      </div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(18,18,20,0.6)">
        <span style="font-size:12px;color:var(--text-tertiary);letter-spacing:1px;text-transform:uppercase">&#128274; Locked</span>
      </div>
    </div>`;
  }).join("");

  return `<section class="section">
  <div class="label">AI ANALYSIS <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--text-tertiary);margin-left:8px">${tease.length} findings detected &middot; locked</span></div>
  <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;line-height:1.6">
    VibeDrift's AI layer detected <strong style="color:var(--text-primary)">${tease.length} additional findings</strong> that static analysis can't catch &mdash;
    semantic duplicates, intent mismatches, and architectural anomalies.
  </p>
  ${lockedCards}
  <div style="margin-top:16px;text-align:center;padding:20px;background:var(--bg-surface);border:1px dashed var(--border)">
    <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:6px">Unlock AI Analysis</div>
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">Run <code style="color:var(--accent-yellow);background:var(--bg-code);padding:2px 6px">vibedrift . --deep</code> to reveal these findings. 3 free deep scans/month.</div>
    <div style="font-size:12px;color:var(--text-tertiary)">Not signed in? Run <code style="color:var(--accent-yellow)">vibedrift login</code> first &mdash; no card required.</div>
  </div>
</section>`;
}

function buildSequenceCards(similarities: any[]): string {
  const seqCards = similarities.slice(0, 6).map((sim: any) => {
    const pct = Math.round(sim.similarity * 100);
    const color = pct >= 90 ? "var(--drift-red)" : "var(--drift-orange)";
    const matchLabel = pct >= 100 ? "Exact duplicate" : pct >= 90 ? "Near-exact match" : "Similar";
    return `<div style="display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid var(--border-subtle)">
      <span class="mono" style="min-width:40px;font-weight:700;color:${color}">${pct}%</span>
      <div style="flex:1">
        <span style="font-size:11px;font-weight:600;color:${color};margin-right:6px">${matchLabel}</span>
        <span class="mono" style="font-size:12px;color:var(--text-secondary)">${esc(sim.functionA.name)}()</span>
        <span style="font-size:11px;color:var(--text-tertiary)"> in ${esc(shortPath(sim.functionA.relativePath || sim.functionA.file))}</span>
        <span style="color:var(--text-tertiary);margin:0 4px">&harr;</span>
        <span class="mono" style="font-size:12px;color:var(--drift-orange)">${esc(sim.functionB.name)}()</span>
        <span style="font-size:11px;color:var(--text-tertiary)"> in ${esc(shortPath(sim.functionB.relativePath || sim.functionB.file))}</span>
      </div>
    </div>`;
  }).join("");
  return `<details style="margin-bottom:8px"><summary style="cursor:pointer;font-size:13px;font-weight:500;color:var(--text-primary);list-style:none;padding:6px 0"><span class="chevron">&#9654;</span> Operation sequence matches <span style="color:var(--text-tertiary);font-weight:400">${similarities.length} pairs</span></summary><div style="padding:4px 0 4px 16px">${seqCards}</div></details>`;
}

function buildDeviationCards(justifications: any[]): string {
  const devCards = justifications.map((dj: any) => {
    const vColor = dj.verdict === "likely_justified" ? "var(--intent-green)" : dj.verdict === "likely_accidental" ? "var(--drift-red)" : "var(--drift-amber)";
    const vLabel = dj.verdict === "likely_justified" ? "JUSTIFIED" : dj.verdict === "likely_accidental" ? "ACCIDENTAL" : "UNCERTAIN";
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border-subtle)">
      <span class="sev-badge" style="background:${vColor};min-width:80px;text-align:center">${vLabel}</span>
      <span class="mono" style="font-size:12px;color:var(--text-secondary);flex:1">${esc(shortPath(dj.relativePath || dj.file))}</span>
      <span style="font-size:12px;color:var(--text-tertiary)">${esc(dj.deviatingPattern)} vs ${esc(dj.dominantPattern)}</span>
    </div>`;
  }).join("");
  return `<details style="margin-bottom:8px"><summary style="cursor:pointer;font-size:13px;font-weight:500;color:var(--text-primary);list-style:none;padding:6px 0"><span class="chevron">&#9654;</span> Deviation analysis <span style="color:var(--text-tertiary);font-weight:400">${justifications.length}</span></summary><div style="padding:4px 0 4px 16px">${devCards}</div></details>`;
}

function buildCodeDnaSummary(result: ScanResult): string {
  const dna = result.codeDnaResult;
  if (!dna) return "";

  const hasDupes = dna.duplicateGroups?.length > 0;
  const hasSeqs = dna.sequenceSimilarities?.length > 0;
  const hasTaint = dna.taintFlows?.length > 0;
  const hasDevs = dna.deviationJustifications?.length > 0;

  if (!hasDupes && !hasSeqs && !hasTaint && !hasDevs) return "";

  const parts: string[] = [];

  if (hasSeqs) {
    parts.push(buildSequenceCards(dna.sequenceSimilarities));
  }

  if (hasDevs) {
    parts.push(buildDeviationCards(dna.deviationJustifications));
  }

  if (parts.length === 0) return "";

  const totalFindings = dna.findings?.length ?? 0;
  const timeMs = dna.timings?.totalMs ?? 0;

  return `<section class="section">
  <div class="label">CODE DNA <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--intent-green);margin-left:8px">Layer 1.7 &middot; ${totalFindings} findings &middot; ${dna.functions?.length ?? 0} functions &middot; ${timeMs}ms</span></div>
  ${parts.join("")}
</section>`;
}

function buildFooter(result: ScanResult): string {
  const hasDeep = result.findings.some((f) => f.tags?.includes("ml")) || !!result.aiSummary;
  const premiumUpsell = !hasDeep ? `<div style="margin-top:16px;padding:14px 18px;background:var(--bg-surface);border-radius:0;border-left:3px solid var(--border);text-align:left;font-size:13px;color:var(--text-secondary);max-width:520px;margin-left:auto;margin-right:auto">
    Want AI-powered deep analysis? Sign in once with <code class="mono" style="color:var(--text-primary);background:var(--bg-code);padding:2px 6px;border-radius:0">vibedrift login</code> then run:<br>
    <code class="mono" style="color:var(--text-primary);background:var(--bg-code);padding:2px 6px;border-radius:0;margin-top:4px;display:inline-block">vibedrift . --deep</code>
    <span data-copy="vibedrift . --deep" style="cursor:pointer;margin-left:6px;font-size:11px;color:var(--text-tertiary)">[copy]</span>
  </div>` : "";

  // Passive update notice — small dim banner at the footer when the
  // scan discovered the user is on an older CLI. Skipped when offline,
  // on --local-only, or when telemetry is disabled (updateCheck is null
  // in all those cases).
  const updateNotice = result.updateCheck?.outdated
    ? `<div style="margin-top:16px;padding:12px 18px;background:var(--bg-surface);border-radius:0;border-left:3px solid var(--intent-amber, #d97706);text-align:left;font-size:12px;color:var(--text-secondary);max-width:520px;margin-left:auto;margin-right:auto">
    <strong style="color:var(--text-primary)">New version available: ${esc(result.updateCheck.latest)}</strong> (you're on ${esc(result.updateCheck.current)}). VibeDrift is early-stage — each release sharpens detectors and ships fixes.<br>
    Update: <code class="mono" style="color:var(--text-primary);background:var(--bg-code);padding:2px 6px;border-radius:0;display:inline-block;margin-top:4px">vibedrift update</code>
    <span data-copy="vibedrift update" style="cursor:pointer;margin-left:6px;font-size:11px;color:var(--text-tertiary)">[copy]</span>
    &middot; <a href="https://vibedrift.ai/releases" style="color:var(--text-tertiary);text-decoration:none">Release notes</a>
  </div>`
    : "";

  return `<footer style="border-top:1px solid var(--border);padding-top:28px;margin-top:48px;text-align:center;color:var(--text-tertiary);font-size:13px">
  <div style="display:flex;gap:8px;justify-content:center;margin-bottom:20px;flex-wrap:wrap">
    <button onclick="exportCSV()" class="export-btn">Export CSV</button>
    <button onclick="exportDOCX()" class="export-btn">Export DOCX</button>
    <button onclick="window.print()" class="export-btn">Export PDF</button>
  </div>
  <p>Generated by <span style="color:var(--text-primary);font-weight:600">VibeDrift v${getVersion()}</span></p>
  <p style="margin:4px 0">${result.context.files.length} files &middot; ${formatCount(result.context.totalLines)} lines &middot; ${(result.scanTimeMs / 1000).toFixed(1)}s</p>
  <p style="margin:4px 0;font-size:12px">${hasDeep
    ? "Function snippets were sent to VibeDrift&rsquo;s AI API for analysis. No full files transmitted. Snippets processed in memory and not stored."
    : "No data sent externally."}</p>
  <p style="margin-top:10px">Re-align the top drifts and re-scan: <code class="mono" style="background:var(--bg-code);padding:2px 6px;border-radius:0;color:var(--text-primary)">vibedrift .</code> <span data-copy="vibedrift ." style="cursor:pointer;font-size:11px;color:var(--text-tertiary)">[copy]</span></p>
  ${premiumUpsell}
  ${updateNotice}
  <div style="margin-top:16px;padding:12px 18px;background:var(--bg-surface);border-radius:0;display:inline-block;text-align:left">
    <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:6px">Add to your README:</div>
    <code class="mono" style="font-size:11px;color:var(--text-secondary)">[![VibeDrift Score](https://img.shields.io/badge/VibeDrift-${encodeURIComponent(result.compositeScore + "/" + result.maxCompositeScore)}-${result.compositeScore >= 75 ? "brightgreen" : result.compositeScore >= 50 ? "yellow" : "red"})](https://vibedrift.ai)</code>
    <span data-copy="[![VibeDrift Score](https://img.shields.io/badge/VibeDrift-${encodeURIComponent(result.compositeScore + "/" + result.maxCompositeScore)}-${result.compositeScore >= 75 ? "brightgreen" : result.compositeScore >= 50 ? "yellow" : "red"})](https://vibedrift.ai)" style="cursor:pointer;margin-left:8px;font-size:11px;color:var(--text-tertiary)">[copy]</span>
  </div>
  <p style="margin-top:16px;font-size:11px;color:var(--border)">vibedrift.ai &middot; Built by the creator of <a href="https://thevibelang.org" style="color:var(--text-tertiary);text-decoration:none">VibeLang</a></p>
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

  return JSON.stringify(data);
}

// Copied to the clipboard when a FREE user clicks a "Copy AI Prompt" button.
// Fix prompts are a paid feature, so the report source never carries the real
// prompt markdown for a free plan — only this upsell.
const FIX_PROMPT_UPSELL =
  "VibeDrift fix prompts are a Pro/Scale feature. Your findings, scores, and dominant patterns are free on every plan; the copy-ready, peer-grounded fix for each one is part of the paid deep scan. Run `vibedrift upgrade` to unlock.";

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

// ──── Main Report ────

function buildGlanceableSummary(result: ScanResult, detailedUrl: string): string {
  const { compositeScore, maxCompositeScore, scores } = result;
  const { letter, color: gradeColor } = gradeFor(compositeScore, maxCompositeScore);
  const pct = maxCompositeScore > 0 ? (compositeScore / maxCompositeScore) * 100 : 0;
  const fileCount = result.context.files.length;
  const totalLines = result.context.totalLines;
  const scanSec = (result.scanTimeMs / 1000).toFixed(1);
  const lang = result.context.dominantLanguage ?? "mixed";

  const catCards = SCORING_CATEGORY_ORDER.map((cat) => {
    const s = (scores as unknown as Record<string, { score: number; maxScore: number; applicable: boolean }>)[cat];
    if (!s || !s.applicable) {
      return `<a class="cat-card" href="${detailedUrl}" target="_blank" rel="noopener">
        <div class="cat-card-label">${esc(SCORING_CATEGORY_LABELS[cat])}</div>
        <div class="cat-card-value" style="color:var(--text-tertiary)">N/A</div>
        <div class="cat-card-bar"><div class="cat-card-bar-fill" style="width:0%"></div></div>
      </a>`;
    }
    const catPct = s.maxScore > 0 ? (s.score / s.maxScore) * 100 : 0;
    const col = scoreColor(catPct);
    return `<a class="cat-card" href="${detailedUrl}" target="_blank" rel="noopener">
      <div class="cat-card-label">${esc(SCORING_CATEGORY_LABELS[cat])}</div>
      <div class="cat-card-value" style="color:${col}">${s.score.toFixed(1)}<span style="font-size:14px;color:var(--text-tertiary);font-weight:400;">/${s.maxScore}</span></div>
      <div class="cat-card-bar"><div class="cat-card-bar-fill" style="width:${catPct.toFixed(0)}%;background:${col}"></div></div>
    </a>`;
  }).join("");

  const top5 = topImpactFindings(result, 5);
  let ctaHint = "";
  if (top5.length > 0) {
    const after = estimateScoreAfterFixes(
      result.findings,
      top5,
      result.context.totalLines,
      result.context,
    );
    const gain = after.compositeScore - compositeScore;
    if (gain > 0.3) {
      const projGrade = gradeFor(after.compositeScore, after.maxCompositeScore).letter;
      ctaHint = `<span class="cta-hint">Fix the top ${top5.length} drifts → projected <strong style="color:var(--intent-green)">${after.compositeScore.toFixed(1)}/${after.maxCompositeScore}</strong> (Grade ${projGrade}, +${gain.toFixed(1)}pts consistency)</span>`;
    }
  }

  return `<section class="section glanceable" id="glanceable-summary">
  <div class="hero">
    <div>
      <span class="hero-score" style="color:${gradeColor}">${compositeScore.toFixed(1)}</span>
      <span class="hero-grade" style="color:${gradeColor}">/${maxCompositeScore} · ${letter}</span>
    </div>
    <div class="hero-right">
      <div class="hero-bar">
        <div class="hero-bar-fill" style="width:${pct.toFixed(1)}%"></div>
        <div class="hero-bar-marker" style="left:${pct.toFixed(1)}%"></div>
      </div>
      <div class="hero-meta">
        <span><strong>${fileCount}</strong> files</span>
        <span><strong>${formatCount(totalLines)}</strong> lines</span>
        <span><strong>${esc(lang)}</strong></span>
        <span>scanned in <strong>${scanSec}s</strong></span>
        <span style="opacity:0.6">· Vibe Drift Score measures how consistent your codebase is with its own dominant patterns</span>
      </div>
    </div>
  </div>

  <div class="cat-grid">${catCards}</div>

  <div class="cta-strip">
    <a class="cta-btn primary" href="#fix-plan" data-scroll-to="fix-plan">View Fix Plan</a>
    <a class="cta-btn" href="${detailedUrl}" target="_blank" rel="noopener">View Detailed Report ↗</a>
    ${ctaHint}
  </div>
</section>`;
}

function buildFixPlanWidget(result: ScanResult): string {
  const top = topImpactFindings(result, 5);
  if (top.length === 0) {
    return `<section class="section fix-plan" id="fix-plan">
      <div class="fix-plan-header"><div class="fix-plan-title">Fix Plan</div></div>
      <p style="color:var(--text-secondary);font-size:13px;">No drift findings with measurable impact. Your codebase is well-aligned — or the detectors didn't find peer baselines strong enough to flag deviations.</p>
    </section>`;
  }

  const after = estimateScoreAfterFixes(
    result.findings,
    top,
    result.context.totalLines,
    result.context,
  );
  const cumulativeGain = after.compositeScore - result.compositeScore;
  const sumIndividual = top.reduce((s, f) => s + (f.consistencyImpact ?? 0), 0);

  const items = top.map((f, i) => {
    const impact = (f.consistencyImpact ?? 0).toFixed(2);
    const cat = categoryFor(f);
    const loc = f.locations[0];
    const fileLine = loc ? `${loc.file}${loc.line ? `:${loc.line}` : ""}` : "(project-wide)";
    const key = findingKey(f);
    const div = f.metadata?.intentDivergence;
    const divergenceBadge = div
      ? `<span class="intent-chip" title="Declared in ${esc(div.source)}:${div.line}">⚠ declared ${esc(div.declaredLabel)}</span>`
      : "";
    const divergenceLine = div
      ? `<div class="fix-item-note">Declared in <code>${esc(div.source)}:${div.line}</code> — code diverges.</div>`
      : "";
    return `<li class="fix-item">
      <input type="checkbox" class="fix-checkbox" id="fix-chk-${i}" />
      <div class="fix-item-body">
        <div class="fix-item-top">
          <span class="impact-chip">+${impact}pts consistency</span>
          <span class="category-chip">${esc(cat)}</span>
          ${divergenceBadge}
          <span style="color:var(--text-tertiary);font-size:11px;">${esc(fileLine)}</span>
        </div>
        <div class="fix-item-msg">${esc(f.message.replace(/^DRIFT:\s*/, ""))}</div>
        ${divergenceLine}
        <div class="fix-item-actions">
          <button class="copy-btn" data-copy-id="${esc(key)}">Copy AI Prompt</button>
        </div>
      </div>
    </li>`;
  }).join("");

  return `<section class="section fix-plan" id="fix-plan">
  <div class="fix-plan-header">
    <div>
      <div class="fix-plan-title">Fix Plan</div>
      <div class="fix-plan-sub">Top ${top.length} drifts by consistency impact — closing these re-aligns your codebase with its dominant patterns.</div>
    </div>
    <button class="cta-btn" data-copy-id="__full_fix_plan__">Copy Full Fix Plan as AI Context</button>
  </div>
  <ul class="fix-list">${items}</ul>
  <div class="fix-plan-summary">
    <div class="fix-plan-estimate">
      If all ${top.length} close: <span class="projected">+${cumulativeGain.toFixed(1)}pts consistency</span>
      &nbsp;(projected <strong>${after.compositeScore.toFixed(1)}/${after.maxCompositeScore}</strong>, Grade ${gradeFor(after.compositeScore, after.maxCompositeScore).letter})
    </div>
    <div style="color:var(--text-tertiary);font-size:11px;">
      Sum of individual: +${sumIndividual.toFixed(1)}pts · cumulative is sub-additive (non-linear decay)
    </div>
  </div>
</section>`;
}

function categoryFor(f: Finding): string {
  // Derive a human-readable category from tags or analyzerId
  const driftTag = f.tags?.find((t) => t !== "drift" && t !== "cross-file" && t !== "codedna" && t !== "ml" && t !== "temporal-pivot" && !t.startsWith("high") && !t.startsWith("critical") && !t.startsWith("moderate"));
  if (driftTag) return driftTag.replace(/_/g, " ");
  return f.analyzerId;
}

/**
 * Legacy migration widget. Renders findings where temporal pivot
 * detection identified the deviators as "on the old pattern, not
 * actually drifting." Softer framing than Fix Plan — this is
 * migrate-when-convenient, not block-the-merge urgency.
 */
function buildLegacyMigrationsWidget(result: ScanResult): string {
  type LegacyItem = {
    sourceFinding: Finding;
    filePath: string;
    fromPattern: string;
    toPattern: string;
  };
  const items: LegacyItem[] = [];
  for (const f of result.findings) {
    const pivot = f.metadata?.pivot;
    const legacyFiles = f.metadata?.legacyFiles ?? [];
    if (!pivot || legacyFiles.length === 0) continue;
    for (const path of legacyFiles) {
      items.push({
        sourceFinding: f,
        filePath: path,
        fromPattern: pivot.fromPattern,
        toPattern: pivot.toPattern,
      });
    }
  }
  if (items.length === 0) return "";

  // Group by (fromPattern → toPattern) so one pivot shows one section
  const byMigration = new Map<string, LegacyItem[]>();
  for (const item of items) {
    const key = `${item.fromPattern} → ${item.toPattern}`;
    const arr = byMigration.get(key) ?? [];
    arr.push(item);
    byMigration.set(key, arr);
  }

  const sections: string[] = [];
  for (const [migration, list] of byMigration) {
    const shown = list.slice(0, 8);
    const rest = list.length - shown.length;
    const rows = shown.map((item) => `<li class="legacy-item">
      <span class="legacy-file mono">${esc(item.filePath)}</span>
      <button class="copy-btn copy-btn-ghost" data-copy-id="${esc(findingKey(item.sourceFinding))}-legacy-${esc(item.filePath)}">Copy migration prompt</button>
    </li>`).join("");
    sections.push(`<div class="legacy-group">
      <div class="legacy-group-header">
        <span class="legacy-migration-label">${esc(migration)}</span>
        <span class="legacy-migration-count">${list.length} file${list.length === 1 ? "" : "s"}</span>
      </div>
      <ul class="legacy-list">${rows}${rest > 0 ? `<li class="legacy-item-more">…and ${rest} more</li>` : ""}</ul>
    </div>`);
  }

  return `<section class="section legacy-migrations" id="legacy-migrations">
  <div class="fix-plan-header">
    <div>
      <div class="fix-plan-title">Legacy — consider migrating</div>
      <div class="fix-plan-sub">These files follow an older pattern the codebase is migrating away from. Not drift, not urgent — but worth planning as part of your next refactor in the affected directories.</div>
    </div>
  </div>
  ${sections.join("\n")}
</section>`;
}

function buildFileHealthBar(result: ScanResult, detailedUrl: string): string {
  if (!result.perFileScores || result.perFileScores.size === 0) return "";

  type Row = { file: string; score: number; findingCount: number; weight: number };
  const rows: Row[] = [];
  for (const entry of result.perFileScores.values()) {
    if (entry.findings.length === 0) continue;
    // Severity-weighted finding count for ranking
    const weight = entry.findings.reduce(
      (s, f) => s + (f.severity === "error" ? 3 : f.severity === "warning" ? 1.5 : 0.5) * (f.confidence ?? 1.0),
      0,
    );
    rows.push({ file: entry.file, score: entry.score, findingCount: entry.findings.length, weight });
  }

  if (rows.length === 0) return "";

  // Sort worst-first (low score × high weight); stable tiebreak by filename
  rows.sort((a, b) => {
    const delta = (a.score - a.weight * 5) - (b.score - b.weight * 5);
    if (delta !== 0) return delta;
    return a.file.localeCompare(b.file);
  });

  const topN = 10;
  const shown = rows.slice(0, topN);
  const rest = rows.slice(topN);

  const renderRow = (r: Row) => {
    const col = scoreColor(r.score);
    return `<a class="file-health-row" href="${detailedUrl}" target="_blank" rel="noopener">
      <span class="file-health-path" title="${esc(r.file)}">${esc(r.file)}</span>
      <div class="file-health-bar"><div class="file-health-bar-fill" style="width:${r.score}%;background:${col}"></div></div>
      <span class="file-health-meta">${r.score}/100 · ${r.findingCount}</span>
    </a>`;
  };

  const restBlock = rest.length > 0
    ? `<details style="margin-top:12px;"><summary style="cursor:pointer;font-size:12px;color:var(--text-secondary);padding:6px 0;"><span class="chevron">▶</span>Show ${rest.length} more file${rest.length === 1 ? "" : "s"}</summary>
        <div style="margin-top:8px;">${rest.map(renderRow).join("")}</div>
      </details>`
    : "";

  return `<section class="section file-health" id="file-health">
    <div class="fix-plan-header" style="margin-bottom:16px;">
      <div>
        <div class="fix-plan-title">File Health</div>
        <div class="fix-plan-sub">Worst-drifting files first. Click a file to jump to its findings in the Detailed lab report.</div>
      </div>
    </div>
    ${shown.map(renderRow).join("")}
    ${restBlock}
  </section>`;
}

function buildPatternConsensus(result: ScanResult): string {
  const drift = result.driftFindings ?? [];
  if (drift.length === 0) return "";

  const rows = drift
    .filter((d) => d.totalRelevantFiles >= 3 && d.dominantCount > 0)
    .slice(0, 10)
    .map((d) => {
      const cat = `${d.driftCategory.replace(/_/g, " ")}${d.subCategory ? ` · ${d.subCategory.replace(/_/g, " ")}` : ""}`;
      const total = d.totalRelevantFiles;
      const dom = d.dominantCount;
      const dev = total - dom;
      const domPct = (dom / total) * 100;
      const devPct = (dev / total) * 100;
      const minorityNames = [...new Set(d.deviatingFiles.map((df) => df.detectedPattern))].join(", ");
      return `<div class="consensus-row">
        <span class="consensus-label">${esc(cat)}</span>
        <div class="consensus-bar">
          <div class="consensus-segment" style="flex-basis:${domPct.toFixed(1)}%;background:var(--intent-green);">${dom}</div>
          <div class="consensus-segment" style="flex-basis:${devPct.toFixed(1)}%;background:var(--drift-amber);">${dev}</div>
        </div>
        <span class="consensus-meta" title="${esc(minorityNames)}">${dom}/${total} ${esc(d.dominantPattern)}</span>
      </div>`;
    }).join("");

  if (!rows) return "";

  return `<section class="section pattern-consensus" id="pattern-consensus">
    <div class="fix-plan-header" style="margin-bottom:16px;">
      <div>
        <div class="fix-plan-title">Pattern Consensus</div>
        <div class="fix-plan-sub">How strongly each detected axis agrees on a dominant pattern. Longer green = more aligned. Hover the meta column for minority-pattern names.</div>
      </div>
    </div>
    ${rows}
  </section>`;
}

function buildVisualFindingCards(result: ScanResult, detailedUrl: string): string {
  const top = topImpactFindings(result, 8);
  if (top.length === 0) return "";

  const cards = top.map((f) => renderFindingCard(f, result, detailedUrl)).join("");
  return `<section class="section" id="finding-cards-section">
    <div class="fix-plan-header" style="margin-bottom:16px;">
      <div>
        <div class="fix-plan-title">Top Drift Findings</div>
        <div class="fix-plan-sub">The ${top.length} highest-impact findings, visualized. All ${result.findings.length} findings appear in the Detailed lab report below.</div>
      </div>
    </div>
    <div class="finding-cards">${cards}</div>
  </section>`;
}

function evidenceAnchor(f: Finding): string {
  const tags = f.tags ?? [];
  const driftTag = tags.find((t) =>
    ["architectural_consistency", "security_posture", "semantic_duplication",
     "naming_conventions", "phantom_scaffolding", "import_style",
     "export_style", "async_patterns", "return_shape_consistency",
     "logging_consistency", "comment_style_consistency",
     "state_management_consistency", "test_structure_consistency"].includes(t));
  if (driftTag) return `#evidence-${driftTag}`;
  return "#evidence-static";
}

function renderFindingCard(f: Finding, _result: ScanResult, detailedUrl: string): string {
  const severityCol = sevColor(f.severity);
  const impact = typeof f.consistencyImpact === "number" ? `+${f.consistencyImpact.toFixed(2)}pts` : "";
  const loc = f.locations[0];
  const where = loc ? `${loc.file}${loc.line ? `:${loc.line}` : ""}` : "";
  const key = findingKey(f);
  const visual = renderCardVisual(f);
  const title = f.message.replace(/^DRIFT:\s*/, "");
  const anchor = evidenceAnchor(f);

  return `<article class="finding-card">
    <div class="finding-card-head">
      <span class="sev-badge" style="background:${severityCol};">${sevLabel(f.severity)}</span>
      ${impact ? `<span class="impact-chip">${impact} consistency</span>` : ""}
    </div>
    <div class="finding-card-title">${esc(title)}</div>
    ${where ? `<div style="font-size:11px;color:var(--text-tertiary);font-family:'JetBrains Mono',monospace;">${esc(where)}</div>` : ""}
    ${visual}
    <div class="finding-card-footer">
      <button class="copy-btn" data-copy-id="${esc(key)}">Copy AI Prompt</button>
      <div class="finding-vote" data-finding-hash="${esc(key)}" data-finding-type="${esc(f.analyzerId)}">
        <button class="vote-btn" data-vote="up" title="Accurate finding">👍</button>
        <button class="vote-btn" data-vote="down" title="Not useful">👎</button>
      </div>
      <a class="finding-card-link" href="${detailedUrl}${anchor}" target="_blank" rel="noopener">View evidence →</a>
    </div>
  </article>`;
}

function renderCardVisual(f: Finding): string {
  const meta = f.metadata;
  const aid = f.analyzerId;

  // Arch / drift-category cards with dominant vs deviating counts
  if (aid.startsWith("drift-") && meta?.dominantPattern && meta.dominantFiles) {
    return `<div class="finding-card-visual">
      <div style="display:flex;gap:8px;align-items:center;">
        <div style="flex:1;padding:10px;background:rgba(68,221,102,0.08);border:1px solid var(--intent-green);">
          <div style="font-size:10px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;">Dominant</div>
          <div style="font-weight:700;color:var(--intent-green);font-size:13px;margin-top:2px;">${esc(meta.dominantPattern)}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:4px;">${meta.dominantFiles.length > 0 ? esc(meta.dominantFiles[0].split("/").pop() ?? "") + (meta.dominantFiles.length > 1 ? ` +${meta.dominantFiles.length - 1}` : "") : "peer files"}</div>
        </div>
        <div style="color:var(--text-tertiary);font-size:18px;">vs</div>
        <div style="flex:1;padding:10px;background:rgba(221,51,51,0.08);border:1px solid var(--drift-red);">
          <div style="font-size:10px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.5px;">This file</div>
          <div style="font-weight:700;color:var(--drift-red);font-size:13px;margin-top:2px;">deviates</div>
        </div>
      </div>
    </div>`;
  }

  // Security — show an auth/validation proxy matrix if tags indicate
  if (aid === "security" || f.tags?.includes("security")) {
    const locs = f.locations.slice(0, 4);
    const chips = locs.map((l) => `<span style="padding:3px 8px;background:var(--drift-red);color:var(--bg-page);font-size:10px;font-weight:700;">✗ ${esc((l.file.split("/").pop() ?? l.file).slice(0, 24))}</span>`).join(" ");
    return `<div class="finding-card-visual">
      <div style="font-size:10px;color:var(--text-tertiary);margin-bottom:6px;">Risk locations:</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">${chips || `<span style="color:var(--text-tertiary);">— project-wide</span>`}</div>
    </div>`;
  }

  // Duplicates — show similar function labels
  if (aid === "duplicates" || aid.includes("duplicat") || aid.includes("fingerprint")) {
    const locs = f.locations.slice(0, 2);
    if (locs.length >= 2) {
      return `<div class="finding-card-visual">
        <div style="display:flex;gap:8px;align-items:center;">
          <div style="flex:1;padding:8px;background:var(--bg-surface);border:1px solid var(--border);font-family:monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc((locs[0].snippet ?? locs[0].file).slice(0, 40))}</div>
          <div style="color:var(--drift-amber);font-size:10px;font-weight:700;text-transform:uppercase;">≈</div>
          <div style="flex:1;padding:8px;background:var(--bg-surface);border:1px solid var(--border);font-family:monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc((locs[1].snippet ?? locs[1].file).slice(0, 40))}</div>
        </div>
      </div>`;
    }
  }

  // Complexity — bars visualizing cognitive score if present in tags/message
  if (aid === "complexity") {
    const match = f.message.match(/cognitive complexity (\d+)/);
    const cc = match ? parseInt(match[1], 10) : 0;
    if (cc > 0) {
      const bars = Math.min(cc, 30);
      const over = cc > 15 ? "var(--drift-red)" : cc > 10 ? "var(--drift-orange)" : "var(--drift-amber)";
      return `<div class="finding-card-visual">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="font-family:monospace;font-size:11px;color:var(--text-tertiary);">CC</div>
          <div style="flex:1;height:10px;background:var(--bg-surface);overflow:hidden;">
            <div style="height:100%;width:${(bars / 30 * 100).toFixed(0)}%;background:${over};"></div>
          </div>
          <div style="font-weight:700;color:${over};font-size:14px;font-variant-numeric:tabular-nums;">${cc}</div>
        </div>
      </div>`;
    }
  }

  // Default — minimal visual with first snippet
  if (loc(f)?.snippet) {
    return `<div class="finding-card-visual" style="font-family:monospace;font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(loc(f)!.snippet!.slice(0, 80))}</div>`;
  }
  return "";
}

function loc(f: Finding) { return f.locations[0]; }

export function renderHtmlReport(
  result: ScanResult,
  mode: "summary" | "detailed" = "summary",
  urls: { detailedUrl?: string; summaryUrl?: string } = {},
  opts: { scanId?: string; beaconApiUrl?: string; isPaid?: boolean } = {},
): string {
  const projectName = result.context.rootDir.split("/").pop() ?? "project";
  const { compositeScore, maxCompositeScore } = result;
  const { letter, color: gradeColor } = gradeFor(compositeScore, maxCompositeScore);
  const intentPatterns = extractIntentPatterns(result);
  const fileCoherence = buildFileCoherence(result);
  const detailedUrl = urls.detailedUrl ?? "vibedrift-report-detailed.html";
  const summaryUrl = urls.summaryUrl ?? "vibedrift-report.html";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VibeDrift Report &mdash; ${esc(projectName)}</title>
<style>
:root {
  --bg-page: #121214;
  --bg-surface: #1A1A1C;
  --bg-surface-hover: #1F1F22;
  --bg-code: #16161A;
  --text-primary: #E0E0D8;
  --text-secondary: #9A9A92;
  --text-tertiary: #757570;
  --brand-cyan: #FFD000;
  --link: #888880;
  --intent-green: #44DD66;
  --drift-amber: #C8A000;
  --drift-orange: #CC7000;
  --drift-red: #DD3333;
  --info-blue: #00AAA0;
  --grade-a: #44DD66;
  --grade-b: #44DD66;
  --grade-c: #C8A000;
  --grade-d: #CC7000;
  --grade-f: #DD3333;
  --border: #26262A;
  --border-subtle: rgba(38, 38, 42, 0.5);
  --tint-green: rgba(68, 221, 102, 0.04);
  --tint-amber: rgba(200, 160, 0, 0.03);
  --tint-orange: rgba(204, 112, 0, 0.04);
  --tint-red: rgba(221, 51, 51, 0.04);
  --tint-cyan: rgba(255, 208, 0, 0.02);
  --tint-blue: rgba(0, 170, 160, 0.04);
}
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--bg-page); color: var(--text-primary); font-family: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace; font-size: 14px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
code, .mono { font-family: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace; font-size: 13px; }
h1, h2, h3, .heading { font-family: 'Space Grotesk', -apple-system, sans-serif; }
.page { max-width: 960px; margin: 0 auto; padding: 40px 32px; }
.section { margin-bottom: 48px; }
.label { font-size: 11px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: var(--text-tertiary); margin-bottom: 16px; }
.sev-badge { display: inline-block; padding: 2px 8px; font-size: 11px; font-weight: 700; color: var(--bg-page); text-transform: uppercase; letter-spacing: 0.5px; }
.sticky-header { position: fixed; top: 0; left: 0; right: 0; height: 44px; background: rgba(18,18,20,0.95); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 32px; z-index: 100; opacity: 0; pointer-events: none; transition: opacity 200ms; font-size: 13px; }
.sticky-header.visible { opacity: 1; pointer-events: auto; }
details summary { list-style: none; }
details summary::-webkit-details-marker { display: none; }
details[open] > summary .chevron { display: inline-block; transform: rotate(90deg); }
.chevron { display: inline-block; transition: transform 150ms; margin-right: 6px; font-size: 10px; }
a { color: var(--link); text-decoration: none; }
a:hover { color: var(--text-primary); }
[data-scroll-to] { cursor: pointer; }
[data-scroll-to]:hover { text-decoration: underline; }
th[data-sort] { cursor: pointer; }
th[data-sort]:hover { color: var(--text-primary); }
.export-btn { background: var(--bg-surface); color: var(--text-secondary); border: 1px solid var(--border); padding: 6px 14px; font-size: 12px; font-weight: 700; cursor: pointer; transition: background 150ms, color 150ms; font-family: inherit; letter-spacing: 0.5px; text-transform: uppercase; }
.export-btn:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
::selection { background: #FFD000; color: #121214; }
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: var(--bg-page); }
::-webkit-scrollbar-thumb { background: #3A3A3D; }
::-webkit-scrollbar-thumb:hover { background: #555; }

/* ─── Glanceable hierarchy widgets ─── */
.glanceable { margin-bottom: 40px; }
.hero { display: flex; gap: 32px; align-items: center; padding: 28px 32px; background: var(--bg-surface); border: 1px solid var(--border); }
.hero-score { font-size: 72px; font-weight: 700; line-height: 1; font-family: 'Space Grotesk', sans-serif; }
.hero-grade { font-size: 24px; font-weight: 600; margin-left: 6px; opacity: 0.8; }
.hero-right { flex: 1; display: flex; flex-direction: column; gap: 12px; }
.hero-bar { height: 10px; background: var(--bg-code); border: 1px solid var(--border-subtle); overflow: hidden; position: relative; }
.hero-bar-fill { height: 100%; background: linear-gradient(90deg, var(--drift-red) 0%, var(--drift-orange) 25%, var(--drift-amber) 50%, var(--intent-green) 75%); transition: width 600ms ease; }
.hero-bar-marker { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--text-primary); box-shadow: 0 0 0 2px var(--bg-page); }
.hero-meta { display: flex; gap: 18px; font-size: 11px; color: var(--text-secondary); flex-wrap: wrap; }
.hero-meta strong { color: var(--text-primary); font-weight: 600; }

.cat-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 20px; }
.cat-card { background: var(--bg-surface); border: 1px solid var(--border); padding: 14px 16px; cursor: pointer; transition: background 150ms, border-color 150ms; text-decoration: none; color: inherit; display: flex; flex-direction: column; gap: 8px; }
.cat-card:hover { background: var(--bg-surface-hover); border-color: var(--text-tertiary); }
.cat-card-label { font-size: 10px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--text-tertiary); }
.cat-card-value { font-size: 24px; font-weight: 700; font-family: 'Space Grotesk', sans-serif; line-height: 1; }
.cat-card-bar { height: 4px; background: var(--bg-code); overflow: hidden; }
.cat-card-bar-fill { height: 100%; transition: width 600ms ease; }

.cta-strip { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
.cta-btn { background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-primary); padding: 10px 18px; font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; text-decoration: none; transition: background 150ms, border-color 150ms; letter-spacing: 0.3px; }
.cta-btn:hover { background: var(--bg-surface-hover); color: var(--text-primary); border-color: var(--text-tertiary); }
.cta-btn.primary { background: var(--brand-cyan); color: var(--bg-page); border-color: var(--brand-cyan); }
.cta-btn.primary:hover { background: #FFE740; color: var(--bg-page); }
.cta-hint { font-size: 12px; color: var(--text-secondary); align-self: center; margin-left: auto; }

/* Fix Plan widget */
.fix-plan { background: var(--bg-surface); border: 1px solid var(--border); padding: 24px 28px; margin-bottom: 32px; }
.fix-plan-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 20px; gap: 16px; flex-wrap: wrap; }
.fix-plan-title { font-size: 18px; font-weight: 700; font-family: 'Space Grotesk', sans-serif; }
.fix-plan-sub { font-size: 12px; color: var(--text-secondary); }
.fix-list { list-style: none; display: flex; flex-direction: column; gap: 12px; }
.fix-item { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; background: var(--bg-code); border: 1px solid var(--border-subtle); transition: border-color 150ms; }
.fix-item:hover { border-color: var(--text-tertiary); }
.fix-checkbox { margin-top: 2px; cursor: pointer; accent-color: var(--brand-cyan); width: 14px; height: 14px; flex-shrink: 0; }
.fix-item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.fix-item-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.impact-chip { background: var(--intent-green); color: var(--bg-page); padding: 2px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.3px; border-radius: 0; }
.category-chip { color: var(--text-secondary); font-size: 11px; font-style: italic; }
.intent-chip { background: var(--drift-amber); color: var(--bg-page); padding: 2px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.3px; border-radius: 0; cursor: help; }
.fix-item-note { font-size: 11px; color: var(--drift-amber); margin-top: 4px; font-style: italic; }
.fix-item-note code { background: var(--bg-code); padding: 1px 5px; color: var(--text-primary); font-size: 11px; font-style: normal; }
.fix-item-msg { font-size: 13px; color: var(--text-primary); line-height: 1.5; }
.fix-item-actions { display: flex; gap: 8px; margin-top: 6px; }
.copy-btn { background: transparent; border: 1px solid var(--border); color: var(--text-secondary); padding: 4px 10px; font-size: 11px; font-weight: 600; font-family: inherit; cursor: pointer; letter-spacing: 0.3px; text-transform: uppercase; transition: background 150ms, color 150ms; }
.copy-btn:hover { background: var(--bg-surface); color: var(--text-primary); }
.copy-btn.copied { background: var(--intent-green); color: var(--bg-page); border-color: var(--intent-green); }
.fix-plan-summary { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; font-size: 12px; }
.fix-plan-estimate { color: var(--text-primary); font-weight: 600; }
.fix-plan-estimate .projected { color: var(--intent-green); }

/* Legacy migration section — softer framing than Fix Plan */
.legacy-migrations { background: var(--bg-surface); border: 1px dashed var(--border); padding: 24px 28px; margin-bottom: 32px; }
.legacy-group { margin-top: 16px; padding: 14px 16px; background: var(--bg-code); border-left: 3px solid var(--drift-amber); }
.legacy-group-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 12px; }
.legacy-migration-label { font-size: 13px; font-weight: 700; color: var(--drift-amber); letter-spacing: 0.3px; }
.legacy-migration-count { font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 1px; }
.legacy-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.legacy-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 6px 0; font-size: 12px; }
.legacy-item-more { color: var(--text-tertiary); font-size: 11px; font-style: italic; padding-top: 4px; }
.legacy-file { color: var(--text-secondary); }
.copy-btn.copy-btn-ghost { opacity: 0.65; }
.copy-btn.copy-btn-ghost:hover { opacity: 1; }

/* File health bar */
.file-health { background: var(--bg-surface); border: 1px solid var(--border); padding: 24px 28px; margin-bottom: 32px; }
.file-health-row { display: grid; grid-template-columns: minmax(0, 1fr) 140px 60px; gap: 12px; align-items: center; padding: 6px 0; font-size: 12px; border-bottom: 1px solid var(--border-subtle); color: inherit; text-decoration: none; }
.file-health-row:last-child { border-bottom: none; }
.file-health-row:hover { background: var(--bg-surface-hover); }
.file-health-path { font-family: 'JetBrains Mono', monospace; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.file-health-path:hover { color: var(--text-primary); }
.file-health-bar { height: 10px; background: var(--bg-code); overflow: hidden; }
.file-health-bar-fill { height: 100%; transition: width 600ms ease; }
.file-health-meta { text-align: right; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

/* Pattern consensus */
.pattern-consensus { background: var(--bg-surface); border: 1px solid var(--border); padding: 24px 28px; margin-bottom: 32px; }
.consensus-row { display: grid; grid-template-columns: 180px 1fr 120px; gap: 12px; align-items: center; padding: 6px 0; font-size: 12px; border-bottom: 1px solid var(--border-subtle); }
.consensus-row:last-child { border-bottom: none; }
.consensus-label { color: var(--text-secondary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
.consensus-bar { display: flex; height: 14px; background: var(--bg-code); overflow: hidden; font-size: 10px; font-weight: 700; }
.consensus-segment { display: flex; align-items: center; justify-content: center; color: var(--bg-page); overflow: hidden; transition: flex-basis 400ms; }
.consensus-meta { text-align: right; color: var(--text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }

/* Visual finding cards */
.finding-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; margin-bottom: 32px; }
.finding-card { background: var(--bg-surface); border: 1px solid var(--border); padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
.finding-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.finding-card-title { font-size: 13px; font-weight: 600; line-height: 1.4; color: var(--text-primary); }
.finding-card-visual { padding: 14px; background: var(--bg-code); border: 1px solid var(--border-subtle); font-size: 12px; }
.finding-card-footer { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 11px; color: var(--text-secondary); }
.finding-vote { display: flex; gap: 4px; opacity: 0.5; transition: opacity 150ms; }
.finding-card:hover .finding-vote { opacity: 1; }
.vote-btn { background: none; border: 1px solid var(--border-subtle); padding: 3px 8px; font-size: 14px; cursor: pointer; transition: all 150ms; line-height: 1; }
.vote-btn:hover { background: var(--bg-surface-hover); border-color: var(--text-tertiary); transform: scale(1.15); }
.vote-btn.voted-up { background: rgba(68, 221, 102, 0.15); border-color: var(--intent-green); }
.vote-btn.voted-down { background: rgba(221, 51, 51, 0.15); border-color: var(--drift-red); }
.finding-card-link { color: var(--link); text-decoration: none; }
.finding-card-link:hover { color: var(--text-primary); text-decoration: underline; }

/* Link out to the standalone detailed report */
.detailed-link-section { margin-top: 40px; }
.detailed-toggle { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 28px; background: var(--bg-surface); border: 1px solid var(--border); text-decoration: none; transition: background 150ms, border-color 150ms; }
.detailed-toggle:hover { background: var(--bg-surface-hover); border-color: var(--text-tertiary); }
.detailed-toggle-label { display: flex; flex-direction: column; gap: 4px; }
.detailed-toggle-title { font-size: 14px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-primary); }
.detailed-toggle-hint { font-size: 12px; color: var(--text-secondary); font-style: italic; }
.detailed-toggle-icon { font-size: 22px; color: var(--text-tertiary); }
.back-to-summary { display: inline-flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 12px; padding: 6px 12px; border: 1px solid var(--border); text-decoration: none; transition: background 150ms, color 150ms; }
.back-to-summary:hover { background: var(--bg-surface); color: var(--text-primary); }

/* Toast notification */
.toast { position: fixed; bottom: 32px; right: 32px; background: var(--intent-green); color: var(--bg-page); padding: 10px 18px; font-size: 13px; font-weight: 600; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 200; transform: translateY(120%); transition: transform 200ms; }
.toast.show { transform: translateY(0); }

@media (max-width: 768px) {
  .hero { flex-direction: column; align-items: flex-start; gap: 16px; padding: 20px; }
  .hero-score { font-size: 56px; }
  .cat-grid { grid-template-columns: repeat(2, 1fr); }
  .file-health-row, .consensus-row { grid-template-columns: 1fr; }
  .file-health-meta, .consensus-meta { text-align: left; }
  .finding-cards { grid-template-columns: 1fr; }
}
@media (max-width: 768px) {
  .page { padding: 16px 10px; }
  .section { margin-bottom: 28px; }
  .label { font-size: 10px; letter-spacing: 1.5px; margin-bottom: 10px; }

  /* Score hero: stack vertically */
  .score-layout { flex-direction: column !important; gap: 16px !important; }
  .score-layout > div { min-width: 0 !important; width: 100% !important; }

  /* Category bars: stack, remove min-widths */
  .score-layout [style*="min-width:300px"],
  .score-layout [style*="min-width:280px"],
  .score-layout [style*="min-width:200px"],
  .score-layout [style*="min-width:120px"] {
    min-width: 0 !important; width: 100% !important;
  }

  /* Radar chart: constrain to viewport */
  svg[viewBox] { max-width: 100% !important; }

  /* Strongest/Weakest cards: 2-col, tighter */
  .section > div[style*="display:flex"][style*="gap:12px"] {
    gap: 8px !important;
  }
  .section > div[style*="display:flex"] > div[style*="min-width:160px"] {
    min-width: 0 !important; flex: 1 !important;
  }

  /* Findings list: tighter padding */
  details > div { padding: 8px 10px !important; }
  details summary { padding: 10px 12px !important; font-size: 13px !important; }

  /* File ranking table: horizontal scroll */
  table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; white-space: nowrap; }
  table th, table td { padding: 5px 8px !important; font-size: 11px !important; }

  /* Code snippets: wrap text */
  pre, code { white-space: pre-wrap !important; word-break: break-word !important; font-size: 12px !important; }

  /* Drift coherence bars: full width */
  .section div[style*="display:flex"][style*="gap:40px"] {
    flex-direction: column !important; gap: 16px !important;
  }

  /* Summary + AI section: stack */
  .section div[style*="display:flex"][style*="gap:20px"] {
    flex-direction: column !important; gap: 12px !important;
  }

  /* Sticky header: tighter padding */
  .sticky-header { padding: 0 12px; font-size: 12px; }
  .sticky-project { display: none !important; }

  /* Export buttons: smaller */
  .export-btn { padding: 5px 10px; font-size: 11px; }

  /* Code DNA / ML sections: reduce gap */
  .section div[style*="gap:10px"] { gap: 6px !important; }

  /* Hide long file paths, truncate */
  td[data-scroll-to] { max-width: 140px !important; }
}
@media (max-width: 480px) {
  .page { padding: 12px 8px; }
  body { font-size: 13px; }
  .label { font-size: 9px; }
  .sticky-header { height: 38px; }
  table th, table td { padding: 4px 6px !important; font-size: 10px !important; }
}
@media print {
  body { background: #fff; color: #111; font-size: 11px; line-height: 1.4; }
  .sticky-header, .export-btn, [data-copy] { display: none !important; }
  .page { max-width: 100%; padding: 0; }
  .section { margin-bottom: 24px; page-break-inside: avoid; }
  details, details[open] > div, details > div { display: block !important; }
  details > summary { list-style: none; }
  details > summary .chevron { display: none; }
  .sev-badge { border: 1px solid currentColor; background: transparent !important; color: inherit !important; }
  code, .mono { font-size: 10px; }
  * { color-adjust: exact; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style>
</head>
<body>

<div class="sticky-header" id="sticky-header">
  <div class="sticky-project" style="display:flex;align-items:center;gap:8px">
    <span style="display:inline-block;width:10px;height:10px;background:var(--brand-cyan)"></span>
    <span style="color:var(--text-primary);font-weight:700;letter-spacing:2px;font-size:12px">VIBEDRIFT</span>
    <span style="color:var(--text-tertiary)">&middot;</span>
    <span style="color:var(--text-secondary)">${esc(projectName)}</span>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    <span class="mono" style="font-weight:700;color:${gradeColor}">${compositeScore}/${maxCompositeScore}</span>
    <span style="padding:2px 8px;border-radius:0;font-size:11px;font-weight:600;background:${gradeColor}18;color:${gradeColor}">${letter}</span>
  </div>
</div>

<div class="page">

${buildHeader(result)}

${mode === "summary" ? `
${buildGlanceableSummary(result, detailedUrl)}

${buildFixPlanWidget(result)}

${buildLegacyMigrationsWidget(result)}

${buildVisualFindingCards(result, detailedUrl)}

${buildFileHealthBar(result, detailedUrl)}

${buildPatternConsensus(result)}

<section class="section detailed-link-section">
  <a class="detailed-toggle" href="${detailedUrl}" target="_blank" rel="noopener">
    <span class="detailed-toggle-label">
      <span class="detailed-toggle-title">View detailed report</span>
      <span class="detailed-toggle-hint">Full diagnosis — every finding, every file, every piece of evidence (opens in a new tab)</span>
    </span>
    <span class="detailed-toggle-icon">↗</span>
  </a>
</section>
` : `
<section class="section" style="margin-bottom:24px;">
  <a class="back-to-summary" href="${summaryUrl}" target="_top">← Back to summary</a>
</section>

${buildAiSummaryWidget(result)}

${buildCoherenceReportWidget(result)}

${buildScoreSection(result)}

${buildRadarSection(result)}

${buildIntentDefinition(intentPatterns)}

${buildCoherenceMatrix(fileCoherence)}

${buildFixFirst(result)}

${buildDriftFindings(result)}

${buildCodeDnaSummary(result)}

${buildSecurityMatrix(result)}

${buildFileRanking(result)}

${buildMlInsights(result)}

${buildStaticFindings(result)}

${buildDeepInsights(result)}

${buildLockedDeepSection(result)}
`}

${buildFooter(result)}

</div>

<script>
window.__VIBEDRIFT_DATA = ${buildEmbeddedData(result)};
window.__VIBEDRIFT_PROMPTS = ${buildEmbeddedPrompts(result, opts.isPaid ?? false)};
${opts.scanId ? `
// Report-open beacon — fires once when the report loads in a browser.
(function() {
  try {
    var url = "${opts.beaconApiUrl ?? "https://vibedrift-api.fly.dev"}/v1/beacon/report-open";
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan_id: "${opts.scanId}", opened_at: new Date().toISOString() })
    }).catch(function(){});
  } catch(e) {}
})();
` : ""}
</script>

<script>
// Sticky header
const hdr = document.getElementById('report-header');
const sticky = document.getElementById('sticky-header');
if (hdr && sticky) {
  new IntersectionObserver(([e]) => {
    sticky.classList.toggle('visible', !e.isIntersecting);
  }, { threshold: 0 }).observe(hdr);
}

// Collapsible
document.querySelectorAll('[data-collapse]').forEach(t => {
  t.addEventListener('click', () => {
    const el = document.getElementById(t.dataset.collapse);
    if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
  });
});

// Scroll-to — opens any enclosing <details> so the target is visible.
document.querySelectorAll('[data-scroll-to]').forEach(l => {
  l.addEventListener('click', e => {
    e.preventDefault();
    const t = document.getElementById(l.dataset.scrollTo);
    if (!t) return;
    let p = t;
    while (p) {
      if (p.tagName === 'DETAILS') p.open = true;
      p = p.parentElement;
    }
    const dr = document.getElementById('detailed-report');
    if (dr && dr.contains(t) && dr.tagName === 'DETAILS') dr.open = true;
    setTimeout(() => {
      t.scrollIntoView({ behavior: 'smooth', block: 'center' });
      t.style.background = 'rgba(0,212,255,0.06)';
      setTimeout(() => t.style.background = '', 2000);
    }, 30);
  });
});

// Copy
document.querySelectorAll('[data-copy]').forEach(b => {
  b.addEventListener('click', () => {
    navigator.clipboard.writeText(b.dataset.copy).then(() => { const o = b.textContent; b.textContent = 'Copied!'; setTimeout(() => b.textContent = o, 1500); });
  });
});

// Vote buttons on findings — onclick sends vote via image pixel
// (works inside sandboxed iframes where fetch is blocked)
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.vote-btn');
  if (!btn) return;
  var parent = btn.closest('.finding-vote');
  if (!parent) return;
  var hash = parent.getAttribute('data-finding-hash');
  var type = parent.getAttribute('data-finding-type');
  var vote = btn.getAttribute('data-vote');
  parent.querySelectorAll('.vote-btn').forEach(function(b) {
    b.classList.remove('voted-up', 'voted-down');
    b.style.opacity = '0.3';
  });
  btn.classList.add(vote === 'up' ? 'voted-up' : 'voted-down');
  btn.style.opacity = '1';
  parent.style.opacity = '1';
  new Image().src = 'https://vibedrift-api.fly.dev/v1/vote?t=' +
    encodeURIComponent(type) + '&h=' + encodeURIComponent(hash) +
    '&v=' + encodeURIComponent(vote) + '&_=' + Date.now();
});

function showToast(msg) {
  let t = document.getElementById('vd-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'vd-toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 1800);
}
document.querySelectorAll('[data-copy-id]').forEach(b => {
  b.addEventListener('click', () => {
    const id = b.dataset.copyId;
    const map = window.__VIBEDRIFT_PROMPTS || {};
    const text = map[id];
    if (!text) { showToast('Copy failed — prompt missing'); return; }
    const done = () => {
      const original = b.textContent;
      b.classList.add('copied');
      b.textContent = 'Copied!';
      showToast('AI prompt copied to clipboard');
      setTimeout(() => {
        b.textContent = original;
        b.classList.remove('copied');
      }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch { showToast('Copy failed'); }
        document.body.removeChild(ta);
      });
    } else {
      showToast('Clipboard not available in this browser');
    }
  });
});

// Tooltips
document.querySelectorAll('[data-tooltip]').forEach(el => {
  el.addEventListener('mouseenter', e => {
    const t = document.createElement('div');
    t.textContent = el.dataset.tooltip;
    t.style.cssText = 'position:fixed;background:var(--bg-surface);color:var(--text-primary);padding:6px 10px;border-radius:0;font-size:12px;border:1px solid var(--border);z-index:200;pointer-events:none;max-width:250px';
    document.body.appendChild(t);
    const r = el.getBoundingClientRect();
    t.style.left = r.left + 'px'; t.style.top = (r.bottom + 6) + 'px';
    el._tip = t;
  });
  el.addEventListener('mouseleave', () => { if (el._tip) { el._tip.remove(); el._tip = null; } });
});

// Table sort
document.querySelectorAll('th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const tb = th.closest('table').querySelector('tbody');
    const rows = Array.from(tb.querySelectorAll('tr'));
    const col = th.cellIndex;
    const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
    th.dataset.dir = dir;
    rows.sort((a, b) => {
      const av = a.cells[col]?.textContent?.trim() ?? '';
      const bv = b.cells[col]?.textContent?.trim() ?? '';
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    rows.forEach(r => tb.appendChild(r));
  });
});

// ──── Export: CSV ────
function exportCSV() {
  const d = window.__VIBEDRIFT_DATA;
  if (!d) { alert('Report data not available'); return; }
  const esc = v => { const s = String(v); return s.includes(',') || s.includes('"') || s.includes('\\n') ? '"'+s.replace(/"/g,'""')+'"' : s; };
  const row = (...c) => c.map(esc).join(',');
  const lines = [];
  lines.push('VIBEDRIFT REPORT');
  lines.push(row('Project', d.project));
  lines.push(row('Score', d.score + '/' + d.maxScore));
  lines.push(row('Files', d.fileCount));
  lines.push(row('Lines', d.totalLines));
  lines.push('');
  lines.push('DRIFT FINDINGS');
  lines.push(row('Severity','Category','Finding','Dominant Pattern','Consistency %','Deviating Files','Recommendation'));
  for (const f of d.driftFindings || []) lines.push(row(f.severity, f.category, f.finding, f.dominant, f.consistency, f.devFiles, f.recommendation));
  lines.push('');
  lines.push('ALL FINDINGS');
  lines.push(row('Severity','Analyzer','Message','File','Line','Confidence'));
  for (const f of d.findings || []) lines.push(row(f.severity, f.analyzer, f.message, f.file, f.line, f.confidence));
  lines.push('');
  lines.push('FILE SCORES');
  lines.push(row('File','Score','Findings'));
  for (const f of d.fileScores || []) lines.push(row(f.file, f.score, f.findings));

  const blob = new Blob([lines.join('\\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = d.project + '-vibedrift.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ──── Export: DOCX (Word-compatible HTML) ────
function buildDocxFindingsHtml(d) {
  let html = '';
  html += '<h1>Drift Findings</h1>';
  for (const f of d.driftFindings || []) {
    const sev = f.severity === 'error' ? 'critical' : f.severity;
    html += '<h2><span class="sev-' + sev + '">[' + (sev === 'critical' ? 'CRITICAL' : sev.toUpperCase()) + ']</span> ' + esc2(f.finding) + '</h2>';
    html += '<p>Category: ' + esc2(f.category) + ' | Consistency: ' + f.consistency + '%</p>';
    html += '<div class="intent"><strong>INTENT (Dominant):</strong> ' + esc2(f.dominant) + '</div>';
    html += '<div class="drift"><strong>DEVIATING:</strong> ' + esc2(f.devFiles) + '</div>';
    if (f.recommendation) html += '<div class="rec"><strong>Fix:</strong> ' + esc2(f.recommendation) + '</div>';
  }
  html += '<div class="page-break"></div><h1>All Findings</h1>';
  html += '<table><tr><th>Severity</th><th>Analyzer</th><th>Finding</th><th>File</th><th>Line</th></tr>';
  for (const f of d.findings || []) {
    html += '<tr><td class="sev-' + (f.severity === 'error' ? 'critical' : f.severity) + '">' + f.severity.toUpperCase() + '</td>';
    html += '<td>' + esc2(f.analyzer) + '</td><td>' + esc2(f.message) + '</td>';
    html += '<td><code>' + esc2(f.file) + '</code></td><td>' + f.line + '</td></tr>';
  }
  html += '</table>';
  return html;
}

function buildDocxScoresHtml(d) {
  let html = '';
  html += '<div class="page-break"></div><h1>File Scores</h1>';
  html += '<table><tr><th>File</th><th>Score</th><th>Findings</th></tr>';
  for (const f of d.fileScores || []) {
    html += '<tr><td><code>' + esc2(f.file) + '</code></td><td>' + f.score + '/100</td><td>' + f.findings + '</td></tr>';
  }
  html += '</table>';
  if (d.codeDna) {
    html += '<div class="page-break"></div><h1>Code DNA Analysis</h1>';
    if (d.codeDna.sequences && d.codeDna.sequences.length > 0) {
      html += '<h2>Operation Sequence Matches</h2><table><tr><th>Function A</th><th>Function B</th><th>Similarity</th></tr>';
      for (const s of d.codeDna.sequences) html += '<tr><td>' + esc2(s.a) + '</td><td>' + esc2(s.b) + '</td><td>' + s.pct + '%</td></tr>';
      html += '</table>';
    }
    if (d.codeDna.deviations && d.codeDna.deviations.length > 0) {
      html += '<h2>Deviation Analysis</h2><table><tr><th>File</th><th>Verdict</th><th>Pattern</th></tr>';
      for (const dv of d.codeDna.deviations) html += '<tr><td>' + esc2(dv.file) + '</td><td>' + dv.verdict + '</td><td>' + esc2(dv.pattern) + '</td></tr>';
      html += '</table>';
    }
  }
  if (d.deepInsights && d.deepInsights.length > 0) {
    html += '<div class="page-break"></div><h1>Deep Analysis Insights (AI-Powered)</h1>';
    for (const ins of d.deepInsights) {
      html += '<h3>[' + ins.severity.toUpperCase() + '] ' + esc2(ins.title) + '</h3>';
      html += '<p>' + esc2(ins.description) + '</p>';
      if (ins.recommendation) html += '<div class="rec"><strong>Fix:</strong> ' + esc2(ins.recommendation) + '</div>';
    }
  }
  return html;
}

function exportDOCX() {
  const d = window.__VIBEDRIFT_DATA;
  if (!d) { alert('Report data not available'); return; }

  let html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>';
  html += 'body{font-family:Calibri,sans-serif;font-size:11pt;color:#222;margin:40px}';
  html += 'h1{font-size:20pt;color:#0B0F15;border-bottom:2px solid #00D4FF;padding-bottom:8px;margin-top:28px}';
  html += 'h2{font-size:14pt;color:#333;margin-top:20px}';
  html += 'h3{font-size:12pt;color:#555;margin-top:14px}';
  html += 'table{border-collapse:collapse;width:100%;margin:10px 0}';
  html += 'th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;font-size:10pt}';
  html += 'th{background:#f0f4f8;font-weight:600}';
  html += '.sev-critical{color:#dc2626;font-weight:700} .sev-warning{color:#d97706;font-weight:700} .sev-info{color:#2563eb}';
  html += '.intent{background:#ecfdf5;border-left:3px solid #10b981;padding:8px 12px;margin:6px 0}';
  html += '.drift{background:#fff7ed;border-left:3px solid #f97316;padding:8px 12px;margin:6px 0}';
  html += '.rec{background:#f0f9ff;border-left:3px solid #0ea5e9;padding:8px 12px;margin:6px 0}';
  html += 'code{font-family:Consolas,monospace;font-size:9pt;background:#f5f5f5;padding:1px 4px}';
  html += '.page-break{page-break-before:always}';
  html += '</style></head><body>';

  html += '<div style="text-align:center;margin-bottom:30px">';
  html += '<h1 style="border:none;font-size:28pt;color:#00D4FF">VIBEDRIFT REPORT</h1>';
  html += '<p style="font-size:16pt;color:#333">' + esc2(d.project) + '</p>';
  html += '<p>' + d.fileCount + ' files &middot; ' + formatCount(d.totalLines) + ' LOC &middot; Score: <strong>' + d.score + '/' + d.maxScore + '</strong></p>';
  html += '</div>';

  html += buildDocxFindingsHtml(d);
  html += buildDocxScoresHtml(d);

  html += '<hr><p style="color:#999;font-size:9pt">Generated by VibeDrift v' + d.version + ' | ' + d.fileCount + ' files | No data sent externally</p>';
  html += '</body></html>';

  const blob = new Blob([html], { type: 'application/vnd.ms-word' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = d.project + '-vibedrift.doc';
  a.click();
  URL.revokeObjectURL(a.href);
}

function esc2(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script>

</body>
</html>`;
}
