import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The plugin ships the same five hook groups `watch-session` installs, so a
// repo that has the plugin gets Drift Sessions capture without a repo-local
// install. Every entry runs the wrapper with --source=plugin, which the hook
// entry uses to stay inert until the repo is activated and to yield to a
// repo-local install.
const ROOT = process.cwd();
const HOOKS = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")) as {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
};

describe("plugin hooks.json", () => {
  it("declares the five groups the repo-local installer writes, in the same shape", () => {
    const groups = Object.entries(HOOKS.hooks).flatMap(([event, gs]) => gs.map((g) => `${event}${g.matcher ? `:${g.matcher}` : ""}`));
    expect(groups).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse:Edit|Write|MultiEdit", "PostToolUse:Bash", "Stop"]);
  });

  it("every entry runs the wrapper from the plugin root with --source=plugin and a timeout", () => {
    for (const gs of Object.values(HOOKS.hooks)) {
      for (const g of gs) {
        expect(g.hooks).toHaveLength(1);
        const h = g.hooks[0];
        expect(h.type).toBe("command");
        expect(h.command).toBe('"${CLAUDE_PLUGIN_ROOT}/hooks/vibedrift-hook" --source=plugin');
        expect(h.timeout).toBe(10);
      }
    }
  });

  it("the wrapper is executable, prefers a plugin-aware global install, falls back to npx, and fails open", () => {
    const mode = statSync(join(ROOT, "hooks", "vibedrift-hook")).mode;
    expect(mode & 0o111).not.toBe(0);
    const body = readFileSync(join(ROOT, "hooks", "vibedrift-hook"), "utf8");
    expect(body).toContain("npm root -g");
    expect(body).toContain("dist/session/hook-entry.js");
    // an older global install (no plugin mode in its hook) must be skipped
    expect(body).toContain("grep -q -- '--source=plugin'");
    expect(body).toContain("npx -y @vibedrift/cli session-hook");
    // only an advisory (2) passes through; everything else is 0
    expect((body.match(/\[ "\$code" -eq 2 \] && exit 2/g) ?? []).length).toBe(2);
    expect(body.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("the built hook entry carries the plugin-mode marker the wrapper looks for", () => {
    // The wrapper greps the global install's bundle for this string; the
    // source must keep it verbatim or every global install is skipped.
    const entry = readFileSync(join(ROOT, "src", "session", "hook-main.ts"), "utf8");
    expect(entry).toContain('"--source=plugin"');
  });
});
