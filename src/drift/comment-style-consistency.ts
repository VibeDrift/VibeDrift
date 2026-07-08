/**
 * Comment style consistency detector.
 *
 * Low-signal but legitimate AI-drift marker: JSDoc in some files, plain
 * `//` in others, no comments in a third set. Info-level only — noisy if
 * per-file, so we emit a single project-summary finding instead.
 */

import type {
  DriftContext,
  DriftDetector,
  DriftFile,
  DriftFinding,
} from "./types.js";
import { isAnalyzableSource } from "./utils.js";

type DocStyle = "jsdoc" | "line_comment" | "hash_comment" | "none";

const STYLE_NAMES: Record<DocStyle, string> = {
  jsdoc: "JSDoc (/** ... */)",
  line_comment: "line comments (//)",
  hash_comment: "hash comments (#)",
  none: "no comments",
};

function dominantStyle(file: DriftFile): DocStyle {
  const lines = file.content.split("\n");
  let jsdocBlocks = 0;
  let lineComments = 0;
  let hashComments = 0;

  let inJsdoc = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("/**")) {
      inJsdoc = true;
      jsdocBlocks++;
      if (trimmed.endsWith("*/")) inJsdoc = false;
      continue;
    }
    if (inJsdoc) {
      if (trimmed.endsWith("*/")) inJsdoc = false;
      continue;
    }
    if (trimmed.startsWith("//")) lineComments++;
    else if (trimmed.startsWith("#") && !trimmed.startsWith("#!")) hashComments++;
  }

  // Dominant style = whichever category has the most "votes" over the file.
  // JSDoc blocks count extra since each one represents a substantial doc
  // comment rather than a throwaway aside.
  const scores: [DocStyle, number][] = [
    ["jsdoc", jsdocBlocks * 3],
    ["line_comment", lineComments],
    ["hash_comment", hashComments],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [winner, winnerScore] = scores[0];

  // Require at least some commentary, otherwise the file is "none".
  if (winnerScore === 0) return "none";
  return winner;
}

export const commentStyleConsistency: DriftDetector = {
  id: "comment-style-consistency",
  name: "Comment Style Consistency",
  category: "comment_style_consistency",

  detect(ctx: DriftContext): DriftFinding[] {
    const byStyle = new Map<DocStyle, string[]>();
    let analyzed = 0;

    for (const file of ctx.files) {
      if (!isAnalyzableSource(file.relativePath)) continue;
      if (!file.language) continue;
      // Python/Ruby/etc use #; JS/TS/Go/Rust use //. To avoid false drift
      // from language mix, restrict this check to JS/TS projects where
      // JSDoc vs // is a meaningful choice.
      if (file.language !== "javascript" && file.language !== "typescript") continue;

      analyzed++;
      const style = dominantStyle(file);
      const list = byStyle.get(style);
      if (list) list.push(file.relativePath);
      else byStyle.set(style, [file.relativePath]);
    }

    if (analyzed < 5) return [];

    // How many distinct non-"none" styles coexist?
    const stylesWithContent = [...byStyle.entries()].filter(
      ([style, files]) => style !== "none" && files.length > 0,
    );
    if (stylesWithContent.length < 2) return [];

    // Rank by frequency; the biggest is "dominant".
    stylesWithContent.sort((a, b) => b[1].length - a[1].length);
    const [dominant, dominantFiles] = stylesWithContent[0];
    const minority = stylesWithContent.slice(1).flatMap(([_, files]) => files);

    const consistencyScore = Math.round((dominantFiles.length / analyzed) * 100);

    return [{
      detector: "comment-style-consistency",
      driftCategory: "comment_style_consistency",
      severity: "info",
      confidence: 0.6,
      finding: `${dominantFiles.length} JS/TS files use ${STYLE_NAMES[dominant]} while ${minority.length} use other styles`,
      dominantPattern: STYLE_NAMES[dominant],
      dominantCount: dominantFiles.length,
      totalRelevantFiles: analyzed,
      consistencyScore,
      deviatingFiles: minority.slice(0, 15).map((f) => ({
        path: f,
        detectedPattern: "different comment style",
        evidence: [],
      })),
      dominantFiles: [...dominantFiles].sort().slice(0, 3),
      recommendation: `Pick one doc style (likely ${STYLE_NAMES[dominant]}). Mixed styles make auto-generated API docs harder to produce.`,
    }];
  },
};
