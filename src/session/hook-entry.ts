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

import { relative, resolve, isAbsolute, basename } from "node:path";
import { readFile } from "node:fs/promises";

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
    { appendEvent, newActivityId },
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
  const { isCapturePermitted } = await import("./entitlement.js");
  if (!isCapturePermitted()) return 0;

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

      // Finding-scoped resolution: re-run the detection over the file's CURRENT
      // full content (read from disk — the post-edit state), not the edit hunk,
      // so a finding resolves only when its own signal is genuinely gone.
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
          outcomes.open.push({ findingId: flag.findingId, file: flag.detail.file, category: flag.detail.category });
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
