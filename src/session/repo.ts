/**
 * Repo identity for the session ledger: hooks hand us a cwd that may be a
 * subdirectory; the ledger (and the baseline it is checked against) is keyed
 * on the repo root, defined as the nearest ancestor containing `.git`.
 */

import { execFileSync } from "node:child_process";
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

/**
 * An identity for a repo that survives a MOVE on disk.
 *
 * `projectHash` is sha256 of the canonical root PATH, so moving or re-cloning a
 * repo mints a new one and anything keyed on the old hash — names already
 * uploaded, for instance — becomes unreachable from the new location. A repo's
 * root commit is the same wherever the working copy lives, so that is the key
 * when git can answer; otherwise we fall back to the canonical path, which is
 * no worse than the hash it stands in for.
 *
 * Never throws, and never used to decide what is captured — only to link this
 * machine's own records for one repo across its project hashes.
 */
export function repoKey(rootDir: string): string {
  try {
    const out = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // Sorted: several root commits (merged unrelated histories) must still map
    // to one deterministic key.
    const roots = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{40,64}$/.test(l))
      .sort();
    if (roots.length > 0) return `git:${roots[0]}`;
  } catch {
    // not a git repo, no commits yet, or no git on PATH
  }
  return `path:${canonicalizeRoot(rootDir)}`;
}
