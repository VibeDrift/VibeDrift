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
    registry(h, [{ scope: "user", installPath: "/x", version: "0.20.1" }]);
    expect(vibedriftPluginActive(h)).toBe(true); // no settings.json at all
    settings(h, { [VIBEDRIFT_PLUGIN_ID]: true });
    expect(vibedriftPluginActive(h)).toBe(true);
    settings(h, { "other@x": false });
    expect(vibedriftPluginActive(h)).toBe(true);
  });

  it("is false when installed but disabled in settings", () => {
    const h = home();
    registry(h, [{ scope: "user", installPath: "/x", version: "0.20.1" }]);
    settings(h, { [VIBEDRIFT_PLUGIN_ID]: false });
    expect(vibedriftPluginActive(h)).toBe(false);
  });
});
