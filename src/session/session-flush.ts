/**
 * vibedrift session-flush: a short-lived, detached child the Stop hook spawns
 * at the end of every agent turn to ship that turn's derived events to the
 * dashboard — so a repo streams live WITHOUT `watch-session` open (the native
 * promise). One-shot: it drains the project's upload backlog to durable offsets
 * and exits.
 *
 * It drains EVERY project this session touched, not only the repo the turn
 * ended in: an agent working across a workspace of repos (or two worktrees of
 * one repo) wrote several ledgers, and uploading one of them left the rest
 * stranded on disk with no sign they existed. Anything else with a backlog is
 * caught up behind those, newest first and capped (flush-targets.ts).
 *
 * Kept OFF the hook's critical path by design: the Stop hook only spawns this
 * (fast, unref'd) and returns immediately; the network work happens here, out
 * of band. Gated on hosted-sync opt-in + a token — a local-only user spawns
 * nothing. Fail-open in the strong sense: any error exits 0 and loses nothing
 * (durable offsets + idempotent ingest mean the next turn's flush resumes).
 *
 * It also owns the entitlement cache the hook gate reads (see flush-run.ts):
 * the native path has no `watch-session` to refresh it, so the paywall would
 * otherwise never apply. The Stop hook spawns this even when capture is
 * locked, so upgrading to Pro is picked up on the next turn.
 *
 * Only Node built-ins are imported statically so startup stays cheap; the
 * workhorse modules load dynamically inside the guarded run.
 *
 * argv: [node, session-flush.js, <projectHash>, <sessionsDir>, <sessionId>].
 * All three are optional: a missing hash/dir pair is re-derived from cwd, and
 * without a session id the other repos this session touched are simply treated
 * like any other backlog.
 */

/** Absolute ceiling so a hung network can never leave a zombie child. */
const HARD_TIMEOUT_MS = 35_000;
/** Work budget shared by every project this run drains, inside the ceiling so
 *  the guard stays the backstop rather than the mechanism. */
const FLUSH_BUDGET_MS = 30_000;

const guard = setTimeout(() => process.exit(0), HARD_TIMEOUT_MS);
guard.unref?.();

async function main(): Promise<void> {
  const [, , argHash, argDir, argSid] = process.argv;

  const { readConfig } = await import("../auth/config.js");
  const { shouldSync } = await import("./uploader.js");
  const cfg = await readConfig();
  if (!shouldSync(cfg, false) || !cfg.token) return; // local-only / logged out: nothing to do

  let projectHash = argHash;
  let sessionsDir = argDir;
  if (!projectHash || !sessionsDir) {
    const { repoIdentity, defaultSessionsDir } = await import("./repo.js");
    if (!sessionsDir) sessionsDir = defaultSessionsDir();
    if (!projectHash) projectHash = repoIdentity(process.cwd()).projectHash;
  }

  const token = cfg.token;
  const apiUrl = cfg.apiUrl;
  const { postSessionIngest, fetchSessionEntitlement, postSessionNames, deleteSessionNames } =
    await import("../auth/api.js");
  const { vibedriftHome } = await import("../core/vibedrift-home.js");
  const { runFlush } = await import("./flush-run.js");
  const { collectFlushCandidates, orderFlushTargets } = await import("./flush-targets.js");

  // Every repo this session wrote to, the turn's own first. A scan failure
  // degrades to exactly the old behaviour: this project alone.
  const candidates = await collectFlushCandidates(sessionsDir, argSid);
  const targets = orderFlushTargets(candidates, projectHash);

  // One shared wall-clock budget across the targets, inside the hard timeout,
  // so a long backlog cannot make the child outlive its guard. Whatever does
  // not fit is picked up by the next turn — offsets are durable.
  const deadline = Date.now() + FLUSH_BUDGET_MS;
  const baseDir = vibedriftHome();

  for (const hash of targets) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await runFlush({
      baseDir,
      sessionsDir,
      projectHash: hash,
      teamIntentOptIn: cfg.sessionsTeamIntentOptIn === true,
      fetchEntitlement: () => fetchSessionEntitlement(token, { apiUrl }),
      post: (events) => postSessionIngest(token, events, { apiUrl }),
      // Opt-in per repo (default off). runFlush only calls these when this repo's
      // `--names on` flag is set, or when an opt-out deletion is still owed.
      postNames: (names) => postSessionNames(token, hash, names, { apiUrl }),
      deleteNames: () => deleteSessionNames(token, hash, { apiUrl }),
      budgetMs: remaining,
    });
  }
}

main()
  .catch(() => {})
  .finally(() => {
    clearTimeout(guard);
    process.exit(0);
  });
