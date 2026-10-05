import ignore, { type Ignore } from "ignore";
import { readFile, readdir } from "fs/promises";
import { join, relative } from "path";

const IGNORE_FILES = [".gitignore", ".vibedriftignore"];

/**
 * Re-anchor one gitignore pattern from the directory its file sits in to the
 * repo root, preserving git's semantics (#111):
 *   - a pattern containing a slash is anchored to the file's directory
 *     (`dist`, `/dist` → `packages/app/dist`)
 *   - a slash-free pattern matches at ANY depth below that directory
 *     (`*.log` → `packages/app/** /\*.log`)
 *   - negation (`!`) and dir-only (`/`) markers survive the move
 * The root file's patterns pass through untouched.
 */
/** Escape a repo-relative directory path for interpolation INTO a glob
 *  pattern: backslashes first, then the glob metacharacters, and a leading
 *  `!` / `#` (syntactic at pattern start). Without this, a directory named
 *  `packages/[slug]` — a standard Next.js dynamic route — turns every pattern
 *  in its ignore file into a character class that ignores sibling dirs like
 *  `packages/s/` and misses its own (found in cross-review). Residual: a
 *  literal `?` in a directory name has no working escape in the ignore
 *  package (upstream limitation) — such a dir's nested ignore file stays
 *  inert, which is a miss, never a leak, and matches pre-fix behavior. */
export function escapeGlobPath(p: string): string {
  let out = p
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\*/g, "\\*")
    .replace(/\?/g, "\\?");
  if (out.startsWith("!") || out.startsWith("#")) out = "\\" + out;
  return out;
}

export function reanchorPattern(pattern: string, dirRel: string): string {
  if (dirRel === "") return pattern;
  const dir = escapeGlobPath(dirRel);
  let p = pattern;
  let neg = false;
  if (p.startsWith("!")) {
    neg = true;
    p = p.slice(1);
  }
  const dirOnly = p.endsWith("/");
  const core = dirOnly ? p.slice(0, -1) : p;
  const anchored = core.includes("/");
  const out = anchored ? `${dir}/${core.replace(/^\/+/, "")}` : `${dir}/**/${core}`;
  return (neg ? "!" : "") + out + (dirOnly ? "/" : "");
}

/**
 * Find every ignore file under the root, parents before children (pre-order),
 * so last-match-wins gives deeper files precedence the way git does. Skips
 * dot-dirs, node_modules and the caller's `skipDirs`: discovery never
 * descends into those, so an ignore file there could never apply, and walking
 * a build tree (target/, venv/) costs about 30 µs per directory.
 */
async function collectIgnoreFiles(
  rootDir: string,
  skipDirs: ReadonlySet<string>,
): Promise<{ dirRel: string; file: string }[]> {
  const found: { dirRel: string; file: string }[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const name of IGNORE_FILES) {
      if (entries.some((e) => e.isFile() && e.name === name)) {
        found.push({ dirRel: relative(rootDir, dir).replace(/\\/g, "/"), file: join(dir, name) });
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name === "node_modules" || skipDirs.has(e.name)) continue;
      await walk(join(dir, e.name));
    }
  }
  await walk(rootDir);
  return found;
}

export async function loadGitignore(rootDir: string, skipDirs: ReadonlySet<string> = new Set()): Promise<Ignore> {
  const ig = ignore();

  for (const { dirRel, file } of await collectIgnoreFiles(rootDir, skipDirs)) {
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    const reanchored = content
      .split("\n")
      .map((line) => {
        const l = line.endsWith("\r") ? line.slice(0, -1) : line;
        const trimmed = l.trim();
        if (trimmed === "" || trimmed.startsWith("#")) return l;
        return reanchorPattern(l, dirRel);
      })
      .join("\n");
    ig.add(reanchored);
  }

  return ig;
}
