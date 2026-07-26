/**
 * vibedrift session-flush: a short-lived, detached child the Stop hook spawns
 * at the end of every agent turn to ship that turn's derived events to the
 * dashboard — so a repo streams live WITHOUT `watch-session` open (the native
 * promise). One-shot: it drains the project's upload backlog to durable offsets
 * and exits.
 *
 * Kept OFF the hook's critical path by design: the Stop hook only spawns this
 * (fast, unref'd) and returns immediately; the network work happens here, out
 * of band. Gated on hosted-sync opt-in + a token — a local-only user spawns
 * nothing. Fail-open in the strong sense: any error exits 0 and loses nothing
 * (durable offsets + idempotent ingest mean the next turn's flush resumes).
 *
 * Only Node built-ins are imported statically so startup stays cheap; the
 * workhorse modules load dynamically inside the guarded run.
 *
 * argv: [node, session-flush.js, <projectHash>, <sessionsDir>]. Both are
 * optional — a missing pair is re-derived from cwd.
 */

/** Absolute ceiling so a hung network can never leave a zombie child. */
const HARD_TIMEOUT_MS = 35_000;

const guard = setTimeout(() => process.exit(0), HARD_TIMEOUT_MS);
guard.unref?.();

async function main(): Promise<void> {
  const [, , argHash, argDir] = process.argv;

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
  const { postSessionIngest } = await import("../auth/api.js");
  const { runUploaderOnce } = await import("./uploader.js");
  await runUploaderOnce({
    sessionsDir,
    projectHash,
    teamIntentOptIn: cfg.sessionsTeamIntentOptIn === true,
    post: (events) => postSessionIngest(token, events, { apiUrl }),
  });
}

main()
  .catch(() => {})
  .finally(() => {
    clearTimeout(guard);
    process.exit(0);
  });
