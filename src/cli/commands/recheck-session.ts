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
import { loadBaselineUnchecked } from "../../core/baseline.js";
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

export type RecheckSessionStatus = "ok" | "no_baseline" | "nothing_open";

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
  for (const r of results) {
    totalResolved += r.resolved.length;
    totalOpen += r.stillOpen.length;
    console.log(`${chalk.bold(shortId(r.sessionId))}  ${verb} ${r.resolved.length}, still open ${r.stillOpen.length}${r.missingFiles.length ? `, ${r.missingFiles.length} file${r.missingFiles.length === 1 ? "" : "s"} unreadable` : ""}`);
    for (const f of r.resolved) console.log(`  ${chalk.green("✓")} ${f.findingId}  ${f.file}  ${chalk.dim(f.category)}`);
    for (const f of r.stillOpen) console.log(`  ${chalk.dim("○")} ${f.findingId}  ${f.file}  ${chalk.dim(f.category)}`);
    for (const m of r.missingFiles) console.log(`  ${chalk.yellow("?")} ${m}  ${chalk.dim("not readable; left open")}`);
  }
  console.log(
    chalk.dim(
      `\n${totalResolved} ${verb} on re-check, ${totalOpen} still open. A re-check clear is recorded as "via recheck" and counted apart from in-loop fixes.${options.dryRun ? " (dry run: nothing written)" : ""}`,
    ),
  );
  return "ok";
}

function shortId(sid: string): string {
  return sid.length > 8 ? sid.slice(0, 8) : sid;
}

export type { RecheckSessionResult };
