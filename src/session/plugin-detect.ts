/**
 * Is the VibeDrift Claude Code plugin installed and enabled for this user?
 *
 * The plugin ships the Drift Sessions hooks (hooks/hooks.json), so when it is
 * active, `enable` should NOT also install the repo-local hooks: both would
 * fire on every event, the plugin run would yield to the repo-local marker,
 * and the user would pay one extra node process per hook event for nothing.
 * With the plugin active, activation alone is enough; the plugin hooks
 * capture.
 *
 * Read from Claude Code's own registry: `~/.claude/plugins/installed_plugins.json`
 * (v2: `plugins["vibedrift@vibedrift"]` is a non-empty array of installs) and
 * `~/.claude/settings.json` (`enabledPlugins["vibedrift@vibedrift"]`, where an
 * explicit `false` disables). Fail-closed: any read or parse error means
 * "not active", so the repo-local install proceeds as before.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const VIBEDRIFT_PLUGIN_ID = "vibedrift@vibedrift";

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function vibedriftPluginActive(homeDir: string): boolean {
  const registry = readJson(join(homeDir, ".claude", "plugins", "installed_plugins.json"));
  const plugins = registry?.plugins;
  if (plugins === null || typeof plugins !== "object") return false;
  const installs = (plugins as Record<string, unknown>)[VIBEDRIFT_PLUGIN_ID];
  if (!Array.isArray(installs) || installs.length === 0) return false;
  const settings = readJson(join(homeDir, ".claude", "settings.json"));
  const enabled = settings?.enabledPlugins;
  if (enabled !== null && typeof enabled === "object") {
    if ((enabled as Record<string, unknown>)[VIBEDRIFT_PLUGIN_ID] === false) return false;
  }
  return true;
}
