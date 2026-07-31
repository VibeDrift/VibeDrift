/**
 * vibedrift-hook: the thin session-event entrypoint that agent hooks invoke.
 *
 * Contract (Phase 1, passive only):
 * - reads ONE hook JSON payload from stdin;
 * - normalizes it, masks secrets, appends it to the session ledger;
 * - on edit events, runs the inline drift checks and, when there is an
 *   un-cooled advisory, prints it to stderr and exits 2 (PostToolUse feeds
 *   stderr into the agent's context without blocking the tool);
 * - exits 0 in EVERY other circumstance: malformed input, unknown events,
 *   missing baseline, internal errors, timeout. A hook failure must never
 *   interrupt the user's agent.
 *
 * Only Node built-ins are imported statically, so the self-timeout arms before
 * any heavy module is evaluated; the workhorse modules (ledger, checks, and the
 * baseline loader they pull) are dynamically imported inside the guarded run.
 * This entry deliberately avoids Commander (measured ~1.1s CLI entry vs ~0.2s
 * here). It does transitively pull the baseline loader and the AST function
 * extractor, but the tree-sitter WASM parser is never initialized on this path
 * (no file is parsed), so the cold cost stays ~60-80ms.
 */

import { relative, resolve, isAbsolute, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TrialRecapTotals } from "./trial-recap.js";

const SELF_TIMEOUT_MS = 2000;

// Arm the fail-open guard first, before the dynamic imports below run.
const timer = setTimeout(() => {
  if (process.env.VIBEDRIFT_HOOK_DEBUG === "1") process.stderr.write("[vibedrift-hook] self-timeout\n");
  process.exit(0);
}, SELF_TIMEOUT_MS);

function debug(msg: string): void {
  if (process.env.VIBEDRIFT_HOOK_DEBUG === "1") process.stderr.write(`[vibedrift-hook] ${msg}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Spawn the detached session-flush child (Stop-hook path). Gated on hosted-sync
 * opt-in + a token — a local-only or logged-out user spawns nothing. The child
 * is fully detached and unref'd so it outlives this hook, which returns at once.
 * Fail-open: any error just means no flush (watch-session / the next turn cover
 * delivery). `VIBEDRIFT_SESSION_FLUSH_CMD` is a test seam.
 */
async function maybeSpawnFlush(projectHash: string, sessionsDir: string): Promise<void> {
  try {
    const [{ readConfig }, { shouldSync }] = await Promise.all([
      import("../auth/config.js"),
      import("./uploader.js"),
    ]);
    const cfg = await readConfig();
    if (!shouldSync(cfg, false) || !cfg.token) return;

    const { spawn } = await import("node:child_process");
    // Test seam: an executable path invoked with (projectHash, sessionsDir).
    const override = process.env.VIBEDRIFT_SESSION_FLUSH_CMD;
    const [cmd, args] = override
      ? [override, [projectHash, sessionsDir]]
      : [
          process.execPath,
          [resolve(dirname(fileURLToPath(import.meta.url)), "session-flush.js"), projectHash, sessionsDir],
        ];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // fail-open: no flush spawned
  }
}

async function main(): Promise<number> {
  const raw = await readStdin();
  if (!raw.trim()) return 0;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return 0;
  }

  const [
    { appendEvent, newActivityId, sessionFilePath },
    { normalizeHookPayload },
    { repoIdentity, defaultSessionsDir },
    { runEditChecks },
    { processPrompt, checkScope },
    { recheckFile, detectRevert, readOutcomeState, writeOutcomeState },
  ] = await Promise.all([
    import("./ledger.js"),
    import("./normalize.js"),
    import("./repo.js"),
    import("./check.js"),
    import("./scope.js"),
    import("./outcomes.js"),
  ]);

  const cwd =
    typeof (payload as Record<string, unknown>)?.cwd === "string"
      ? ((payload as Record<string, unknown>).cwd as string)
      : process.cwd();
  const { rootDir, projectHash } = repoIdentity(cwd);

  const normalized = normalizeHookPayload(payload, { projectHash });
  if (!normalized) return 0;

  // Entitlement gate (decision 8): a LOCKED account captures nothing. The check
  // reads a local cache written by `watch-session` — no network on this path.
  // Fail-open: a missing/unreadable cache permits capture.
  const { isCapturePermitted, readEntitlementCache } = await import("./entitlement.js");
  let capturePermitted = isCapturePermitted();

  // Sticky session grant (P0.3): the server burns the final trial fuse on this
  // session's first ingested edit, so a mid-session entitlement refresh can
  // flip the cache to locked while the session it promised is still running.
  // Ledger evidence of THIS session id means capture started under an entitled
  // (or fail-open) read; that session keeps recording to its end. The next
  // session id has no ledger yet and locks normally. An error here means no
  // grant, never an unlock.
  if (!capturePermitted) {
    try {
      if (existsSync(sessionFilePath(defaultSessionsDir(), projectHash, normalized.sid))) {
        capturePermitted = true;
      }
    } catch {
      // stay locked
    }
  }

  // Activation gate (L-N3): an explicit `decline` stops capture entirely; an
  // un-activated (unanswered) repo emits the SessionStart nudge but otherwise
  // captures per the legacy grandfather (a repo only carries these hooks via a
  // deliberate repo-local install, which post-activation records `active`).
  const { loadActivation, projectStatus, consumeAsk } = await import("./activation.js");
  const status = projectStatus(loadActivation(), projectHash, rootDir);
  if (status === "declined") return 0;

  if (
    normalized.type === "session_start" &&
    status === "unanswered" &&
    capturePermitted
  ) {
    const source =
      typeof (payload as Record<string, unknown>).source === "string"
        ? ((payload as Record<string, unknown>).source as string)
        : undefined;
    const { isNewInteractiveSource, isNonInteractive, buildNudgeOutput } = await import("./nudge.js");
    if (isNewInteractiveSource(source) && !isNonInteractive()) {
      const outcome = consumeAsk(projectHash);
      if (outcome.ask) {
        const out = buildNudgeOutput({
          repoName: basename(rootDir),
          entitlement: readEntitlementCache(),
          lastAsk: outcome.budgetExpired,
        });
        process.stdout.write(JSON.stringify(out) + "\n");
      }
    }
  }

  // Trial meter (P0.3): the activated-repo counterpart of the nudge path's
  // trial line, same systemMessage channel, same new-interactive-only budget.
  // Cached entitlement only; an unknown cache emits nothing (never a fabricated
  // count) and Pro never sees a meter (buildTrialLine owns both rules). Guarded
  // so a failure here changes nothing about how the rest of the event is
  // processed (hooks fail open).
  if (normalized.type === "session_start" && status === "active" && capturePermitted) {
    try {
      const source =
        typeof (payload as Record<string, unknown>).source === "string"
          ? ((payload as Record<string, unknown>).source as string)
          : undefined;
      const { isNewInteractiveSource, isNonInteractive, buildTrialLine } = await import("./nudge.js");
      if (isNewInteractiveSource(source) && !isNonInteractive()) {
        const line = buildTrialLine(readEntitlementCache());
        if (line) process.stdout.write(JSON.stringify({ systemMessage: line }) + "\n");
      }
    } catch {
      // fail-open: no meter, capture proceeds untouched
    }
  }

  if (!capturePermitted) {
    // Locked account: capture nothing, but do two things so the paywall is
    // neither invisible nor a one-way door.
    //  1. Say so once per new interactive session. `watch-session` has a full
    //     lock screen; the native path's only user-visible channel is this.
    //  2. Still spawn the Stop flush, which refreshes entitlement — otherwise
    //     a locked machine could never learn it had been upgraded to Pro.
    if (normalized.type === "session_start") {
      const source =
        typeof (payload as Record<string, unknown>).source === "string"
          ? ((payload as Record<string, unknown>).source as string)
          : undefined;
      const { isNewInteractiveSource, isNonInteractive, buildLockNotice } = await import("./nudge.js");
      const ent = readEntitlementCache();
      if (ent && !ent.entitled && isNewInteractiveSource(source) && !isNonInteractive()) {
        // Recap what the trial really caught (P0.3). Real ledger sums only;
        // null falls back to number-free copy inside buildLockNotice. Guarded
        // so a summing failure still delivers the paused notice.
        let totals: TrialRecapTotals | null = null;
        try {
          const { sumLocalLedgerTotals } = await import("./trial-recap.js");
          totals = sumLocalLedgerTotals(defaultSessionsDir());
        } catch {
          // fail-open: recap without numbers
        }
        process.stdout.write(JSON.stringify(buildLockNotice({ entitlement: ent, totals })) + "\n");
      }
    }
    if (normalized.type === "session_end") {
      await maybeSpawnFlush(projectHash, defaultSessionsDir());
    }
    return 0;
  }

  // The in-memory body hand-off must never reach the ledger.
  const { body, ...event } = normalized;

  // Resolve the edited file to a repo-relative path. A relative file_path from
  // the hook is resolved against the repo root; an edit OUTSIDE the repo is not
  // in this repo's baseline, so we record only its basename (never a machine
  // path) and skip the inline check.
  let checkAbsFile: string | null = null;
  if (event.detail.file) {
    const abs = isAbsolute(event.detail.file)
      ? event.detail.file
      : resolve(rootDir, event.detail.file);
    const rel = relative(rootDir, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      event.detail.file = rel;
      checkAbsFile = abs;
    } else {
      event.detail.file = basename(abs);
    }
  }

  const sessionsDir = defaultSessionsDir();
  await appendEvent(sessionsDir, projectHash, event.sid, event);

  // End of a turn (Claude Code fires Stop per response): ship this turn's
  // events so the dashboard streams live WITHOUT watch-session open. The hook
  // stays offline — it only spawns a detached child (fail-open, opt-in gated).
  if (event.type === "session_end") {
    await maybeSpawnFlush(projectHash, sessionsDir);
  }

  // Capture the task intent from prompts; lock it on the first one.
  if (event.type === "user_prompt" && event.detail.promptText) {
    const lock = await processPrompt(sessionsDir, projectHash, event.sid, event.detail.promptText);
    if (lock) await appendEvent(sessionsDir, projectHash, event.sid, lock);
  }

  if (event.type === "edit" && body && event.detail.file) {
    const relFile = event.detail.file;
    let fyi: string | null = null;
    const outcomes = await readOutcomeState(sessionsDir, projectHash, event.sid);

    if (checkAbsFile) {
      const res = await runEditChecks({
        rootDir,
        projectHash,
        sessionId: event.sid,
        sessionsDir,
        file: checkAbsFile,
        body,
      });

      // Finding-scoped resolution: measure each open finding against its own
      // anchored construct in the file's whole current content rather than the
      // edit hunk, so a finding resolves only when the construct it was raised
      // against is gone or has stopped carrying the flagged pattern. Normally
      // that content is read from disk (the post-edit state); when the read
      // fails we fall back to the edit body, which is the whole file for a
      // Write but only the hunk for an Edit, so on that fallback the re-check
      // is best-effort and sees less than the file.
      if (res.baseline) {
        let currentContent = body;
        try {
          currentContent = await readFile(checkAbsFile, "utf8");
        } catch {
          // fall back to the edit body (correct for Write, best-effort for Edit)
        }
        const { resolved } = recheckFile(res.baseline, relFile, currentContent, outcomes.open);
        const resolvedIds = new Set(resolved.map((f) => f.findingId));
        for (const f of resolved) {
          await appendEvent(sessionsDir, projectHash, event.sid, {
            v: event.v, sid: event.sid, aid: newActivityId(), ts: new Date().toISOString(),
            agent: "claude-code", projectHash, channel: "hook", type: "resolve", mode: "passive",
            findingId: f.findingId, detail: { file: f.file, category: f.category }, outcome: "resolved",
          });
        }
        outcomes.open = outcomes.open.filter((f) => !resolvedIds.has(f.findingId));
      }

      // Dedupe: do not re-append a flag whose file|category is already open, and
      // suppress its re-message too (the messaged flag carries res.fyi verbatim).
      let suppressFyi = false;
      for (const flag of res.flags) {
        const key = `${flag.detail.file}|${flag.detail.category}`;
        const already = outcomes.open.some((o) => `${o.file}|${o.category}` === key);
        if (already) {
          if (flag.msgToAgent && flag.msgToAgent === res.fyi) suppressFyi = true;
          continue;
        }
        await appendEvent(sessionsDir, projectHash, event.sid, flag);
        if (flag.findingId && flag.detail.file && flag.detail.category) {
          // The anchor rides in the local sidecar only, never in the event.
          outcomes.open.push({
            findingId: flag.findingId,
            file: flag.detail.file,
            category: flag.detail.category,
            anchor: res.anchors[flag.findingId],
          });
        }
      }
      if (!fyi && !suppressFyi) fyi = res.fyi;
    }

    // Best-effort byte-exact revert: the file restored to an earlier state this
    // session (a formatter changes bytes, so it never false-positives). Out of
    // the resolution rate; recorded as a subtle note.
    if (detectRevert(relFile, body, outcomes.hashes).reverted) {
      await appendEvent(sessionsDir, projectHash, event.sid, {
        v: event.v, sid: event.sid, aid: newActivityId(), ts: new Date().toISOString(),
        agent: "claude-code", projectHash, channel: "hook", type: "recheck", mode: "passive",
        detail: { file: relFile, observed: "reverted to an earlier state" },
      });
    }

    await writeOutcomeState(sessionsDir, projectHash, event.sid, outcomes);

    // Scope drift is independent of the baseline check (fires even on edits
    // outside the size gate or the repo's peer groups).
    const scope = await checkScope(sessionsDir, projectHash, event.sid, relFile, body);
    if (scope.flag) await appendEvent(sessionsDir, projectHash, event.sid, scope.flag);
    if (!fyi && scope.fyi) fyi = scope.fyi;

    if (fyi) {
      process.stderr.write(`${fyi}\n`);
      return 2;
    }
  }

  return 0;
}

main()
  .then((code) => {
    clearTimeout(timer);
    process.exit(code);
  })
  .catch((err: unknown) => {
    clearTimeout(timer);
    debug(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  });
