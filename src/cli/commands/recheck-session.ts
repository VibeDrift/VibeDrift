/**
 * `vibedrift recheck-session [path]` — re-check a repo's open Drift Session
 * findings against the tree as it stands and record the ones whose flagged
 * construct is positively gone (see src/session/recheck.ts for what that
 * means and what it deliberately is not).
 *
 * Local only. It reads the persisted baseline and the session sidecars, and
 * appends `resolve` events tagged `via: "recheck"` to the local ledgers; with
 * hosted sync on, the next flush ships them like any other event.
 */

import chalk from "chalk";
import { resolve } from "node:path";
import { BASELINE_VERSION, loadBaselineUnchecked } from "../../core/baseline.js";
import { repoIdentity, defaultSessionsDir } from "../../session/repo.js";
import { recheckProject, type RecheckSessionResult } from "../../session/recheck.js";

export interface RecheckSessionOptions {
  sessionId?: string;
  dryRun?: boolean;
  json?: boolean;
  /** test seams */
  sessionsDir?: string;
  now?: () => Date;
}

export type RecheckSessionStatus = "ok" | "no_baseline" | "stale_baseline" | "nothing_open";

export async function runRecheckSession(
  targetPath: string,
  options: RecheckSessionOptions = {},
): Promise<RecheckSessionStatus> {
  const { rootDir, projectHash } = repoIdentity(resolve(targetPath));
  const sessionsDir = options.sessionsDir ?? defaultSessionsDir();

  const baseline = await loadBaselineUnchecked(rootDir);
  if (!baseline) {
    console.log(
      `${chalk.yellow("!")} No drift baseline for ${rootDir}. Run ${chalk.cyan("vibedrift scan")} (or ${chalk.cyan("npx @vibedrift/cli .")}) first, then re-run.`,
    );
    return "no_baseline";
  }

  // A baseline built by another version of VibeDrift is not comparable with
  // this one. The duplicate arm of the presence predicate queries
  // baseline.minhashIndex, and a version bump means those persisted token
  // streams came from a different tokenizer, so a clone that is still sitting
  // there can look absent. Every arm of the predicate is OR'd, so a weaker one
  // can only CLEAR findings, never hold them open, which is the wrong
  // direction for a command whose whole job is deciding what is genuinely
  // fixed. Rescan first, then re-check.
  if (baseline.version !== BASELINE_VERSION) {
    console.log(
      `${chalk.yellow("!")} The drift baseline for ${rootDir} was built by another version of VibeDrift ` +
        `(baseline v${baseline.version}, this build reads v${BASELINE_VERSION}).\n` +
        `  Re-checking against it could report findings as fixed that are not. Run ${chalk.cyan("vibedrift scan")} first.`,
    );
    return "stale_baseline";
  }

  const results = await recheckProject({
    rootDir,
    projectHash,
    sessionsDir,
    baseline,
    sessionId: options.sessionId,
    dryRun: options.dryRun,
    now: options.now,
  });

  if (options.json) {
    console.log(JSON.stringify({ rootDir, projectHash, dryRun: options.dryRun === true, sessions: results }, null, 2));
    return results.length === 0 ? "nothing_open" : "ok";
  }

  if (results.length === 0) {
    console.log(`${chalk.green("●")} No open findings to re-check${options.sessionId ? ` for session ${options.sessionId}` : ""}.`);
    return "nothing_open";
  }

  const verb = options.dryRun ? "would clear" : "cleared";
  let totalResolved = 0;
  let totalOpen = 0;
  let totalStale = 0;
  for (const r of results) {
    totalResolved += r.resolved.length;
    totalOpen += r.stillOpen.length;
    totalStale += r.staleAnchors.length;
    console.log(`${chalk.bold(shortId(r.sessionId))}  ${verb} ${r.resolved.length}, still open ${r.stillOpen.length}${r.missingFiles.length ? `, ${r.missingFiles.length} file${r.missingFiles.length === 1 ? "" : "s"} unreadable` : ""}`);
    for (const f of r.resolved) console.log(`  ${chalk.green("✓")} ${f.findingId}  ${f.file}  ${chalk.dim(f.category)}`);
    for (const f of r.stillOpen) console.log(`  ${chalk.dim("○")} ${f.findingId}  ${f.file}  ${chalk.dim(f.category)}`);
    for (const m of r.missingFiles) console.log(`  ${chalk.yellow("?")} ${m}  ${chalk.dim("not readable; left open")}`);
    for (const f of r.staleAnchors)
      console.log(
        `  ${chalk.yellow("?")} ${f.findingId}  ${f.file}  ${chalk.dim("raised by an older build; left open")}`,
      );
  }
  console.log(
    chalk.dim(
      `\n${totalResolved} ${verb} on re-check, ${totalOpen} still open${
        totalStale ? `, ${totalStale} not re-checkable (raised by an older build)` : ""
      }. A re-check clear is recorded as "via recheck" and counted apart from in-loop fixes.${options.dryRun ? " (dry run: nothing written)" : ""}`,
    ),
  );
  return "ok";
}

function shortId(sid: string): string {
  return sid.length > 8 ? sid.slice(0, 8) : sid;
}

export type { RecheckSessionResult };
