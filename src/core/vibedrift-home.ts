/**
 * Machine-global VibeDrift state root (`~/.vibedrift` by default).
 *
 * `VIBEDRIFT_HOME` overrides it for sandboxed development and testing: every
 * piece of home-anchored state (auth config, caches, scan history, session
 * ledgers, entitlement) moves with it, so a dev run can never touch the real
 * store or show up on a real dashboard. The repo-local `.vibedrift/` project
 * config directory is a different thing and is never affected by this.
 *
 * Contract: set VIBEDRIFT_HOME before the process starts (spawn-time env).
 * This helper reads at call time, but several state modules snapshot their
 * root into module consts at import — mutating the env mid-process splits
 * state across two roots. New code should call this lazily, not snapshot.
 * Zero imports beyond node builtins — the session hook entrypoint stays on
 * its fast path.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The state root: $VIBEDRIFT_HOME when set and non-blank, else ~/.vibedrift. */
export function vibedriftHome(): string {
  const env = process.env.VIBEDRIFT_HOME;
  if (env && env.trim().length > 0) return resolve(env.trim());
  return join(homedir(), ".vibedrift");
}

/** True when a sandbox override is active (drives the DEV MODE banner). */
export function isSandboxHome(): boolean {
  const env = process.env.VIBEDRIFT_HOME;
  return Boolean(env && env.trim().length > 0);
}
