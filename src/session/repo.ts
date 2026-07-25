/**
 * Repo identity for the session ledger: hooks hand us a cwd that may be a
 * subdirectory; the ledger (and the baseline it is checked against) is keyed
 * on the repo root, defined as the nearest ancestor containing `.git`.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { vibedriftHome } from "../core/vibedrift-home.js";
import { projectHash, canonicalizeRoot } from "../core/baseline.js";

export function resolveRepoRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return canonicalizeRoot(dir);
    const parent = dirname(dir);
    if (parent === dir) return canonicalizeRoot(cwd);
    dir = parent;
  }
}

export function defaultSessionsDir(): string {
  return join(vibedriftHome(), "sessions");
}

export function repoIdentity(cwd: string): { rootDir: string; projectHash: string } {
  const rootDir = resolveRepoRoot(cwd);
  return { rootDir, projectHash: projectHash(rootDir) };
}
