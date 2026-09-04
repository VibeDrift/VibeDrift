/**
 * Plausibility guard for write-capable tools whose `rootDir` input is fully
 * client/agent-controlled (the MCP caller passes it; nothing upstream
 * verifies it is an actual project). `enable` installs agent hook config
 * into `rootDir` and `init` writes `.vibedrift/config.json` + appends to
 * `.vibedriftignore` there — both would happily do so in any directory the
 * caller names, including one it has no business touching.
 *
 * This is defense-in-depth, not the primary mitigation: `enable`'s MCP
 * registration already forces a native Allow/Deny prompt
 * (`_meta["anthropic/requiresUserInteraction"]`) and requires an in-band
 * `confirm`, so a malicious rootDir still needs the user to click through.
 * `init` has no such prompt, so this guard is its only check.
 *
 * Where it is called:
 *   - `enable`: in the channel-neutral core (src/tools-core/tools/enable.ts),
 *     since every channel that can enable capture should be gated.
 *   - `init`: in the MCP adapter only (src/mcp/tools/init.ts), NOT the core.
 *     The interactive `vibedrift init` CLI runs in the user's own cwd by
 *     explicit command, and a brand-new project has no markers yet — the
 *     guard must not refuse there at the end of the prompt walkthrough.
 *
 * Call this before the first filesystem write, not before every read — the
 * MCP `init` adapter also runs it for `detectOnly` previews since it is cheap
 * and keeps the check unconditional rather than branch-dependent.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  ".vibedrift",
];

export class ImplausibleRootDirError extends Error {
  constructor(rootDir: string) {
    super(
      `"${rootDir}" doesn't look like a project directory — no .git, package.json, ` +
        `pyproject.toml, go.mod, Cargo.toml, or .vibedrift found there or in any parent ` +
        `directory. Refusing to write into it. Pass the actual repository root (or a ` +
        `subdirectory of one).`,
    );
    this.name = "ImplausibleRootDirError";
  }
}

/**
 * Throws `ImplausibleRootDirError` unless `rootDir`:
 *   1. resolves to an existing directory, AND
 *   2. either contains a project marker itself, or has an ancestor
 *      directory containing `.git` (the monorepo-subdir case — e.g.
 *      `packages/foo` legitimately has no `package.json` of its own, but
 *      the repo root above it does have `.git`).
 */
export function assertPlausibleProjectRoot(rootDir: string): void {
  const dir = resolve(rootDir);

  let isDir: boolean;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new ImplausibleRootDirError(rootDir);

  if (PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return;

  let cur = dir;
  for (;;) {
    if (existsSync(join(cur, ".git"))) return;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  throw new ImplausibleRootDirError(rootDir);
}
