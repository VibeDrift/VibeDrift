import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vibedriftPluginActive, VIBEDRIFT_PLUGIN_ID } from "@/session/plugin-detect";

function home(): string {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "vd-plugin-detect-")));
  mkdirSync(join(h, ".claude", "plugins"), { recursive: true });
  return h;
}
/** An install directory that carries the hooks, as a real plugin copy does. */
function installWithHooks(h: string, version = "0.20.3"): string {
  const dir = join(h, ".claude", "plugins", "cache", "vibedrift", "vibedrift", version);
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
  return dir;
}
function registry(h: string, entries: unknown): void {
  writeFileSync(join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [VIBEDRIFT_PLUGIN_ID]: entries } }));
}
function settings(h: string, enabledPlugins: Record<string, boolean>): void {
  writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ enabledPlugins }));
}

describe("vibedriftPluginActive", () => {
  it("is false with no registry, an empty install list, or unparseable files", () => {
    const h1 = home();
    expect(vibedriftPluginActive(h1)).toBe(false);
    registry(h1, []);
    expect(vibedriftPluginActive(h1)).toBe(false);
    writeFileSync(join(h1, ".claude", "plugins", "installed_plugins.json"), "{ nope");
    expect(vibedriftPluginActive(h1)).toBe(false);
  });

  it("is true when installed and not explicitly disabled", () => {
    const h = home();
    registry(h, [{ scope: "user", installPath: installWithHooks(h), version: "0.20.3" }]);
    expect(vibedriftPluginActive(h)).toBe(true); // no settings.json at all
    settings(h, { [VIBEDRIFT_PLUGIN_ID]: true });
    expect(vibedriftPluginActive(h)).toBe(true);
    settings(h, { "other@x": false });
    expect(vibedriftPluginActive(h)).toBe(true);
  });

  it("is false when installed but disabled in settings", () => {
    const h = home();
    registry(h, [{ scope: "user", installPath: installWithHooks(h), version: "0.20.3" }]);
    settings(h, { [VIBEDRIFT_PLUGIN_ID]: false });
    expect(vibedriftPluginActive(h)).toBe(false);
  });

  // The plugin only started shipping the session hooks in this release. A
  // machine that installed it earlier has it installed AND enabled while the
  // copy on disk carries no hooks at all, so treating it as active makes
  // `enable` skip the repo-local install and leaves the repo activated and
  // listening to nothing. Seen on a real machine: a 0.20.1 plugin cache, four
  // repos enabled, zero events captured.
  it("is false when the installed copy ships no hooks, however enabled it is", () => {
    const h = home();
    const noHooks = join(h, ".claude", "plugins", "cache", "vibedrift", "vibedrift", "0.20.1");
    mkdirSync(noHooks, { recursive: true });
    registry(h, [{ scope: "user", installPath: noHooks, version: "0.20.1" }]);
    settings(h, { [VIBEDRIFT_PLUGIN_ID]: true });
    expect(vibedriftPluginActive(h)).toBe(false);
    // and true again once that same install carries them
    mkdirSync(join(noHooks, "hooks"), { recursive: true });
    writeFileSync(join(noHooks, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
    expect(vibedriftPluginActive(h)).toBe(true);
  });

  it("is false when the install record has no usable path", () => {
    const h = home();
    settings(h, { [VIBEDRIFT_PLUGIN_ID]: true });
    for (const bad of [{ scope: "user" }, { installPath: "" }, { installPath: 7 }, "not-an-object"]) {
      registry(h, [bad]);
      expect(vibedriftPluginActive(h)).toBe(false);
    }
  });
});
