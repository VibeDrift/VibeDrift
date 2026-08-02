/**
 * `vibedrift watch-session` — Drift Sessions (preview): install / uninstall /
 * status for the agent hooks that record a session ledger, and (the default
 * action) follow the live event tape until Ctrl-C.
 *
 * The capture path (the hook + the ledger) stays local. This command itself,
 * being the resident viewer, resolves session entitlement from the server on
 * start and counts a trial session — that is the only network on this surface,
 * and it is off the hook's hot path.
 */

import readline from "readline";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { repoIdentity, repoKey, defaultSessionsDir } from "../../session/repo.js";
import {
  installHooks,
  uninstallHooks,
  hooksStatus,
  resolveHookCommand,
  detectClaudeCode,
} from "../../session/install.js";
import {
  recordAnswer,
  setShareFileNames,
  setNamesDeletePending,
  loadActivation,
  recordNameShare,
  nameShareHashes,
  forgetNameShare,
} from "../../session/activation.js";
import { clearUploadedNames } from "../../session/file-names.js";
import { appendConsentReceipt } from "../../session/consent.js";
import { vibedriftHome } from "../../core/vibedrift-home.js";
import { runLiveTape } from "../../session/live.js";
import { runUploader, shouldSync } from "../../session/uploader.js";
import { parseJsonlLines } from "../../session/ledger.js";
import { summarize } from "../../session/summary.js";
import { readConfig, patchConfig } from "../../auth/config.js";
import { postSessionIngest, type SessionIngestResponse } from "../../auth/api.js";
import type { UploadEvent } from "../../session/upload-schema.js";

interface UploadPlan {
  /** Returns the server ack so the uploader can commit durable offsets
   *  contiguously (frozen wire contract v1); throws VibeDriftApiError(402)
   *  when the whole batch is entitlement-locked. */
  post: (events: UploadEvent[]) => Promise<SessionIngestResponse>;
  teamIntentOptIn: boolean;
}
import {
  computeEntitlement,
  writeEntitlementCache,
  readEntitlementCache,
  entitlementDir,
  type SessionEntitlement,
} from "../../session/entitlement.js";

export interface WatchSessionOptions {
  uninstall?: boolean;
  status?: boolean;
  yes?: boolean;
  /** After ensuring hooks are installed, follow the live event tape until SIGINT.
   *  The CLI sets this true by default; omit it (as tests do) to just install. */
  watch?: boolean;
  /** Toggle hosted sync (Phase 5): "on" opts into derived-only upload, "off"
   *  disables it. A standalone control — sets config and returns. */
  sync?: "on" | "off";
  /** Toggle the opt-in file-name manifest for THIS repo: "on" shares
   *  repo-relative paths (never contents) so the dashboard can name files,
   *  "off" deletes what was uploaded and stops future uploads. */
  names?: "on" | "off";
  /** Test seam: perform the server-side name deletion for ONE project hash
   *  (default: the API). Called once per hash this repo has uploaded under. */
  deleteNames?: (projectHash: string) => Promise<{ deleted?: number }>;
  /** Force hosted sync off for THIS run regardless of the saved setting. */
  localOnly?: boolean;
  /** Test seam: inject config instead of reading ~/.vibedrift (bypasses network). */
  loadConfig?: () => Promise<{ sessionsSyncEnabled?: boolean; sessionsTeamIntentOptIn?: boolean; token?: string; apiUrl?: string }>;
  /** Test/advanced seams; default to the real locations. */
  sessionsDir?: string;
  hookCommand?: string;
  homeDir?: string;
  /** Root of the activation store (default vibedriftHome()). */
  activationHome?: string;
  confirm?: (question: string) => Promise<boolean>;
  /** Inject the resolved entitlement (bypasses the network); tests use this.
   *  Return null to simulate "login required". */
  resolveEntitlement?: () => Promise<SessionEntitlement | null>;
  /** dir for the entitlement cache (default ~/.vibedrift). */
  entitlementDir?: string;
  /** called (fire-and-forget) to count a trial session server-side. */
  onConsumeTrial?: (sessionId: string) => void;
}

export type WatchSessionStatus =
  | "installed"
  | "already"
  | "uninstalled"
  | "not_installed"
  | "status"
  | "no_agent"
  | "declined"
  | "locked"
  | "login_required"
  | "sync_updated"
  | "names_updated"
  | "aborted_unparseable";

async function askConsent(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runWatchSession(
  targetPath: string,
  options: WatchSessionOptions,
): Promise<WatchSessionStatus> {
  const { rootDir, projectHash } = repoIdentity(resolve(targetPath));
  const sessionsDir = options.sessionsDir ?? defaultSessionsDir();
  const home = options.homeDir ?? homedir();
  const installOpts = {
    hookCommand: options.hookCommand ?? resolveHookCommand(),
    sessionsDir,
    projectHash,
  };
  const ledgerDir = join(sessionsDir, projectHash);

  if (options.status) {
    const s = await hooksStatus(rootDir);
    console.log(
      s.installed
        ? `${chalk.green("●")} Drift Sessions hooks installed (${s.file})`
        : `${chalk.dim("○")} Drift Sessions hooks not installed`,
    );
    console.log(chalk.dim(`  session ledger: ${ledgerDir}`));
    return "status";
  }

  if (options.uninstall) {
    const res = await uninstallHooks(rootDir, installOpts);
    if (res.status === "not_installed") {
      console.log("Drift Sessions hooks were not installed; nothing to remove.");
      return "not_installed";
    }
    if (res.status === "aborted_unparseable") {
      console.error(`Could not parse ${res.file}; left untouched. Remove the ${chalk.bold("#vibedrift-hook")} entries manually.`);
      process.exitCode = 1;
      return "aborted_unparseable";
    }
    console.log(`${chalk.green("✓")} Drift Sessions hooks removed (${res.status === "restored" ? "settings restored exactly" : res.status === "removed" ? "settings file removed" : "our entries removed, your edits kept"}).`);
    console.log(chalk.dim(`  recorded ledgers remain yours at ${ledgerDir}`));
    return "uninstalled";
  }

  // Hosted sync toggle (Phase 5): a standalone control — set the flag and return.
  if (options.sync) {
    const on = options.sync === "on";
    await patchConfig({ sessionsSyncEnabled: on, ...(on ? { sessionsSyncNoticeShown: true } : {}) });
    if (on) {
      console.log(`${chalk.green("✓")} Drift Sessions hosted sync is ON.`);
      console.log(
        chalk.dim(
          [
            "  Only a DERIVED projection leaves this machine — findings, scores, outcomes,",
            "  and metadata. Your prompts and code never do. File paths ship only as",
            "  per-repo grouping hashes, never the paths themselves. The agent's decision",
            "  reasoning + intent label stay local unless a team explicitly opts in.",
            "  Turn off anytime: vibedrift watch-session --sync off",
          ].join("\n"),
        ),
      );
    } else {
      console.log(`${chalk.green("✓")} Drift Sessions hosted sync is OFF — sessions stay entirely on this machine.`);
    }
    return "sync_updated";
  }

  // File-name sharing toggle: per repo, default off, fully reversible. Also a
  // standalone control, so it never installs hooks or starts a watch.
  if (options.names) {
    await toggleFileNames(options.names === "on", {
      projectHash,
      rootDir,
      sessionsDir,
      activationHome: options.activationHome ?? vibedriftHome(),
      deleteNames: options.deleteNames,
    });
    return "names_updated";
  }

  // Entitlement gate (decision 8): sessions are Pro-only with a one-time
  // 5-session trial. Only gate the WATCH path (delivering the live tape); a
  // bare install (--no-watch) just wires hooks, and the hook self-gates via the
  // cache (a LOCKED account — which by definition has already watched to spend
  // the trial — always has a cache that says locked). Pro unlock later takes
  // effect via the cache alone, no reinstall.
  const entDir = options.entitlementDir ?? entitlementDir();
  let consumeCb: ((sessionId: string) => void) | undefined;
  let uploadPlan: UploadPlan | undefined;
  if (options.watch) {
    const entitlement = options.resolveEntitlement
      ? await options.resolveEntitlement()
      : await resolveEntitlementViaNetwork(entDir);
    if (entitlement === null) {
      console.error("Drift Sessions need a free account. Run: vibedrift login");
      process.exitCode = 1;
      return "login_required";
    }
    writeEntitlementCache(entDir, entitlement);
    if (!entitlement.entitled) {
      printLockScreen(entitlement, sessionsDir, projectHash);
      return "locked";
    }
    // On trial, count each watched session (with activity) against the trial.
    consumeCb = options.onConsumeTrial
      ? options.onConsumeTrial
      : entitlement.reason === "trial"
        ? (sessionId) => void consumeTrialOnFirstEdit(sessionId, entDir)
        : undefined;
    uploadPlan = await resolveUploadPlan(options);
    if (uploadPlan) console.log(chalk.dim("  hosted sync: on (derived-only — findings/scores/outcomes, never code or prompts)"));
  }

  // Already installed: consent was given at install time, so skip straight to
  // watching (consent gates INSTALLING hooks, not following an existing session).
  const already = await hooksStatus(rootDir);
  if (already.installed) {
    console.log(`${chalk.green("●")} Drift Sessions hooks already installed (${already.file}).`);
    console.log(chalk.dim(`  session ledger: ${ledgerDir}`));
    if (options.watch) {
      await followLiveTape(projectHash, sessionsDir, rootDir, entDir, consumeCb, uploadPlan);
    }
    return "already";
  }

  if (!detectClaudeCode(rootDir, home)) {
    console.error("No supported agent detected (looked for .claude/ in the repo or ~/.claude/settings.json). Claude Code is the first supported agent.");
    process.exitCode = 1;
    return "no_agent";
  }

  if (!options.yes) {
    const confirm = options.confirm ?? askConsent;
    const ok = await confirm(
      [
        "Drift Sessions (preview) will register Claude Code hooks for THIS repo that:",
        "  - record your prompts (secrets masked) and edit metadata to a local ledger",
        `    under ${ledgerDir} (never uploaded by this feature; no network calls),`,
        "  - send one-line advisory notes into the agent when an edit diverges",
        "    from this repo's own dominant patterns,",
        "  - never read the agent's transcript file, and fail open: a hook error",
        "    or timeout never interrupts your agent.",
        `Uninstall anytime: vibedrift watch-session --uninstall`,
        "Install the hooks? [y/N] ",
      ].join("\n"),
    );
    if (!ok) {
      console.log("Nothing installed.");
      return "declined";
    }
  }

  const res = await installHooks(rootDir, installOpts);
  if (res.status === "aborted_unparseable") {
    console.error(`Could not parse ${res.file}; refusing to modify it. Fix the JSON and re-run.`);
    process.exitCode = 1;
    return "aborted_unparseable";
  }
  // The user just consented (prompt or --yes): record the explicit answer so
  // the nudge never fires here. Grandfathered installs (the early-return
  // "already" path above) deliberately never reach this line.
  recordAnswer(projectHash, "active", "watch-session", options.activationHome ?? vibedriftHome());
  appendConsentReceipt(ledgerDir, {
    v: 1,
    at: new Date().toISOString(),
    action: "enable",
    surface: "watch-session",
    projectHash,
    rootDir,
  });
  const installed = res.status === "already" ? "already" : "installed";
  if (installed === "already") {
    console.log(`${chalk.green("●")} Drift Sessions hooks already installed (${res.file}).`);
  } else {
    console.log(`${chalk.green("✓")} Drift Sessions hooks installed for this repo (${res.file}).`);
    console.log(chalk.dim("  fail-open: a hook failure or timeout never interrupts your agent."));
  }
  console.log(chalk.dim(`  session ledger: ${ledgerDir}`));

  if (options.watch) {
    await followLiveTape(projectHash, sessionsDir, rootDir, entDir, consumeCb, uploadPlan);
  } else {
    console.log(chalk.dim("  next Claude Code session in this repo will be recorded; run with --status to check."));
  }
  return installed;
}

/**
 * `--names on|off`: the per-repo file-name opt-in.
 *
 * ON prints the full disclosure BEFORE the flag is written, so the state on
 * disk never runs ahead of what the user was told, and records the project hash
 * it opted in under against an identity that survives the repo moving.
 *
 * OFF deletes what was already uploaded and then clears the flag. The delete is
 * scoped to a project hash, and one repo can have uploaded under more than one
 * (it moved on disk, or a second clone or git worktree of it hashes differently
 * while sharing the same repo identity), so every hash this machine recorded for
 * THIS repo is deleted, not just the current one. The local opt-in is cleared
 * for every one of those hashes for the same reason: an opt-out that deleted a
 * second working copy's uploads while leaving that copy ARMED would have it
 * re-upload them on its next flush, after the user was told sharing was off.
 * The flag ends up off locally either way — but the report is strictly what
 * happened: a deletion that did not land is never printed as one, the current
 * hash's failure is queued for the next flush, and an older hash's failure says
 * plainly that it is still out there.
 */
async function toggleFileNames(
  on: boolean,
  ctx: {
    projectHash: string;
    rootDir: string;
    sessionsDir: string;
    activationHome: string;
    deleteNames?: (projectHash: string) => Promise<{ deleted?: number }>;
  },
): Promise<void> {
  const { projectHash, rootDir, sessionsDir, activationHome } = ctx;
  const key = repoKey(rootDir);

  if (on) {
    console.log(chalk.bold("Drift Sessions file names for this repo"));
    console.log(
      chalk.dim(
        [
          '  What gets shared: repo-relative file paths, for example src/payments/refund.ts,',
          '  so your dashboard can name files instead of showing "file ab12cd34".',
          "  What never gets shared: file contents, absolute paths, or anything outside this repo.",
          "  Scope: this repo only, and only while hosted sync is on (vibedrift watch-session --sync on).",
          "  Reversible: vibedrift watch-session --names off deletes the names already uploaded",
          "  for this repo and stops future uploads.",
        ].join("\n"),
      ),
    );
    setShareFileNames(projectHash, true, activationHome);
    recordNameShare(projectHash, key, activationHome);
    console.log(`${chalk.green("✓")} File names are ON for this repo.`);
    return;
  }

  // Every hash this repo has shared names under: the current one plus anything
  // recorded from another path for the same repo (it moved, or a second clone
  // or worktree of it opted in and hashes differently).
  const hashes = [...new Set([projectHash, ...nameShareHashes(loadActivation(activationHome), key)])];
  let removed = 0;
  let counted = true;
  let currentFailed = false;
  let earlierFailed = 0;
  for (const hash of hashes) {
    try {
      const res = ctx.deleteNames ? await ctx.deleteNames(hash) : await deleteNamesViaNetwork(hash);
      if (typeof res?.deleted === "number") removed += res.deleted;
      else counted = false;
      forgetNameShare(hash, key, activationHome);
      setNamesDeletePending(hash, false, activationHome);
      await clearUploadedNames(sessionsDir, hash);
    } catch {
      // keep the record: it is what a re-run (or, for this repo's current hash,
      // the next flush) retries from.
      if (hash === projectHash) currentFailed = true;
      else earlierFailed++;
    }
  }
  // Disarm every hash the opt-out covered, not only the current one: another
  // working copy of this repo would otherwise still be opted in and re-upload
  // on its next flush the names this command just deleted.
  for (const hash of hashes) setShareFileNames(hash, false, activationHome);
  if (currentFailed) setNamesDeletePending(projectHash, true, activationHome);

  if (!currentFailed && earlierFailed === 0) {
    console.log(
      `${chalk.green("✓")} File names are OFF for this repo${counted ? ` (${removed} removed from your dashboard)` : ""}.`,
    );
    console.log(chalk.dim('  The dashboard shows per-repo pseudonyms again, like "file ab12cd34".'));
    return;
  }

  console.log(`${chalk.green("✓")} File names are OFF for this repo; nothing more will be uploaded.`);
  if (counted && removed > 0) {
    console.log(chalk.dim(`  Removed ${removed} uploaded name${removed === 1 ? "" : "s"} from your dashboard.`));
  }
  if (currentFailed) {
    console.log(
      chalk.dim("  The delete request did not reach the server. It will be retried on the next session flush."),
    );
  }
  if (earlierFailed > 0) {
    console.log(
      chalk.dim(
        `  ${earlierFailed} earlier upload${earlierFailed === 1 ? "" : "s"} for this repo (from a previous path) could not be removed. Re-run this command to try again.`,
      ),
    );
  }
}

/** Delete one project hash's uploaded names server-side. Throws when there is
 *  no account or the request fails; the caller decides what that means (the
 *  current hash is queued for the next flush, an older one is kept for a
 *  re-run) and reports only what actually happened. */
async function deleteNamesViaNetwork(projectHash: string): Promise<{ deleted?: number }> {
  const cfg = await readConfig();
  if (!cfg.token) throw new Error("not logged in");
  const { deleteSessionNames } = await import("../../auth/api.js");
  return deleteSessionNames(cfg.token, projectHash, { apiUrl: cfg.apiUrl });
}

/** Resolve entitlement from the server, tolerating offline via the local cache.
 *  Returns null only when there is no account AND no prior cache (login needed). */
async function resolveEntitlementViaNetwork(entDir: string): Promise<SessionEntitlement | null> {
  const { resolveToken } = await import("../../auth/resolver.js");
  const resolved = await resolveToken();
  const cached = readEntitlementCache(entDir);
  if (!resolved) return cached ?? null; // no account: use a prior cache, else require login
  try {
    const { fetchSessionEntitlement } = await import("../../auth/api.js");
    const r = await fetchSessionEntitlement(resolved.token);
    return computeEntitlement(r.plan, r.trial_used, r.trial_limit);
  } catch {
    // offline: last known entitlement, or a provisional trial so a logged-in
    // user is not locked out by a network blip (the server reconciles the count).
    return cached ?? computeEntitlement("free", 0);
  }
}

/** Count a watched session against the trial (fire-and-forget). The server
 *  dedups by session id; we refresh the local cache with the returned count so
 *  the lock lands on the next run once the trial is spent. */
async function consumeTrialOnFirstEdit(sessionId: string, entDir: string): Promise<void> {
  try {
    const { resolveToken } = await import("../../auth/resolver.js");
    const resolved = await resolveToken();
    if (!resolved) return;
    const { consumeSessionTrial } = await import("../../auth/api.js");
    const r = await consumeSessionTrial(resolved.token, sessionId);
    // Grandfather the in-flight session: keep capture ON even when this consume
    // spends the last trial, so the 5th session runs full-featured to the end.
    // The authoritative (possibly locked) entitlement is written when this watch
    // exits (see refreshEntitlementOnExit); the next run then locks.
    const e = computeEntitlement(r.plan, r.trial_used, r.trial_limit);
    writeEntitlementCache(entDir, { ...e, entitled: true, reason: e.reason });
  } catch {
    // best-effort; the server remains authoritative for the count
  }
}

/** After a watch ends, write the authoritative entitlement so a spent trial
 *  re-locks promptly (a grandfathered in-flight session may have left the cache
 *  entitled). Best-effort. */
async function refreshEntitlementOnExit(entDir: string): Promise<void> {
  try {
    const e = await resolveEntitlementViaNetwork(entDir);
    if (e) writeEntitlementCache(entDir, e);
  } catch {
    // best-effort
  }
}

/** The honest lock screen: what the trial actually caught (from this repo's real
 *  local ledgers) plus the upgrade CTA. No prevention claims. */
function printLockScreen(e: SessionEntitlement, sessionsDir: string, projectHash: string): void {
  let sessions = 0;
  let flagged = 0;
  try {
    const dir = join(sessionsDir, projectHash);
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    for (const f of files) {
      const events = parseJsonlLines(readFileSync(join(dir, f), "utf8"));
      const s = summarize(events);
      if (s.edits > 0) sessions++;
      flagged += s.flagged; // confirmed findings only; experimental scope signals excluded
    }
  } catch {
    // no local history to summarize; the CTA still stands
  }
  console.log(`\n${chalk.bold("Drift Sessions — trial complete.")}`);
  console.log(
    chalk.dim(
      `  Your ${e.trialLimit}-session trial is used up${sessions ? ` (${sessions} watched, ${flagged} finding${flagged === 1 ? "" : "s"} surfaced on this repo)` : ""}.`,
    ),
  );
  console.log("  Upgrade to Pro to keep the navigator watching every session:");
  console.log(`    ${chalk.bold("vibedrift upgrade")}   ${chalk.dim("($15/mo — unlimited sessions, history, dashboard)")}`);
  console.log(chalk.dim("  Your recorded local ledgers remain yours; nothing was uploaded.\n"));
}

/** Build the hosted-sync upload plan for this run, or undefined when sync is off
 *  (not opted in, logged out, or --local-only). Fail-open: a config read error
 *  just means no sync. Kept off the hook path — this runs in the resident viewer. */
async function resolveUploadPlan(options: WatchSessionOptions): Promise<UploadPlan | undefined> {
  try {
    const cfg = options.loadConfig ? await options.loadConfig() : await readConfig();
    if (!shouldSync(cfg, options.localOnly) || !cfg.token) return undefined;
    const token = cfg.token;
    const apiUrl = cfg.apiUrl;
    return {
      teamIntentOptIn: cfg.sessionsTeamIntentOptIn === true,
      post: (events) => postSessionIngest(token, events, { apiUrl }),
    };
  } catch {
    return undefined; // config unreadable → no sync, local unaffected
  }
}

/** Print the tape header and follow the live session until Ctrl-C. */
async function followLiveTape(
  projectHash: string,
  sessionsDir: string,
  rootDir: string,
  entDir: string,
  onFirstEdit?: (sessionId: string) => void,
  upload?: UploadPlan,
): Promise<void> {
  // Staleness honesty: convention/redundancy checks need a baseline. Scope drift
  // still works without one, so this is a hint, not a blocker.
  try {
    const { loadBaselineUnchecked } = await import("../../core/baseline.js");
    if (!(await loadBaselineUnchecked(rootDir))) {
      console.log(
        chalk.dim("  note: no baseline yet — run `vibedrift scan` for convention + duplicate checks (scope drift works without one)."),
      );
    }
  } catch {
    // hint only; never block watching
  }
  console.log(chalk.dim("\n◆ EVENT TAPE · agent ↔ vibedrift · watching for your next session\n"));
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    const tasks: Promise<void>[] = [
      // If the tape ends (Ctrl-C) or crashes, abort so the uploader stops too.
      runLiveTape({ sessionsDir, projectHash, out: process.stdout, signal: controller.signal, onFirstEdit }).finally(
        () => controller.abort(),
      ),
    ];
    if (upload) {
      // Runs alongside the tape, own follower/offsets, fail-open, shares the
      // Ctrl-C signal. Never on the hook path. Guarded so an uploader fault can
      // never take the tape down.
      tasks.push(
        runUploader({
          sessionsDir,
          projectHash,
          teamIntentOptIn: upload.teamIntentOptIn,
          post: upload.post,
          signal: controller.signal,
        }).catch(() => {}),
      );
    }
    await Promise.all(tasks);
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (onFirstEdit) await refreshEntitlementOnExit(entDir);
    process.stdout.write("\n");
  }
}
