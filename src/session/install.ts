/**
 * Agent-hook installer for Drift Sessions.
 *
 * Writes marker-tagged hook entries into the project's
 * `.claude/settings.local.json` (project-local, conventionally uncommitted).
 * Safety contract:
 * - never touches a file it cannot parse (refuse-to-clobber);
 * - snapshots the pre-install bytes so uninstall can restore them EXACTLY
 *   when the user hasn't edited settings since (byte-identical restore);
 * - falls back to surgical marker-entry removal when they have;
 * - deletes the file on uninstall only when we created it and nothing else
 *   was added to it.
 */

import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_MARKER = "vibedrift-hook";

/** Absolute `node <dist>/session/hook-entry.js` so hooks never depend on PATH.
 *  Every bundle entry lives one level under dist/ (cli/, mcp/, session/), so
 *  the sibling-tree math holds regardless of which bundle inlined this module.
 *  Both paths are double-quoted so a node install or repo checkout under a
 *  directory containing spaces still runs (the shell would otherwise split it);
 *  the trailing ` #vibedrift-hook` marker stays a shell comment. */
export function resolveHookCommand(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const entry = resolve(here, "..", "session", "hook-entry.js");
  return `"${process.execPath}" "${entry}"`;
}

/** Claude Code is the first supported agent: a repo-local .claude/ or a
 *  user-level ~/.claude/settings.json counts as "present". */
export function detectClaudeCode(repoRoot: string, homeDir: string): boolean {
  return (
    existsSync(join(repoRoot, ".claude")) || existsSync(join(homeDir, ".claude", "settings.json"))
  );
}

/** The events the hook listens to. PostToolUse is scoped twice: the edit
 *  tools, and Bash on its own. An agent in Claude Code's bypass-permissions
 *  mode is steered to change files through Bash (heredocs, `sed -i`), and on a
 *  recorded session that moved about two thirds of file changes out of the
 *  edit-tool matcher's sight, every fix made in answer to a flag included.
 *  The Bash group lets the hook re-check what a Bash call changed. */
export const HOOK_EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PostToolUse", matcher: "Edit|Write|MultiEdit" },
  { event: "PostToolUse", matcher: "Bash" },
  { event: "Stop" },
];

/** Label for a hook group in status output: "PostToolUse:Bash". */
function groupLabel(h: { event: string; matcher?: string }): string {
  return h.matcher ? `${h.event}:${h.matcher}` : h.event;
}

const HOOK_TIMEOUT_SECONDS = 10;

export interface InstallOptions {
  hookCommand: string;
  sessionsDir: string;
  projectHash: string;
}

export interface InstallResult {
  status: "installed" | "already" | "aborted_unparseable";
  file: string;
}

export interface UninstallResult {
  status: "removed" | "restored" | "removed_surgical" | "not_installed" | "aborted_unparseable";
  file: string;
}

type HookEntry = { type: string; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type SettingsShape = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

function settingsPath(repoRoot: string): string {
  return join(repoRoot, ".claude", "settings.local.json");
}

function backupPath(opts: InstallOptions): string {
  return join(opts.sessionsDir, opts.projectHash, "settings-backup.json");
}

/** Sentinel meaning "the settings file did not exist before install". */
const NO_FILE_SENTINEL = "::vibedrift:no-file::";

function taggedCommand(opts: InstallOptions): string {
  // Trailing shell comment doubles as the removal/idempotency marker.
  return `${opts.hookCommand} #${HOOK_MARKER}`;
}

function isOurs(entry: HookEntry): boolean {
  return typeof entry.command === "string" && entry.command.includes(HOOK_MARKER);
}

function hasOurEntry(groups: HookGroup[] | undefined): boolean {
  return !!groups?.some((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs));
}

/** Our entry present in a group with exactly this matcher (undefined = a
 *  matcher-less group). A pre-Bash install has our PostToolUse entry under the
 *  edit-tool matcher only, and must read as "Bash group missing", not as
 *  "installed". */
function hasOurEntryFor(groups: HookGroup[] | undefined, matcher: string | undefined): boolean {
  return !!groups?.some(
    (g) => g.matcher === matcher && Array.isArray(g.hooks) && g.hooks.some(isOurs),
  );
}

/** The hook groups we install that are NOT present in `hooks`. */
function missingGroups(hooks: Record<string, HookGroup[]>): string[] {
  return HOOK_EVENTS.filter((h) => !hasOurEntryFor(hooks[h.event], h.matcher)).map(groupLabel);
}

async function readSettings(
  file: string,
): Promise<{ raw: string | null; parsed: SettingsShape | null; unparseable: boolean }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { raw: null, parsed: null, unparseable: false };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { raw, parsed: null, unparseable: true };
    }
    return { raw, parsed: parsed as SettingsShape, unparseable: false };
  } catch {
    return { raw, parsed: null, unparseable: true };
  }
}

export async function installHooks(repoRoot: string, opts: InstallOptions): Promise<InstallResult> {
  const file = settingsPath(repoRoot);
  const { raw, parsed, unparseable } = await readSettings(file);
  if (unparseable) return { status: "aborted_unparseable", file };

  const settings: SettingsShape = parsed ?? {};
  const hooks: Record<string, HookGroup[]> = (settings.hooks as Record<string, HookGroup[]>) ?? {};

  if (missingGroups(hooks).length === 0) {
    return { status: "already", file };
  }

  // Snapshot the pre-install state ONCE. On a re-install over a partial state
  // (some of our events present, some not), a pristine snapshot already exists
  // and must not be clobbered with the now-partially-installed bytes.
  const backup = backupPath(opts);
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
  let backupExists = true;
  try {
    await access(backup);
  } catch {
    backupExists = false;
  }
  if (!backupExists) {
    await writeFile(backup, raw ?? NO_FILE_SENTINEL, { mode: 0o600 });
  }

  const command = taggedCommand(opts);
  for (const { event, matcher } of HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    if (!hasOurEntryFor(groups, matcher)) {
      const entry: HookEntry = { type: "command", command, timeout: HOOK_TIMEOUT_SECONDS };
      groups.push(matcher !== undefined ? { matcher, hooks: [entry] } : { hooks: [entry] });
    }
    hooks[event] = groups;
  }
  settings.hooks = hooks;

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { status: "installed", file };
}

function stripOurEntries(hooks: Record<string, HookGroup[]>): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) out[event] = kept;
  }
  return out;
}

/** Deep-equal check that ignores our own marker entries: true when the current
 *  file is exactly "the snapshot plus our install". */
function matchesSnapshotPlusOurs(currentRaw: string, snapshotRaw: string): boolean {
  try {
    const current = JSON.parse(currentRaw) as SettingsShape;
    const strippedHooks = stripOurEntries((current.hooks as Record<string, HookGroup[]>) ?? {});
    const stripped: SettingsShape = { ...current };
    if (Object.keys(strippedHooks).length > 0) stripped.hooks = strippedHooks;
    else delete stripped.hooks;

    const snapshot =
      snapshotRaw === NO_FILE_SENTINEL ? {} : (JSON.parse(snapshotRaw) as SettingsShape);
    return JSON.stringify(stripped) === JSON.stringify(snapshot);
  } catch {
    return false;
  }
}

export async function uninstallHooks(
  repoRoot: string,
  opts: InstallOptions,
): Promise<UninstallResult> {
  const file = settingsPath(repoRoot);
  const { raw, parsed, unparseable } = await readSettings(file);
  if (unparseable) return { status: "aborted_unparseable", file };
  if (raw === null || !parsed) return { status: "not_installed", file };

  const hooks = (parsed.hooks as Record<string, HookGroup[]>) ?? {};
  if (!Object.values(hooks).some((groups) => hasOurEntry(groups))) {
    return { status: "not_installed", file };
  }

  let snapshotRaw: string | null;
  try {
    snapshotRaw = await readFile(backupPath(opts), "utf8");
  } catch {
    snapshotRaw = null;
  }

  if (snapshotRaw !== null && matchesSnapshotPlusOurs(raw, snapshotRaw)) {
    if (snapshotRaw === NO_FILE_SENTINEL) {
      await rm(file, { force: true });
      await rm(backupPath(opts), { force: true });
      return { status: "removed", file };
    }
    await writeFile(file, snapshotRaw);
    await rm(backupPath(opts), { force: true });
    return { status: "restored", file };
  }

  const strippedHooks = stripOurEntries(hooks);
  const next: SettingsShape = { ...parsed };
  if (Object.keys(strippedHooks).length > 0) next.hooks = strippedHooks;
  else delete next.hooks;
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  await rm(backupPath(opts), { force: true });
  return { status: "removed_surgical", file };
}

export async function hooksStatus(
  repoRoot: string,
): Promise<{ installed: boolean; file: string; missing: string[] }> {
  const file = settingsPath(repoRoot);
  const { parsed } = await readSettings(file);
  const hooks = (parsed?.hooks as Record<string, HookGroup[]>) ?? {};
  const installed = Object.values(hooks).some((groups) => hasOurEntry(groups));
  // `missing` only means something for an install: an uninstalled repo lists
  // nothing rather than every group.
  return { installed, file, missing: installed ? missingGroups(hooks) : [] };
}
