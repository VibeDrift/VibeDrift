import { execFile } from "node:child_process";

/**
 * Lazily answer "does this repo-relative directory contain any git-tracked
 * file?" with one `git ls-files` for the whole repo, spawned on first use
 * and cached. Resolves null outside git repositories, so callers can fall
 * back to name-based rules (#116: a directory named build/ is only output
 * when it is gitignored or untracked; tracked source named build/ is source).
 */
export function createTrackedLookup(rootDir: string): (relDir: string) => Promise<boolean | null> {
  let promise: Promise<Set<string> | null> | null = null;
  const load = (): Promise<Set<string> | null> => {
    if (!promise) {
      promise = new Promise((resolve) => {
        execFile("git", ["ls-files"], { cwd: rootDir, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          resolve(new Set(stdout.split("\n").filter(Boolean)));
        });
      });
    }
    return promise;
  };
  return async (relDir: string): Promise<boolean | null> => {
    const tracked = await load();
    if (!tracked) return null;
    const prefix = relDir === "" || relDir === "." ? "" : relDir.replace(/\\/g, "/") + "/";
    for (const path of tracked) {
      if (prefix === "" || path.startsWith(prefix)) return true;
    }
    return false;
  };
}
