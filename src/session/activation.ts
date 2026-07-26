/**
 * Machine-global activation store (L-N3/L-N8): per-repo consent state for
 * native Drift Sessions, plus directory-scope grants (L-N9).
 *
 * One small JSON file under the VibeDrift home — the SessionStart hook reads
 * it on its fast path (single file read, well inside the 0.2s budget), the
 * enable/decline surfaces write it. States per projectHash:
 *   - no entry / no `state`  -> unanswered (the nudge may fire, budget-gated;
 *                               capture continues for legacy grandfathered repos)
 *   - "active"               -> capture on, never nudge
 *   - "declined"             -> capture OFF (the hook returns early), never nudge again
 *
 * The ask BUDGET (L-N8, reconciled with the grandfather rule 2026-07-26): at
 * most one ask per genuinely new interactive session, at most ASK_BUDGET total.
 * Expiry stops ASKING (marks `breadcrumbShown`, leaves a one-line breadcrumb)
 * but deliberately does NOT write `declined` — so a legacy repo that was already
 * capturing is never silently flipped off just because its nudges went ignored.
 * Only an explicit `vibedrift enable`/`decline` sets `state`; the ask itself
 * self-limits via `askCount`.
 *
 * Dir grants (O19): stored canonicalized; `$HOME` and filesystem roots are
 * REFUSED outright — a grant that broad is indistinguishable from the
 * auto-capture-everything design that was explicitly rejected.
 *
 * Legacy grandfather: a repo with hooks installed but NO record here keeps
 * capturing (existing users are never silently flipped); "declined" always
 * wins over everything.
 *
 * Writes are atomic (tmp + rename) and fail-open; readers treat a missing or
 * corrupt file as empty.
 */

import { mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { vibedriftHome } from "../core/vibedrift-home.js";

export const ASK_BUDGET = 3;

export type ActivationState = "active" | "declined";
export type AnswerSurface =
  | "cli-enable"
  | "cli-decline"
  | "mcp-enable"
  | "mcp-decline"
  | "watch-session"
  | "budget-expiry"
  | "dir-grant";

export interface ProjectActivation {
  state?: ActivationState;
  /** ISO timestamp of the recorded answer (absent while unanswered). */
  at?: string;
  surface?: AnswerSurface;
  /** Asks consumed so far (unanswered repos only, budget-gated). */
  askCount?: number;
  /** The one-time "run `vibedrift enable`" breadcrumb was already shown. */
  breadcrumbShown?: boolean;
}

export interface ActivationStore {
  v: 1;
  projects: Record<string, ProjectActivation>;
  dirGrants: Array<{ path: string; at: string }>;
}

const EMPTY: ActivationStore = { v: 1, projects: {}, dirGrants: [] };

export function activationPath(home: string = vibedriftHome()): string {
  return join(home, "activation.json");
}

/** Synchronous on purpose: the hook fast path calls this. Fail-open. */
export function loadActivation(home: string = vibedriftHome()): ActivationStore {
  try {
    const parsed = JSON.parse(readFileSync(activationPath(home), "utf8")) as Partial<ActivationStore>;
    if (!parsed || parsed.v !== 1) return structuredClone(EMPTY);
    return {
      v: 1,
      projects: typeof parsed.projects === "object" && parsed.projects !== null ? parsed.projects : {},
      dirGrants: Array.isArray(parsed.dirGrants) ? parsed.dirGrants : [],
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

function saveActivation(store: ActivationStore, home: string = vibedriftHome()): void {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const path = activationPath(home);
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // fail-open: an unwritable store degrades to "unanswered" next time
  }
}

/** Effective status for a repo root: an explicit answer wins; otherwise a
 *  covering dir grant means active; otherwise unanswered. */
export function projectStatus(
  store: ActivationStore,
  projectHash: string,
  rootDir?: string,
): ActivationState | "unanswered" {
  const rec = store.projects[projectHash];
  if (rec?.state) return rec.state;
  if (rootDir && isUnderGrant(store, rootDir)) return "active";
  return "unanswered";
}

export function isUnderGrant(store: ActivationStore, rootDir: string): boolean {
  const root = resolve(rootDir);
  return store.dirGrants.some((g) => root === g.path || root.startsWith(g.path + sep));
}

export function recordAnswer(
  projectHash: string,
  state: ActivationState,
  surface: AnswerSurface,
  home: string = vibedriftHome(),
): void {
  const store = loadActivation(home);
  const prev = store.projects[projectHash] ?? {};
  store.projects[projectHash] = { ...prev, state, at: new Date().toISOString(), surface };
  saveActivation(store, home);
}

export interface AskOutcome {
  /** true when the nudge may fire this session. */
  ask: boolean;
  /** asks consumed INCLUDING this one when ask=true. */
  askCount: number;
  /** true exactly once: this call exhausted the budget (implicit decline
   *  recorded; caller should surface the one-line breadcrumb). */
  budgetExpired: boolean;
}

/**
 * Consume one ask from the budget for an unanswered repo. Call ONLY for a
 * genuinely new interactive session (the hook gate decides that). The budget
 * self-limits via `askCount` — the (ASK_BUDGET+1)th call returns ask:false —
 * so expiry does NOT need to (and must not) write `declined`, which would flip
 * a grandfathered capturing repo off (L-N8 reconciled with grandfather).
 */
export function consumeAsk(projectHash: string, home: string = vibedriftHome()): AskOutcome {
  const store = loadActivation(home);
  const rec = store.projects[projectHash] ?? {};
  if (rec.state) return { ask: false, askCount: rec.askCount ?? 0, budgetExpired: false };
  const count = (rec.askCount ?? 0) + 1;
  if (count > ASK_BUDGET) {
    // Budget already spent: no more asks (askCount self-limits; no state written).
    return { ask: false, askCount: rec.askCount ?? 0, budgetExpired: false };
  }
  const expiring = count === ASK_BUDGET;
  // Expiry marks breadcrumbShown but leaves `state` alone — capture (for a
  // grandfathered repo) continues; only an explicit enable/decline sets state.
  store.projects[projectHash] = expiring
    ? { ...rec, askCount: count, breadcrumbShown: true }
    : { ...rec, askCount: count };
  saveActivation(store, home);
  // The final ask still fires (it IS the third ask); expiry means no fourth.
  return { ask: true, askCount: count, budgetExpired: expiring };
}

export class DirGrantRefusedError extends Error {
  constructor(public readonly resolved: string, reason: string) {
    super(`refusing directory grant on ${resolved}: ${reason}`);
    this.name = "DirGrantRefusedError";
  }
}

/** Canonicalize and validate a dir-grant path (O19). Throws on $HOME, any
 *  ANCESTOR of $HOME (e.g. `/Users`, `/home` — broader than $HOME itself), any
 *  filesystem root, or a nonexistent directory. Returns the resolved path. A
 *  subdirectory of home (e.g. `~/work`) is the intended grant and is allowed. */
export function resolveGrantPath(input: string): string {
  const real = realpathSync(resolve(input));
  const home = realpathSync(homedir());
  if (home === real || home.startsWith(real + sep)) {
    throw new DirGrantRefusedError(
      real,
      "granting your home directory (or a parent of it) is auto-capture-everything, which is explicitly rejected; grant a work directory instead (e.g. ~/work)",
    );
  }
  const { root } = parse(real);
  if (real === root) throw new DirGrantRefusedError(real, "granting a filesystem root would capture everything on the machine");
  return real;
}

export function addDirGrant(resolvedPath: string, home: string = vibedriftHome()): void {
  const store = loadActivation(home);
  if (!store.dirGrants.some((g) => g.path === resolvedPath)) {
    store.dirGrants.push({ path: resolvedPath, at: new Date().toISOString() });
    saveActivation(store, home);
  }
}
