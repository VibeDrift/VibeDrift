import { mkdtemp, cp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { buildAnalysisContext } from "../src/core/discovery.js";
import { runDriftDetection } from "../src/drift/index.js";
import { SCORING_VERSION } from "../src/scoring/engine.js";
import type { Artifact, DriftMeasure } from "./types.js";

/**
 * Score how much drift a set of new files introduces against a seed repo's
 * established patterns.
 *
 * Copies the seed repo to a temp dir, writes the agent's new files into it,
 * runs the FULL drift engine, and counts findings in which a new file appears
 * as a deviator. Scoring with the whole engine (not the in-loop MCP tools the
 * treatment arm may have used) keeps the metric non-circular. Lower = the new
 * code conformed to the repo.
 */
export async function introducedDrift(
  seedRepoDir: string,
  newFiles: Artifact[],
): Promise<DriftMeasure> {
  const work = await mkdtemp(join(tmpdir(), "vd-eval-"));
  try {
    await cp(seedRepoDir, work, { recursive: true });
    const added = new Set<string>();
    for (const f of newFiles) {
      const dest = join(work, f.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.body, "utf8");
      added.add(f.path);
    }

    const { ctx } = await buildAnalysisContext(work);
    const { driftFindings } = runDriftDetection(ctx);

    const hits = driftFindings.filter((df) =>
      df.deviatingFiles.some((d) => added.has(d.path)),
    );

    const bySeverity = { info: 0, warning: 0, error: 0 };
    for (const h of hits) bySeverity[h.severity]++;

    const findings = hits.flatMap((h) =>
      h.deviatingFiles
        .filter((d) => added.has(d.path))
        .map((d) => ({
          category: h.driftCategory,
          detector: h.detector,
          dominantPattern: h.dominantPattern,
          file: d.path,
        })),
    );

    return { introduced: hits.length, bySeverity, findings, scoringVersion: SCORING_VERSION };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
