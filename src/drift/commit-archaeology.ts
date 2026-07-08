/**
 * Commit-archaeology drift detector.
 *
 * AI-generated code has a distinctive git-history shape: one author
 * commits a large chunk in a single short burst, and no one comes back
 * to refine it. Human-written code (especially in shared codebases) is
 * usually cultivated — multiple authors, commits spread over time, a
 * trail of small refinements. When a file stands out from the repo's
 * norm on *authorship shape*, that's a real drift signal about how
 * the code was produced, independent of what it does.
 *
 * Algorithm
 * ---------
 *   1. Compute a per-file "burst score" combining:
 *        - singleSession (all commits in a 6h window) — boolean
 *        - low authorDiversity — entropy < 0.3 means one author dominates
 *        - tight medianCommitIntervalHours — < 1h between commits
 *      Each condition contributes +1. Score range: 0–3. Score ≥ 2 → burst.
 *
 *   2. Require the repo to have enough files to compute a norm:
 *        - at least 10 files with git metadata
 *        - at least 5 of them with ≥ 2 commits
 *      Small repos / fresh history don't produce meaningful norms —
 *      skip silently.
 *
 *   3. If the fraction of burst files in the repo is > 40%, the project
 *      itself is AI-bursty on average. Emitting drift findings in that
 *      case would flood the report with ~every file. Skip silently;
 *      we can't distinguish signal from noise.
 *
 *   4. Otherwise, flag burst files located in directories where the
 *      majority of sibling files are NOT burst. Directory scoping
 *      avoids false-positives on pure scaffolding dirs (migrations,
 *      generated code) where everything is legitimately single-session.
 *
 * Zero findings when:
 *   - No git metadata collected (`hasGitMetadata !== true`)
 *   - < 10 files with git metadata
 *   - < 5 files with ≥ 2 commits (not enough data per file)
 *   - Burst rate > 40% of repo (no stable norm)
 *
 * Fold into the Architectural Consistency category (same bucket as
 * naming + import + convention drift). Doesn't introduce a new
 * DriftCategory — it's a shape-of-authorship signal that belongs with
 * the other cross-file consistency detectors.
 */

import type {
  DriftContext,
  DriftDetector,
  DriftFile,
  DriftFinding,
  DeviatingFile,
  Evidence,
} from "./types.js";
import { directoryOf, isAnalyzableSource } from "./utils.js";

const MIN_FILES_FOR_NORM = 10;
const MIN_FILES_WITH_HISTORY = 5;
const MAX_BURST_RATE_FOR_SIGNAL = 0.4; // repos >40% bursty are uniformly AI-gen; no signal
const MIN_SIBLINGS_IN_DIR = 3;
const TIGHT_INTERVAL_HOURS = 1;
const LOW_DIVERSITY_ENTROPY = 0.3;
const BURST_SCORE_THRESHOLD = 2;

interface BurstProfile {
  file: DriftFile;
  score: number; // 0..3
  reasons: string[];
}

function profileFile(f: DriftFile): BurstProfile | null {
  if (!f.git) return null;
  if (f.git.commitCountTotal < 2) return null; // Not enough data

  const reasons: string[] = [];
  let score = 0;

  if (f.git.singleSession === true) {
    score++;
    reasons.push("all commits within one 6-hour window");
  }
  if (
    f.git.authorDiversity !== undefined &&
    f.git.authorDiversity < LOW_DIVERSITY_ENTROPY &&
    f.git.uniqueAuthors <= 1
  ) {
    score++;
    reasons.push("single-author history");
  }
  if (
    f.git.medianCommitIntervalHours !== undefined &&
    f.git.medianCommitIntervalHours < TIGHT_INTERVAL_HOURS
  ) {
    score++;
    reasons.push(`median commit interval ${f.git.medianCommitIntervalHours.toFixed(1)}h`);
  }

  return { file: f, score, reasons };
}

export const commitArchaeology: DriftDetector = {
  id: "commit-archaeology",
  name: "Commit Archaeology",
  category: "architectural_consistency",

  detect(ctx: DriftContext): DriftFinding[] {
    if (ctx.hasGitMetadata !== true) return [];

    // Build profiles for every analyzable file with ≥ 2 commits.
    const profiles: BurstProfile[] = [];
    let filesWithHistory = 0;
    let filesWithGit = 0;
    for (const f of ctx.files) {
      if (!isAnalyzableSource(f.relativePath)) continue;
      if (!f.git) continue;
      filesWithGit++;
      if (f.git.commitCountTotal >= 2) filesWithHistory++;
      const p = profileFile(f);
      if (p) profiles.push(p);
    }

    if (filesWithGit < MIN_FILES_FOR_NORM) return [];
    if (filesWithHistory < MIN_FILES_WITH_HISTORY) return [];

    const bursty = profiles.filter((p) => p.score >= BURST_SCORE_THRESHOLD);
    if (bursty.length === 0) return [];
    if (bursty.length / profiles.length > MAX_BURST_RATE_FOR_SIGNAL) {
      // Project is uniformly AI-bursty; drift signal is noise here.
      return [];
    }

    // Group bursty files by their directory. In each directory, require
    // that the majority of siblings are NOT bursty — otherwise the
    // directory itself is scaffolding/generated and burst shape is
    // normal. Directory size floor keeps small subdirs from producing
    // false findings.
    const profilesByDir = new Map<string, BurstProfile[]>();
    for (const p of profiles) {
      const dir = directoryOf(p.file.relativePath);
      const list = profilesByDir.get(dir) ?? [];
      list.push(p);
      profilesByDir.set(dir, list);
    }

    const findings: DriftFinding[] = [];
    const dirs = [...profilesByDir.keys()].sort();
    for (const dir of dirs) {
      const group = profilesByDir.get(dir)!;
      if (group.length < MIN_SIBLINGS_IN_DIR) continue;
      const burstyInDir = group.filter((p) => p.score >= BURST_SCORE_THRESHOLD);
      const nonBursty = group.length - burstyInDir.length;
      if (burstyInDir.length === 0) continue;
      // The directory must have a clear "cultivated" majority — otherwise
      // the directory *is* the anomaly, not individual files.
      if (nonBursty < burstyInDir.length) continue;

      const deviating: DeviatingFile[] = burstyInDir.map((p) => {
        const evidence: Evidence[] = [{ line: 1, code: p.reasons.join(" · ") }];
        return {
          path: p.file.relativePath,
          detectedPattern: `burst authorship (score ${p.score}/3)`,
          evidence,
        };
      });

      const consistencyScore = Math.round((nonBursty / group.length) * 100);

      findings.push({
        detector: "commit-archaeology",
        subCategory: "burst_authorship",
        driftCategory: "architectural_consistency",
        severity: burstyInDir.length >= 3 ? "warning" : "info",
        confidence: 0.7,
        finding: `${burstyInDir.length} file(s) in ${dir}/ have burst-authorship shape (single-author, one sitting) while ${nonBursty} sibling(s) were cultivated over time`,
        dominantPattern: "cultivated authorship (multi-commit over time)",
        dominantCount: nonBursty,
        totalRelevantFiles: group.length,
        consistencyScore,
        deviatingFiles: deviating,
        dominantFiles: group
          .filter((p) => p.score < BURST_SCORE_THRESHOLD)
          .map((p) => p.file.relativePath)
          .sort()
          .slice(0, 3),
        recommendation: `Burst-authored files in ${dir}/ deviate from the directory's normal commit shape. Review for AI-generated code that was never touched by a second reviewer.`,
      });
    }

    return findings;
  },
};
