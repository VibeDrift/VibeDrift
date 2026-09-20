/**
 * vibedrift-hook, the workhorse: everything the session hook does once its
 * stdin payload is in hand. Two callers:
 *   - src/session/hook-entry.ts, the thin entry a repo-local install and the
 *     plugin's global-install fast path run (it arms the fail-open watchdog
 *     first, then imports this module);
 *   - the CLI's hidden `session-hook` subcommand, the plugin's fallback when
 *     no global install exists (`npx -y @vibedrift/cli session-hook`).
 * Still fail-open by contract: every path here returns 0 except the one that
 * delivers an advisory (2). Callers own process.exit.
 */

import { relative, resolve, isAbsolute, basename, dirname, join, sep } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TrialRecapTotals } from "./trial-recap.js";
import type { EditCheckOutcome } from "./check.js";
import type { SessionEvent } from "./types.js";
import type { RepoDriftBaseline } from "../core/baseline.js";

/** Wall-time budget for the per-file checks after one Bash call; the rest of
 *  the batch is recorded unchecked. Sized to leave the watchdog headroom for
 *  process start (~80 ms), the baseline read and the ledger writes. */
export const BASH_CHECK_BUDGET_MS = 1200;

/**
 * One repo a session records into.
 *
 * The WORKSPACE is the session's own folder. Every other scope is a repo that
 * owns a file the agent edited, and carries `workspaceKey` so one sitting's
 * repos can be read back as one sitting. Everything keyed per project — the
 * ledger, the baseline, the overlay index, the open findings, the advisory
 * cooldown, the file-name manifest — is keyed on the scope, never on the folder
 * the agent happened to start in.
 */
/** A repo folder name we are willing to put on the wire: no separator, no
 *  control or format characters, bounded. Mirrors the wire's own rule in
 *  upload-schema.ts, and a name that fails it is simply not sent. */
const PROJECT_NAME_SHAPE = /^[^/\\\p{C}]{1,64}$/u;

interface Scope {
  rootDir: string;
  projectHash: string;
  /** The workspace's project hash, set only when this scope is NOT the
   *  workspace. An opaque id, never a path. */
  workspaceKey?: string;
}

/** Does this repo carry its own repo-local hook install? The marker is the
 *  `#vibedrift-hook` comment the installer writes and uninstall keys on, read
 *  straight from the settings file (cheap, no JSON parse needed).
 *
 *  Two callers, both of which only ever get MORE conservative on a read error:
 *  the plugin yield (a false positive means one fewer capture path) and the
 *  legacy grandfather for an unanswered repo (a false negative means it is not
 *  captured). */
async function hasRepoLocalInstall(root: string): Promise<boolean> {
  try {
    const local = await readFile(join(root, ".claude", "settings.local.json"), "utf8");
    return local.includes("#vibedrift-hook");
  } catch {
    return false;
  }
}

/**
 * Spawn the detached session-flush child (Stop-hook path). Gated on hosted-sync
 * opt-in + a token — a local-only or logged-out user spawns nothing. The child
 * is fully detached and unref'd so it outlives this hook, which returns at once.
 * Fail-open: any error just means no flush (watch-session / the next turn cover
 * delivery). `VIBEDRIFT_SESSION_FLUSH_CMD` is a test seam.
 */
async function maybeSpawnFlush(
  projectHash: string,
  sessionsDir: string,
  sessionId?: string,
): Promise<void> {
  try {
    const [{ readConfig }, { shouldSync }] = await Promise.all([
      import("../auth/config.js"),
      import("./uploader.js"),
    ]);
    const cfg = await readConfig();
    if (!shouldSync(cfg, false) || !cfg.token) return;

    const { spawn } = await import("node:child_process");
    // Test seam: an executable path invoked with (projectHash, sessionsDir,
    // sessionId). The id lets the child drain the OTHER repos this session
    // wrote to first (session/flush-targets.ts).
    const sidArgs = sessionId ? [sessionId] : [];
    const override = process.env.VIBEDRIFT_SESSION_FLUSH_CMD;
    const [cmd, args] = override
      ? [override, [projectHash, sessionsDir, ...sidArgs]]
      : [
          process.execPath,
          // Every bundle entry lives one level under dist/ (cli/, session/), so
          // the sibling-tree math holds whether this module was inlined into the
          // hook entry or into the CLI (the `session-hook` subcommand).
          [
            resolve(dirname(fileURLToPath(import.meta.url)), "..", "session", "session-flush.js"),
            projectHash,
            sessionsDir,
            ...sidArgs,
          ],
        ];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // fail-open: no flush spawned
  }
}

/** Minimum spacing between background baseline rebuilds for one repo. */
export const REBUILD_MIN_INTERVAL_MS = 10 * 60_000;

/** Repos one turn may hand the background builder. A full scan is seconds of
 *  work per repo and the child runs them one after another, so a session that
 *  touched a dozen repos learns them over a few turns rather than in one burst.
 *  Repos left out keep no stamp, so they are first in line next turn. */
export const MAX_REBUILD_TARGETS = 4;

/**
 * Spawn ONE detached baseline builder at Stop for the repos this session
 * touched that need one. A repo qualifies on either count:
 *
 *   - it has NO persisted baseline. Nothing in that repo could be checked this
 *     session (the inline check needs a baseline and says so honestly), and
 *     with the old rule — rebuild only when the session's overlay is non-empty
 *     — it never would be, because the overlay is only written by a check that
 *     ran. That is the loop this breaks: the first session in a repo records
 *     unchecked edits, the builder learns its patterns while the turn ends, and
 *     the next session is checked without anyone running a scan.
 *   - its persisted baseline never saw what this session wrote (the overlay
 *     sidecar for that repo is non-empty) — the original stale-baseline case.
 *
 * Either way the work is a full scan run out of process
 * (src/session/baseline-rebuild.ts), so the hook returns at once, and each repo
 * keeps its own interval stamp. Fail-open: any error means no rebuild.
 * `VIBEDRIFT_BASELINE_REBUILD_CMD` is a test seam (invoked with the roots).
 */
async function maybeSpawnBaselineRebuild(
  scopes: ReadonlyArray<{ rootDir: string; projectHash: string }>,
  sessionsDir: string,
  sid: string,
): Promise<void> {
  try {
    const [{ readOverlay }, { safeSegment }, { baselineCachePath }] = await Promise.all([
      import("./overlay.js"),
      import("./ledger.js"),
      import("../core/baseline.js"),
    ]);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const now = Date.now();
    const roots: string[] = [];
    /** Does this scope CONTAIN another repo this session recorded into? */
    const holdsAnother = (root: string): boolean =>
      scopes.some((s) => s.rootDir !== root && s.rootDir.startsWith(root + sep));

    for (const scope of scopes) {
      if (roots.length >= MAX_REBUILD_TARGETS) break;
      const hasBaseline = existsSync(baselineCachePath(scope.rootDir));
      // A workspace folder that holds the repos the session edited is a
      // container, not a project waiting to be learned: scanning it would scan
      // every repo inside it again, which on a folder of checkouts is minutes
      // of work for an index nothing wants. Its own loose files stay recorded
      // and honestly marked unchecked. If such a folder ever gets a baseline
      // deliberately (someone ran a scan on it), the stale arm below still
      // keeps it fresh, exactly as before.
      if (!hasBaseline && holdsAnother(scope.rootDir)) continue;
      const overlay = await readOverlay(sessionsDir, scope.projectHash, sid);
      if (hasBaseline && overlay.files.size === 0) continue;
      const stampPath = join(sessionsDir, safeSegment(scope.projectHash), "baseline-rebuild.json");
      let lastMs = 0;
      try {
        const parsed = JSON.parse(await readFile(stampPath, "utf8")) as { lastMs?: unknown };
        if (typeof parsed.lastMs === "number") lastMs = parsed.lastMs;
      } catch {
        // never rebuilt
      }
      if (now - lastMs < REBUILD_MIN_INTERVAL_MS) continue;
      await mkdir(join(sessionsDir, safeSegment(scope.projectHash)), { recursive: true, mode: 0o700 });
      await writeFile(stampPath, JSON.stringify({ lastMs: now }), { mode: 0o600 });
      roots.push(scope.rootDir);
    }
    if (roots.length === 0) return;

    const { spawn } = await import("node:child_process");
    const override = process.env.VIBEDRIFT_BASELINE_REBUILD_CMD;
    const [cmd, args] = override
      ? [override, roots]
      : [
          process.execPath,
          [resolve(dirname(fileURLToPath(import.meta.url)), "..", "session", "baseline-rebuild.js"), ...roots],
        ];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // fail-open: no rebuild
  }
}

/**
 * The whole hook, as a function of the raw stdin payload and the hook's argv.
 * `--source=plugin` marks a run the Claude Code plugin's hooks/hooks.json
 * started (see hooks/vibedrift-hook): those hooks exist in every repo where
 * the plugin is enabled, so this function enforces two things the repo-local
 * installer used to guarantee by construction:
 *   1. a repo the user never activated is NOT captured (only the SessionStart
 *      nudge may speak), and
 *   2. a repo that also carries the repo-local install is not captured twice:
 *      the repo-local hook owns it and the plugin run yields.
 * A repo-local install never passes the flag, so its behaviour is unchanged.
 */
export async function runHook(raw: string, argv: string[] = []): Promise<number> {
  if (!raw.trim()) return 0;
  const pluginMode = argv.includes("--source=plugin");

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return 0;
  }

  const [
    { appendEvent, newActivityId, sessionFilePath },
    { normalizeHookPayload },
    { repoIdentity, repoOwningFile, defaultSessionsDir, hashRepoKey, repoKey },
    { runEditChecks, HOOK_BASELINE_MAX_BYTES },
    { processPrompt, checkScope },
    { recheckFile, detectRevert, readOutcomeState, writeOutcomeState },
    { readHookClock, writeHookClock, changedSourceFiles },
    { loadBaselineUnchecked },
    { readSessionScopes, recordSessionScope },
  ] = await Promise.all([
    import("./ledger.js"),
    import("./normalize.js"),
    import("./repo.js"),
    import("./check.js"),
    import("./scope.js"),
    import("./outcomes.js"),
    import("./bash-changes.js"),
    import("../core/baseline.js"),
    import("./scopes.js"),
  ]);

  const cwd =
    typeof (payload as Record<string, unknown>)?.cwd === "string"
      ? ((payload as Record<string, unknown>).cwd as string)
      : process.cwd();
  // The session's own folder is the WORKSPACE: the scope every non-edit event
  // belongs to (a prompt has no file, so it has no repo of its own), the scope
  // that holds files belonging to no repo, and the key that ties one sitting's
  // repos together. An EDIT belongs to the repo that owns the edited file,
  // which is often a different one — see scopeForFile below.
  const workspace: Scope = repoIdentity(cwd);
  const workspaceRoot = workspace.rootDir;
  const workspaceHash = workspace.projectHash;

  const normalized = normalizeHookPayload(payload, { projectHash: workspaceHash });
  if (!normalized) return 0;

  // Plugin run in a repo that also has the repo-local install: yield. The
  // marker is the same `#vibedrift-hook` comment the installer writes and
  // uninstall keys on, read straight from the settings file (cheap, no JSON
  // parse needed; a false positive here only means one fewer capture path).
  if (pluginMode) {
    if (await hasRepoLocalInstall(workspaceRoot)) return 0;
  }

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
      if (existsSync(sessionFilePath(defaultSessionsDir(), workspaceHash, normalized.sid))) {
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
  const { loadActivation, projectStatus, consumeAsk, resolveGrantPath } = await import("./activation.js");
  const activation = loadActivation();
  const workspaceStatus = projectStatus(activation, workspaceHash, workspaceRoot);
  // A decline on the folder the agent is RUNNING in stops the whole run, not
  // just that folder's own scope. The per-repo rule below judges each other
  // repo on its own answer, but "not here" typed in the working folder is the
  // most visible no a person can give, and it is not worth reinterpreting as
  // "not here, but everywhere else you reach from here".
  if (workspaceStatus === "declined") return 0;

  if (
    normalized.type === "session_start" &&
    workspaceStatus === "unanswered" &&
    capturePermitted
  ) {
    const source =
      typeof (payload as Record<string, unknown>).source === "string"
        ? ((payload as Record<string, unknown>).source as string)
        : undefined;
    const { isNewInteractiveSource, isNonInteractive, buildNudgeOutput } = await import("./nudge.js");
    if (isNewInteractiveSource(source) && !isNonInteractive()) {
      const outcome = consumeAsk(workspaceHash);
      if (outcome.ask) {
        // The folder to offer first. A repo sits in the folder a person keeps
        // their work in, so that is the parent; a working folder that is not a
        // repo IS the folder, and offering its parent would reach past what the
        // agent is even working on. resolveGrantPath is the same validator the
        // CLI uses, so $HOME, anything above it and a filesystem root are
        // refused here exactly as they are there — and a refusal simply means
        // the ask is about this repo alone, as it always was.
        let grantDir: string | null = null;
        try {
          const candidate = existsSync(join(workspaceRoot, ".git"))
            ? dirname(workspaceRoot)
            : workspaceRoot;
          grantDir = resolveGrantPath(candidate);
        } catch {
          // not grantable: offer this repo only
        }
        const out = buildNudgeOutput({
          repoName: basename(workspaceRoot),
          entitlement: readEntitlementCache(),
          lastAsk: outcome.budgetExpired,
          grantDir,
        });
        process.stdout.write(JSON.stringify(out) + "\n");
      }
    }
  }

  // Plugin run in a repo nobody activated: the nudge above may have spoken, and
  // the WORKSPACE scope captures nothing. This is no longer a whole-run return:
  // an edit that belongs to a repo of its own is judged on THAT repo's consent
  // below, so a granted repo under an un-activated folder still records.
  // (A repo-local install keeps the legacy grandfather.)
  const workspaceCaptures = !(pluginMode && workspaceStatus === "unanswered");

  // Trial meter (P0.3): the activated-repo counterpart of the nudge path's
  // trial line, same systemMessage channel, same new-interactive-only budget.
  // Cached entitlement only; an unknown cache emits nothing (never a fabricated
  // count) and Pro never sees a meter (buildTrialLine owns both rules). Guarded
  // so a failure here changes nothing about how the rest of the event is
  // processed (hooks fail open).
  if (normalized.type === "session_start" && workspaceStatus === "active" && capturePermitted) {
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
      await maybeSpawnFlush(workspaceHash, defaultSessionsDir(), normalized.sid);
    }
    return 0;
  }

  // The in-memory body hand-off must never reach the ledger.
  const { body, ...event } = normalized;

  const sessionsDir = defaultSessionsDir();

  // ---- scopes: which repo owns which event --------------------------------

  /** The repo that owns a file: its own nearest `.git` ancestor. A file that
   *  belongs to no repo at all stays with the workspace, which is also where an
   *  edit landed before this existed — the difference is that an edit in a repo
   *  of its own now goes to THAT repo instead of being recorded against the
   *  folder the agent happened to start in and measured against its patterns. */
  const scopeCache = new Map<string, Scope>();
  const scopeForFile = (absFile: string): Scope => {
    const cached = scopeCache.get(absFile);
    if (cached) return cached;
    const owner = repoOwningFile(absFile);
    const scope: Scope =
      !owner || owner.rootDir === workspaceRoot ? workspace : { ...owner, workspaceKey: workspaceHash };
    scopeCache.set(absFile, scope);
    return scope;
  };

  /**
   * Does this scope record? The workspace keeps the answer the gates above
   * worked out. Any other repo is judged on ITS OWN consent, which is the whole
   * point of resolving the repo per file: a repo covered by a directory grant
   * records, a repo where someone typed `vibedrift decline` records nothing even
   * inside a granted workspace, and a repo nobody has answered for records only
   * under the legacy grandfather — it carries a repo-local hook install of its
   * own, which is a deliberate act.
   *
   * One inheritance, deliberately: a repo NESTED INSIDE the active repo the
   * agent is running in is covered by that same yes. A vendored checkout, a
   * submodule or an example app under a project someone activated is part of
   * the project they activated — asking again per nested checkout would be a
   * question about their own tree, and staying silent would quietly drop edits
   * this hook used to record. An explicit `decline` on the nested repo still
   * wins, because it is judged before this.
   */
  const captureCache = new Map<string, boolean>();
  const nestedInWorkspace = (rootDir: string): boolean =>
    rootDir === workspaceRoot || rootDir.startsWith(workspaceRoot + sep);
  const scopeCaptures = async (scope: Scope): Promise<boolean> => {
    if (scope.projectHash === workspaceHash) return workspaceCaptures;
    const known = captureCache.get(scope.projectHash);
    if (known !== undefined) return known;
    const st = projectStatus(activation, scope.projectHash, scope.rootDir);
    const ok =
      st === "declined"
        ? false
        : st === "active"
          ? true
          : (workspaceStatus === "active" && nestedInWorkspace(scope.rootDir)) ||
            (await hasRepoLocalInstall(scope.rootDir));
    captureCache.set(scope.projectHash, ok);
    return ok;
  };

  /**
   * A scope's two labels, worked out once per process.
   *
   * `projectName` is the repo's own folder name, and nothing more: it exists so
   * a repo nobody has scanned still reads as itself on the dashboard instead of
   * as a hash. `repoKey` is that repo's identity across checkouts, hashed so it
   * stays opaque on the wire — two worktrees of one repo carry the same one and
   * can be grouped, without it ever becoming the id that keys anything, which
   * would re-salt every file pseudonym already uploaded.
   *
   * `repoKey()` shells out to git, so the cache matters: it runs at most once
   * per repo per hook call, and never on the path of an edit that is not
   * recorded.
   */
  const labelCache = new Map<string, { repoKey?: string; projectName?: string }>();
  const scopeLabel = (scope: Scope): { repoKey?: string; projectName?: string } => {
    const cached = labelCache.get(scope.projectHash);
    if (cached) return cached;
    let label: { repoKey?: string; projectName?: string } = {};
    try {
      const name = basename(scope.rootDir);
      label = {
        repoKey: hashRepoKey(repoKey(scope.rootDir)),
        ...(PROJECT_NAME_SHAPE.test(name) ? { projectName: name } : {}),
      };
    } catch {
      // fail-open: an unlabelled scope is still a recorded scope
    }
    labelCache.set(scope.projectHash, label);
    return label;
  };

  /** Remember, once per scope per process, that this session wrote into that
   *  repo. The Stop hook reads it to learn the patterns of every repo the
   *  session touched; it is local state beside the ledgers and never uploaded
   *  (session/scopes.ts). */
  const noted = new Set<string>();
  const noteScope = async (scope: Scope): Promise<void> => {
    if (noted.has(scope.projectHash)) return;
    noted.add(scope.projectHash);
    await recordSessionScope(sessionsDir, workspaceHash, event.sid, {
      projectHash: scope.projectHash,
      rootDir: scope.rootDir,
    });
  };

  /** Append one event to the ledger of the scope that owns it, stamping that
   *  scope's identity on the way through. The ledger directory and the event's
   *  own `projectHash` can never disagree, because both are set here. */
  const record = async (scope: Scope, ev: SessionEvent): Promise<void> => {
    ev.projectHash = scope.projectHash;
    if (scope.workspaceKey) ev.workspaceKey = scope.workspaceKey;
    const label = scopeLabel(scope);
    if (label.repoKey) ev.repoKey = label.repoKey;
    if (label.projectName) ev.projectName = label.projectName;
    await appendEvent(sessionsDir, scope.projectHash, ev.sid, ev);
    await noteScope(scope);
  };

  // The per-session clock the Bash path compares mtimes against. Read the
  // previous stamp, then stamp NOW before any work: every file the tool call
  // that triggered this run wrote already has an earlier mtime, and a
  // self-timeout later in this run must not leave the old stamp behind, or
  // every following Bash call would repeat the same batch and append the same
  // edits again until some other hook event stamped the clock.
  //
  // Session-scoped on purpose (the workspace's hash, not the edited file's
  // repo): it records when this HOOK last ran and what its walk of the
  // workspace already saw, both of which are properties of the sitting rather
  // than of any one repo.
  const previousClock = await readHookClock(sessionsDir, workspaceHash, event.sid);
  const stampMs = Date.now();
  await writeHookClock(sessionsDir, workspaceHash, event.sid, stampMs, previousClock.recorded);

  // Resolve the edited file to a path relative to the repo that OWNS it. A
  // relative file_path from the hook is resolved against the agent's own repo
  // root first, since that is what it is relative to. A file inside no repo at
  // all is not in the workspace's baseline either, so we record only its
  // basename (never a machine path), under an out-of-repo marker, and skip the
  // inline check.
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
  let editScope: Scope = workspace;
  let checkAbsFile: string | null = null;
  if (event.detail.file) {
    const abs = isAbsolute(event.detail.file)
      ? event.detail.file
      : resolve(workspaceRoot, event.detail.file);
    editScope = scopeForFile(abs);
    const rel = relative(editScope.rootDir, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      event.detail.file = rel.replace(/\\/g, "/");
      event.detail.inRepo = true;
      checkAbsFile = abs;
    } else {
      // Outside every repo: still only the basename (never a machine path), but
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
    scope: Scope,
    event: SessionEvent,
    body: string | undefined,
    checkAbsFile: string | null,
    loadBaselineFor?: (root: string) => Promise<RepoDriftBaseline | null>,
  ): Promise<string | null> {
    let editCheck: EditCheckOutcome | null = null;
    if (body && checkAbsFile) {
      editCheck = await runEditChecks({
        rootDir: scope.rootDir,
        projectHash: scope.projectHash,
        sessionId: event.sid,
        sessionsDir,
        file: checkAbsFile,
        body,
        ...(loadBaselineFor ? { loadBaselineFor } : {}),
      });
    }
    event.detail.checked = editCheck?.checked ?? false;
    // An edit with no body to check (a delete, a tool shape we do not read) is
    // out of the check's reach rather than blocked by a repo state, so it says
    // so plainly instead of borrowing one of the repo-state reasons.
    const skipReason = editCheck ? editCheck.reason : ("out_of_repo" as const);
    if (!event.detail.checked && skipReason) event.checkReason = skipReason;
    await record(scope, event);
    if (!body || !event.detail.file) return null;
    const relFile = event.detail.file;
    let fyi: string | null = editCheck?.notice ?? null;
    const outcomes = await readOutcomeState(sessionsDir, scope.projectHash, event.sid);

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
            await record(scope, {
              v: event.v, sid: event.sid, aid: newActivityId(), ts: new Date().toISOString(),
              agent: "claude-code", projectHash: scope.projectHash, channel: "hook", type: "resolve",
              mode: "passive", findingId: f.findingId,
              detail: { file: f.file, category: f.category }, outcome: "resolved",
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
        await record(scope, flag);
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
      await record(scope, {
        v: event.v, sid: event.sid, aid: newActivityId(), ts: new Date().toISOString(),
        agent: "claude-code", projectHash: scope.projectHash, channel: "hook", type: "recheck",
        mode: "passive", detail: { file: relFile, observed: "reverted to an earlier state" },
      });
    }

    await writeOutcomeState(sessionsDir, scope.projectHash, event.sid, outcomes);

    // Scope drift is independent of the baseline check (fires even on edits
    // outside the size gate or the repo's peer groups). The flag belongs to the
    // repo that owns the file; the intent it is measured against belongs to the
    // sitting, so the state lives under the workspace (see checkScope).
    const scopeDrift = await checkScope(
      sessionsDir, scope.projectHash, event.sid, relFile, body, workspaceHash,
    );
    if (scopeDrift.flag) await record(scope, scopeDrift.flag);
    if (!fyi && scopeDrift.fyi) fyi = scopeDrift.fyi;

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
    const walk = await changedSourceFiles(workspaceRoot, clock.lastMs);
    // A file the previous Bash run already recorded, at the same mtime, is
    // not an edit again: the mtime slack would otherwise re-detect a file
    // written just before the previous stamp on every quick follow-up call.
    const files = walk.files.filter((rel) => clock.recorded?.[rel] !== walk.mtimes[rel]);
    // Remember what THIS run saw, whatever happens to it below, so the next
    // run can skip it. Best-effort, like the stamp itself. Keyed on the walk's
    // own root (the workspace), which is what these paths are relative to.
    const seen: Record<string, number> = {};
    for (const rel of walk.files) seen[rel] = walk.mtimes[rel];
    await writeHookClock(sessionsDir, workspaceHash, sid, stampMs, seen);
    if (files.length === 0) return null;
    // Time budget for the per-file checks. The walk is cheap (single-digit
    // milliseconds); the checks it feeds are not: measured 65 to 70 ms per
    // file on a 458-entry index and about 180 ms on a 1,600-entry one, so a
    // 20-file batch can outrun the 2s self-timeout. Files past the budget are
    // still recorded, as edits the check did NOT run on (checked: false), so
    // the ledger stays complete and the density denominator stays honest.
    const budgetMs = Number(process.env.VIBEDRIFT_BASH_CHECK_BUDGET_MS ?? BASH_CHECK_BUDGET_MS);
    const batchStart = Date.now();
    // One batch can span several repos (a workspace walk descends into every
    // checkout under it), so the baseline and its file digests are cached PER
    // REPO rather than once for the batch.
    const cached = new Map<string, Promise<RepoDriftBaseline | null>>();
    const loadBaselineFor = (root: string): Promise<RepoDriftBaseline | null> => {
      let p = cached.get(root);
      if (!p) {
        p = loadBaselineUnchecked(root, HOOK_BASELINE_MAX_BYTES);
        cached.set(root, p);
      }
      return p;
    };
    const digests = new Map<string, Map<string, string>>();
    const knownHashesFor = async (root: string): Promise<Map<string, string>> => {
      const hit = digests.get(root);
      if (hit) return hit;
      const baseline = await loadBaselineFor(root);
      const byRel = new Map<string, string>();
      for (const f of baseline?.ctxFiles ?? []) {
        const rel = (isAbsolute(f.path) ? relative(root, f.path) : f.path).replace(/\\/g, "/");
        byRel.set(rel, f.hash);
      }
      digests.set(root, byRel);
      return byRel;
    };
    let fyi: string | null = null;
    for (const rel of files) {
      const abs = join(workspaceRoot, rel);
      const scope = scopeForFile(abs);
      if (!(await scopeCaptures(scope))) continue;
      const scopeRel = relative(scope.rootDir, abs).replace(/\\/g, "/");
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (!content.trim()) continue;
      const knownHash = await knownHashesFor(scope.rootDir);
      if (knownHash.get(scopeRel) === createHash("sha256").update(content).digest("hex")) continue;
      const ev: SessionEvent = {
        v,
        sid,
        aid: newActivityId(),
        ts: new Date().toISOString(),
        agent: "claude-code",
        projectHash: scope.projectHash,
        channel: "hook",
        type: "edit",
        mode: "passive",
        detail: { file: scopeRel, toolName: "Bash", inRepo: true },
      };
      if (Date.now() - batchStart >= budgetMs) {
        // Over budget: recorded, not checked. Never a fabricated `checked`.
        ev.detail.checked = false;
        await record(scope, ev);
        continue;
      }
      const f = await processEdit(scope, ev, content, abs, loadBaselineFor);
      if (!fyi && f) fyi = f;
    }
    return fyi;
  }

  let fyi: string | null = null;
  if (event.type === "edit") {
    // The repo that owns the file decides whether this edit is recorded at all.
    if (await scopeCaptures(editScope)) fyi = await processEdit(editScope, event, body, checkAbsFile);
  } else {
    // Everything that is not an edit belongs to the sitting, so it belongs to
    // the workspace: a prompt has no file and therefore no repo of its own.
    if (workspaceCaptures) await record(workspace, event);

    // End of a turn (Claude Code fires Stop per response): ship this turn's
    // events so the dashboard streams live WITHOUT watch-session open. The hook
    // stays offline — it only spawns a detached child (fail-open, opt-in gated).
    if (event.type === "session_end") {
      // Both children cover every repo this session touched, not just the
      // workspace: the flush keys on the session id (flush-targets.ts) and the
      // builder reads the session's own scope index.
      await maybeSpawnFlush(workspaceHash, sessionsDir, event.sid);
      const touched = await readSessionScopes(sessionsDir, workspaceHash, event.sid);
      await maybeSpawnBaselineRebuild(touched, sessionsDir, event.sid);
    }

    // Capture the task intent from prompts; lock it on the first one.
    if (event.type === "user_prompt" && event.detail.promptText && workspaceCaptures) {
      const lock = await processPrompt(sessionsDir, workspaceHash, event.sid, event.detail.promptText);
      if (lock) await record(workspace, lock);
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
