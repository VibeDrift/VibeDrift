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

import { relative, resolve, isAbsolute, basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TrialRecapTotals } from "./trial-recap.js";
import type { EditCheckOutcome } from "./check.js";
import type { SessionEvent } from "./types.js";
import type { RepoDriftBaseline } from "../core/baseline.js";

const SELF_TIMEOUT_MS = 2000;
/** Wall-time budget for the per-file checks after one Bash call; the rest of
 *  the batch is recorded unchecked. Sized to leave the watchdog headroom for
 *  process start (~80 ms), the baseline read and the ledger writes. */
export const BASH_CHECK_BUDGET_MS = 1200;

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
    { runEditChecks, HOOK_BASELINE_MAX_BYTES },
    { processPrompt, checkScope },
    { recheckFile, detectRevert, readOutcomeState, writeOutcomeState },
    { readHookClock, writeHookClock, changedSourceFiles },
    { loadBaselineUnchecked },
  ] = await Promise.all([
    import("./ledger.js"),
    import("./normalize.js"),
    import("./repo.js"),
    import("./check.js"),
    import("./scope.js"),
    import("./outcomes.js"),
    import("./bash-changes.js"),
    import("../core/baseline.js"),
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
  // path), under an out-of-repo marker, and skip the inline check.
  //
  // The answer is STAMPED on the event (`detail.inRepo`) rather than inferred
  // downstream: consumers that promise "nothing outside this repo" — the opt-in
  // file-name manifest — read the mark, never the path's shape.
  //
  // The recorded path always uses FORWARD slashes, the same normalization the
  // scanner applies to its own relative paths (core/discovery.ts). `relative()`
  // answers "src\payments\refund.ts" on Windows, and a backslash is refused by
  // the wire rules, so without this the file-name manifest stays permanently
  // empty on win32 while `--names on` reports success. This is the ledger's own
  // field and the upload schema hashes exactly this string, so the name and the
  // pseudonym cannot drift apart.
  let checkAbsFile: string | null = null;
  if (event.detail.file) {
    const abs = isAbsolute(event.detail.file)
      ? event.detail.file
      : resolve(rootDir, event.detail.file);
    const rel = relative(rootDir, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      event.detail.file = rel.replace(/\\/g, "/");
      event.detail.inRepo = true;
      checkAbsFile = abs;
    } else {
      // Outside the repo: still only the basename (never a machine path), but
      // marked with a leading "../" so the recorded form CANNOT equal an
      // in-repo path. An in-repo relative path never starts with ".." — that is
      // exactly what sends an edit down this branch — so a repo-ROOT file and
      // an out-of-repo file sharing a basename stay two distinct strings, and
      // therefore two distinct pseudonyms, everywhere the hash is the identity.
      // The marker also makes the path unshareable by construction: a ".."
      // segment is refused by the wire rules on both sides.
      event.detail.file = `../${basename(abs)}`;
      event.detail.inRepo = false;
    }
  }

  const sessionsDir = defaultSessionsDir();

  // The per-session clock the Bash path compares mtimes against. Read the
  // previous stamp, then stamp NOW before any work: every file the tool call
  // that triggered this run wrote already has an earlier mtime, and a
  // self-timeout later in this run must not leave the old stamp behind, or
  // every following Bash call would repeat the same batch and append the same
  // edits again until some other hook event stamped the clock.
  const previousClock = await readHookClock(sessionsDir, projectHash, event.sid);
  const stampMs = Date.now();
  await writeHookClock(sessionsDir, projectHash, event.sid, stampMs, previousClock.recorded);

  /**
   * One in-repo edit, whatever tool made it: run the inline check BEFORE the
   * ledger write so the recorded event carries the check's real outcome (the
   * drift-density denominator counts only edits the check RAN on), append it,
   * then resolve open findings against the file's current content, record new
   * flags (deduped against open ones), note byte-exact reverts, and run the
   * scope check. Returns the one advisory line to message, or null. Stated
   * cost of running the check ahead of the append: a self-timeout firing
   * inside it loses the edit event too; the window is bounded small (the
   * baseline read is stat-capped and the entry gate keeps the warm path in
   * low milliseconds).
   */
  async function processEdit(
    event: SessionEvent,
    body: string | undefined,
    checkAbsFile: string | null,
    loadBaselineFor?: (root: string) => Promise<RepoDriftBaseline | null>,
  ): Promise<string | null> {
    let editCheck: EditCheckOutcome | null = null;
    if (body && checkAbsFile) {
      editCheck = await runEditChecks({
        rootDir,
        projectHash,
        sessionId: event.sid,
        sessionsDir,
        file: checkAbsFile,
        body,
        ...(loadBaselineFor ? { loadBaselineFor } : {}),
      });
    }
    event.detail.checked = editCheck?.checked ?? false;
    await appendEvent(sessionsDir, projectHash, event.sid, event);
    if (!body || !event.detail.file) return null;
    const relFile = event.detail.file;
    let fyi: string | null = null;
    const outcomes = await readOutcomeState(sessionsDir, projectHash, event.sid);

    if (checkAbsFile && editCheck) {
      const res = editCheck;

      // Finding-scoped resolution: measure each open finding against its own
      // anchored construct in the file's whole current content rather than the
      // edit hunk, so a finding resolves only when the construct it was raised
      // against is gone or has stopped carrying the flagged pattern. That
      // content is read from disk (the post-edit state); if the read FAILS we
      // skip resolution entirely and leave the findings open. Falling back to
      // the edit body would run the re-check against only the hunk for an Edit,
      // and an unrelated hunk would false-resolve a finding whose flagged code
      // is untouched on disk (#84). Fail-open, like the rest of this module.
      if (res.baseline) {
        let currentContent: string | undefined;
        try {
          currentContent = await readFile(checkAbsFile, "utf8");
        } catch {
          // read failed — leave currentContent undefined so the re-check is skipped
        }
        if (currentContent !== undefined) {
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
          // Tombstone each resolve so the read-merge-write in writeOutcomeState
          // does not copy the finding back from disk (a resolve is otherwise
          // just an absence from `open`, indistinguishable from never-seen).
          outcomes.resolved.push(...resolvedIds);
        }
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
          // A flag reopens: clear any tombstone carrying this id so the merge
          // does not drop the finding again. The anchor rides in the local
          // sidecar only, never in the event.
          outcomes.resolved = outcomes.resolved.filter((id) => id !== flag.findingId);
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

    return fyi;
  }

  /**
   * After a Bash tool call: the files it changed, checked as if each were an
   * edit. The hook keeps a per-session clock (when its previous run finished);
   * checkable source files with a newer mtime are read from disk and pushed
   * through processEdit with toolName "Bash" and no diffstat (there is no hunk,
   * the whole file is the body). The clock is stamped at the START of every
   * hook run, so only a Bash call that is the first hook event of a session
   * finds none and detects nothing. The baseline is loaded once for the batch.
   *
   * A touched file whose content is byte-identical to the baseline's copy is
   * skipped: a `touch`, or a formatter that changed nothing, moves the mtime
   * without writing anything new, and re-checking an unchanged templated file
   * against the index would flag it as a duplicate of its own siblings. A file
   * whose bytes did change is checked whole, as a Write of it would be.
   */
  async function processBashChanges(
    sid: string,
    v: SessionEvent["v"],
    clock: { lastMs?: number; recorded?: Record<string, number> },
  ): Promise<string | null> {
    if (clock.lastMs === undefined) return null;
    const walk = await changedSourceFiles(rootDir, clock.lastMs);
    // A file the previous Bash run already recorded, at the same mtime, is
    // not an edit again: the mtime slack would otherwise re-detect a file
    // written just before the previous stamp on every quick follow-up call.
    const files = walk.files.filter((rel) => clock.recorded?.[rel] !== walk.mtimes[rel]);
    // Remember what THIS run saw, whatever happens to it below, so the next
    // run can skip it. Best-effort, like the stamp itself.
    const seen: Record<string, number> = {};
    for (const rel of walk.files) seen[rel] = walk.mtimes[rel];
    await writeHookClock(sessionsDir, projectHash, sid, stampMs, seen);
    if (files.length === 0) return null;
    // Time budget for the per-file checks. The walk is cheap (single-digit
    // milliseconds); the checks it feeds are not: measured 65 to 70 ms per
    // file on a 458-entry index and about 180 ms on a 1,600-entry one, so a
    // 20-file batch can outrun the 2s self-timeout. Files past the budget are
    // still recorded, as edits the check did NOT run on (checked: false), so
    // the ledger stays complete and the density denominator stays honest.
    const budgetMs = Number(process.env.VIBEDRIFT_BASH_CHECK_BUDGET_MS ?? BASH_CHECK_BUDGET_MS);
    const batchStart = Date.now();
    let cached: Promise<RepoDriftBaseline | null> | undefined;
    const loadBaselineFor = (root: string): Promise<RepoDriftBaseline | null> =>
      (cached ??= loadBaselineUnchecked(root, HOOK_BASELINE_MAX_BYTES));
    const baseline = await loadBaselineFor(rootDir);
    const knownHash = new Map<string, string>();
    for (const f of baseline?.ctxFiles ?? []) {
      const rel = (isAbsolute(f.path) ? relative(rootDir, f.path) : f.path).replace(/\\/g, "/");
      knownHash.set(rel, f.hash);
    }
    let fyi: string | null = null;
    for (const rel of files) {
      const abs = join(rootDir, rel);
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      if (knownHash.get(rel) === createHash("sha256").update(content).digest("hex")) continue;
      const ev: SessionEvent = {
        v,
        sid,
        aid: newActivityId(),
        ts: new Date().toISOString(),
        agent: "claude-code",
        projectHash,
        channel: "hook",
        type: "edit",
        mode: "passive",
        detail: { file: rel, toolName: "Bash", inRepo: true },
      };
      if (Date.now() - batchStart >= budgetMs) {
        // Over budget: recorded, not checked. Never a fabricated `checked`.
        ev.detail.checked = false;
        await appendEvent(sessionsDir, projectHash, sid, ev);
        continue;
      }
      const f = await processEdit(ev, content, abs, loadBaselineFor);
      if (!fyi && f) fyi = f;
    }
    return fyi;
  }

  let fyi: string | null = null;
  if (event.type === "edit") {
    fyi = await processEdit(event, body, checkAbsFile);
  } else {
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

    if (event.type === "command") {
      fyi = await processBashChanges(event.sid, event.v, previousClock);
    }
  }

  if (fyi) {
    process.stderr.write(`${fyi}\n`);
    return 2;
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
