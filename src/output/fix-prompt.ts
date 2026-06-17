/**
 * Markdown fix-prompt template. Produces a block the user can paste into
 * Cursor, Claude Code, or any LLM chat to re-align a drift finding with
 * its peer baseline.
 *
 *   • buildFixPromptMarkdown(finding, opts) — one finding → one prompt
 *   • buildFullFixPlanMarkdown(findings, opts) — multiple findings → one
 *     bundled prompt
 *
 * When finding.metadata carries dominantPattern + dominantFiles, the
 * prompt names the peer baseline and lists reference files. For findings
 * without that metadata, it falls back to message + file/line + evidence.
 * When opts.richProse is provided, a "How the peers do this" section is
 * inserted between "What's drifting" and "What to do".
 */

import type { Finding } from "../core/types.js";

export interface FixPromptContext {
  /** Scan root basename; shows up in the prompt header. */
  projectName?: string;
  /** Dominant language (ts, py, go, ...) — inlined for AI hint. */
  language?: string | null;
  /** Total file count (sanity check the AI's context is complete). */
  fileCount?: number;
  /** AI-synthesized prose describing how peers implement the dominant pattern. */
  richProse?: string;
}

// Stable identifier for a finding so callers can key richProse by it.
export function findingKey(f: Finding): string {
  const loc = f.locations[0];
  return `${f.analyzerId}:${loc?.file ?? ""}:${loc?.line ?? 0}:${f.message.slice(0, 32)}`;
}

function severityLabel(s: Finding["severity"]): string {
  return s === "error" ? "error" : s === "warning" ? "warning" : "info";
}

function pctFromConfidence(c: number): string {
  return `${Math.round((c ?? 0) * 100)}%`;
}

function impactLine(f: Finding): string | null {
  if (typeof f.consistencyImpact !== "number") return null;
  const v = f.consistencyImpact;
  if (v <= 0) return null;
  return `**Consistency impact if resolved:** +${v.toFixed(2)}pts`;
}

function categoryLabel(f: Finding): string {
  const tags = f.tags ?? [];
  const driftTag = tags.find((t) => t.endsWith("_consistency") || t.endsWith("_posture") || t.endsWith("_duplication") || t.endsWith("_conventions") || t.endsWith("_scaffolding") || t.endsWith("_style") || t.endsWith("_patterns"));
  if (driftTag) return driftTag.replace(/_/g, " ");
  return f.analyzerId;
}

/**
 * Actionable per-analyzer guidance for findings that don't emit their
 * own `recommendation` field. Without this, every static-analyzer
 * finding falls back to a generic "address the finding" line that's
 * useless to an AI agent. Keyed on analyzerId — extend when adding
 * new analyzers.
 */
const ANALYZER_RECOMMENDATIONS: Record<string, string> = {
  security:
    "Review each flagged line. If it's a real secret, rotate it immediately and move it to an environment variable or secret manager. If it's a test fixture (hardcoded example strings for security tests), move the string into a dedicated `.fixtures.ts` file under `test/` and reference it via import — the scanner excludes fixture files.",
  "dead-code":
    "For each listed export, verify whether it's part of your public API. If it is (re-exported from a package entry point like `@your-package/render`), add it to `package.json`'s `exports` field so downstream consumers don't break. If it isn't, delete both the export keyword and the implementation.",
  duplicates:
    "Compare each pair of duplicate bodies. If the duplication is incidental (the AI re-implemented an existing helper in a new session), extract a single shared function and update call sites. If the duplication is intentional (test scaffolding, framework boilerplate), add a leading comment explaining why — makes the intent legible to future readers.",
  "todo-density":
    "High TODO density usually signals planned-but-unfinished work. For each cluster: (1) convert TODOs to tracked issues if they still matter, (2) complete them if they're small, or (3) delete them if they're stale. A living TODO is worse than a filed ticket — file tickets.",
  "intent-clarity":
    "For each flagged function, check whether the function body matches what the name promises. If the name is misleading (name says `validate` but body also mutates), rename to match the behavior (e.g. `validateAndSave`). If the body is the outlier, split the function so each has one clear job matching its name.",
  complexity:
    "Long functions are hard to review and harder to modify safely. Extract sub-routines with names that describe what they do. For each flagged function: identify the 2-4 logical phases, pull each into a helper, and have the outer function read like a narrative. If the length is genuinely inherent (big switch statement, large data literal), add a section-divider comment so the structure is scannable.",
  "language-specific":
    "Language idiom violations. Common cases: Python `bare except:` clauses (replace with `except Exception:` or specific types — bare catches swallow SystemExit / KeyboardInterrupt). JavaScript `Object.hasOwnProperty` direct calls (use `Object.hasOwn(x, k)` or `Object.prototype.hasOwnProperty.call(x, k)`). Fix per the language's idiomatic form.",
  dependencies:
    "Packages imported but not declared in package.json will break the build for anyone else. For each listed package, run `npm install <name>` to add it, or remove the import if the functionality is available through an already-declared dep. For typescript, ensure `@types/<package>` is also in devDependencies when needed.",
  imports:
    "Inconsistent import paths mix `./relative` and `@/alias` forms, making large refactors risky (mass find-and-replace breaks the minority pattern). Pick one style for the project and migrate the minority — most teams settle on aliases for cross-module (`@/lib/...`) and relative for sibling (`./helpers`).",
  naming:
    "The majority convention in this directory is noted above. For each deviating file or symbol, rename to match. If using git, prefer `git mv` so history follows the rename. If a rename would break public API (exported symbols used by downstream consumers), add a deprecated alias on the old name rather than changing it.",
  "error-handling":
    "Empty catch blocks silently swallow errors — bugs manifest far from the real cause. For each empty catch: (1) log the error with context, (2) rethrow with more information, or (3) explicitly handle the specific error type. If suppression is genuinely intentional, add a `// expected: <reason>` comment so future readers know.",
  "config-drift":
    "Configuration or environment reads scattered across files cause hard-to-reproduce production bugs. Consolidate config access through a single module (`src/config.ts`), validate env vars at startup, and import typed config everywhere else.",
};

function fallbackRecommendation(analyzerId: string): string | null {
  if (ANALYZER_RECOMMENDATIONS[analyzerId]) return ANALYZER_RECOMMENDATIONS[analyzerId];
  // Strip common prefixes ("drift-" etc.) and try again
  const stripped = analyzerId.replace(/^drift-/, "").replace(/^codedna-/, "");
  return ANALYZER_RECOMMENDATIONS[stripped] ?? null;
}

function referenceFilesBlock(dominantFiles: string[]): string {
  if (dominantFiles.length === 0) return "";
  return [
    "",
    "Reference files that already follow the dominant pattern:",
    "",
    ...dominantFiles.map((f) => `- \`${f}\``),
  ].join("\n");
}

function evidenceBlock(f: Finding): string {
  if (f.locations.length === 0) return "";
  const rows = f.locations.slice(0, 5).map((loc) => {
    const where = loc.line ? `${loc.file}:${loc.line}` : loc.file;
    const snippet = loc.snippet ? ` — \`${loc.snippet.trim().slice(0, 120)}\`` : "";
    return `- \`${where}\`${snippet}`;
  });
  const extra = f.locations.length > 5 ? `\n- …and ${f.locations.length - 5} more` : "";
  return ["", "### Evidence from VibeDrift", "", ...rows].join("\n") + extra;
}

/**
 * Single-finding fix prompt. Safe to paste into any LLM chat.
 *
 * `mode` controls framing:
 *   - "drift"  (default) — file is a real deviation; urgency is "fix it
 *                          now, the peers are here right now"
 *   - "legacy" — file aligns with the old pre-pivot pattern; urgency is
 *                "migrate when convenient, the team is moving this way"
 */
export function buildFixPromptMarkdown(
  finding: Finding,
  ctx: FixPromptContext = {},
  mode: "drift" | "legacy" = "drift",
  filePath?: string,
): string {
  const firstLoc = finding.locations[0];
  const fileLine = filePath
    ? filePath
    : firstLoc
      ? `${firstLoc.file}${firstLoc.line ? `:${firstLoc.line}` : ""}`
      : "(project-wide)";

  const meta = finding.metadata ?? {};
  const isDrift = finding.analyzerId.startsWith("drift-");
  const title = mode === "legacy"
    ? "VibeDrift Legacy Migration"
    : isDrift
      ? "VibeDrift Drift Finding"
      : "VibeDrift Finding";

  const header: string[] = [
    `## ${title}`,
    "",
    `**File:** \`${fileLine}\``,
    `**Category:** ${categoryLabel(finding)}`,
    `**Severity:** ${severityLabel(finding.severity)} · Confidence: ${pctFromConfidence(finding.confidence)}`,
  ];
  if (meta.pivot && mode === "legacy") {
    header.push(
      `**Pivot context:** codebase is migrating \`${meta.pivot.fromPattern}\` → \`${meta.pivot.toPattern}\` (recent peers ${meta.pivot.recentConsistencyScore}% aligned on the new pattern)`,
    );
  }
  if (meta.intentDivergence) {
    header.push(
      `**Declared in:** \`${meta.intentDivergence.source}:${meta.intentDivergence.line}\` — "${meta.intentDivergence.text.slice(0, 140)}"`,
    );
  }
  const impact = impactLine(finding);
  if (impact && mode !== "legacy") header.push(impact);

  const whatHeading = mode === "legacy" ? "### What's happening" : "### What's drifting";
  const whatSection: string[] = ["", whatHeading, ""];
  if (mode === "legacy") {
    whatSection.push(
      `This file uses the **${meta.pivot?.fromPattern ?? "legacy"}** pattern. ` +
        `The codebase's recently-written files have been adopting **${meta.pivot?.toPattern ?? meta.dominantPattern ?? "a different approach"}** — ${meta.pivot?.recentFileCount ?? "several"} recent peers now follow it. This file isn't drift; it's legacy. It works, but it's on the side of the codebase the team is moving away from.`,
    );
  } else {
    whatSection.push(finding.message.replace(/^DRIFT:\s*/, ""));
    if (isDrift && meta.dominantPattern) {
      whatSection.push("", `Dominant pattern in peer files: **${meta.dominantPattern}**`);
    }
    if (meta.intentDivergence) {
      whatSection.push(
        "",
        `**The team declared \`${meta.intentDivergence.declaredLabel}\`** in \`${meta.intentDivergence.source}\`, but the code here is using \`${meta.dominantPattern ?? "something else"}\` instead. This is a declared-intent divergence — the code is drifting from the team's stated convention, not just from its peers.`,
      );
    }
  }
  if (isDrift && Array.isArray(meta.dominantFiles) && meta.dominantFiles.length > 0) {
    whatSection.push(referenceFilesBlock(meta.dominantFiles));
  }

  const richSection: string[] = [];
  const prose = meta.fixPromptProse ?? ctx.richProse;
  if (prose) {
    richSection.push("", "### How the peers do this", "", prose.trim());
  }

  const actionHeading = mode === "legacy" ? "### Migration plan (not urgent)" : "### What to do";
  const actionSection: string[] = ["", actionHeading, ""];
  if (mode === "legacy") {
    actionSection.push(
      `Schedule a migration of \`${firstLoc?.file ?? "this file"}\` from **${meta.pivot?.fromPattern ?? "the old pattern"}** to **${meta.pivot?.toPattern ?? meta.dominantPattern ?? "the new pattern"}**. Read the reference files listed above — they show the team's current convention. There's no rush; this is a follow-along refactor, not an alignment fix. Do it before the next feature that touches this file, not as a blocking task.`,
    );
  } else if (meta.recommendation) {
    actionSection.push(meta.recommendation);
  } else if (isDrift && Array.isArray(meta.dominantFiles) && meta.dominantFiles.length > 0) {
    actionSection.push(
      `Refactor \`${firstLoc?.file ?? "this file"}\` to match the dominant pattern used by its peers. Read the reference files listed above to understand the conventions (naming, error handling, control flow) and apply the same shape.`,
    );
  } else {
    // Analyzer-specific fallback when no recommendation was provided.
    // Covers the rule-based static analyzers (security, dead-code,
    // todo-density, etc.) whose findings don't carry a detector-authored
    // recommendation field.
    const analyzerFallback = fallbackRecommendation(finding.analyzerId);
    actionSection.push(
      analyzerFallback ??
        "Address the finding described above. Match whatever convention is established elsewhere in the codebase.",
    );
  }
  actionSection.push("", "Preserve any existing tests and error-handling shape unless the dominant pattern explicitly changes them.");

  return [
    ...header,
    ...whatSection,
    ...richSection,
    ...actionSection,
    evidenceBlock(finding),
    "",
    "---",
    referralFooter(ctx.projectName),
  ]
    .filter((line) => line !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Attribution footer for the generated `.vibedrift/` fix files. Carries a
 * clickable link back to vibedrift.ai so a committed fix-prompts.md /
 * fix-plan.md acts as a silent referral to every collaborator who reads it.
 */
export function referralFooter(projectName?: string): string {
  return `_Generated by [VibeDrift](https://vibedrift.ai)${projectName ? ` for ${projectName}` : ""}. Run \`npx @vibedrift/cli\` after the fix to verify the drift closed._`;
}

/**
 * Multi-finding "fix everything" prompt.
 */
export function buildFullFixPlanMarkdown(
  findings: Finding[],
  ctx: FixPromptContext = {},
): string {
  if (findings.length === 0) {
    return "No drift findings — your codebase is well-aligned.";
  }

  const header: string[] = [
    "# VibeDrift Fix Plan",
    "",
    ctx.projectName ? `**Project:** ${ctx.projectName}` : "",
    ctx.language ? `**Dominant language:** ${ctx.language}` : "",
    ctx.fileCount ? `**Files scanned:** ${ctx.fileCount}` : "",
    "",
    `This plan groups ${findings.length} drift finding${findings.length === 1 ? "" : "s"} into a single context block. Each finding identifies a deviation from the codebase's dominant pattern; fixing them re-aligns the files that have drifted.`,
    "",
    "Work through them in the order listed — they're sorted by consistency impact (largest first). After applying all changes, re-run `npx @vibedrift/cli` to confirm the drift has closed.",
    "",
    "---",
    "",
  ].filter(Boolean);

  const findingBlocks = findings.map((f, idx) => {
    const block = buildFixPromptMarkdown(f, ctx);
    return block.replace(/^## /, `## ${idx + 1}. `);
  });

  // Each finding block already ends with referralFooter() (via
  // buildFixPromptMarkdown), so the plan is link-attributed without an
  // extra plan-level footer.
  return [...header, findingBlocks.join("\n\n---\n\n")].join("\n");
}
