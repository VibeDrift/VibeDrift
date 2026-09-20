/**
 * Repo identity for the session ledger: hooks hand us a cwd that may be a
 * subdirectory; the ledger (and the baseline it is checked against) is keyed
 * on the repo root, defined as the nearest ancestor containing `.git`.
 *
 * Two questions live here and they are NOT the same one:
 *   - `repoIdentity(cwd)`: which repo is the agent running in? A cwd that is in
 *     no repo answers "the folder itself", which is what makes a workspace of
 *     checkouts a scope of its own.
 *   - `repoOwningFile(path)`: which repo owns this FILE? A file in no repo
 *     answers null, deliberately, so an edit outside every repo stays with the
 *     session's workspace instead of minting a project per stray directory.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
 * The repo a FILE belongs to: the nearest ancestor of the file's own directory
 * that holds `.git`, or null when the file belongs to no repo at all.
 *
 * This is what makes an edit land in the right project. The hook used to
 * resolve one repo per hook call, from the agent's working folder, so every
 * edit in a session was recorded against that repo and checked against its
 * patterns — including edits in a sibling checkout, a nested repo, or a second
 * worktree, none of which share its conventions.
 *
 * Null (rather than "the folder itself", which `resolveRepoRoot` answers for a
 * cwd) is the important half: a scratch file under a directory that is not a
 * repo has no patterns of its own to be measured against, so it stays with the
 * session's workspace rather than becoming a project nobody asked for.
 */
export function repoOwningFile(filePath: string): { rootDir: string; projectHash: string } | null {
  let dir = dirname(resolve(filePath));
  for (;;) {
    // A worktree's `.git` is a FILE, not a directory; existsSync accepts both,
    // so a worktree resolves to its own root exactly like a clone does.
    if (existsSync(join(dir, ".git"))) {
      const rootDir = canonicalizeRoot(dir);
      return { rootDir, projectHash: projectHash(rootDir) };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
/**
 * `repoKey` as an opaque id, in the same 16-hex shape as a project hash.
 *
 * The raw key is either a commit sha or, when git cannot answer, `path:` plus
 * a machine path — which must never leave the machine. Hashing makes one shape
 * of both and keeps the promise the wire makes about ids: a consumer can tell
 * that two checkouts are one repo, and can learn nothing else from it.
 */
export function hashRepoKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

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
