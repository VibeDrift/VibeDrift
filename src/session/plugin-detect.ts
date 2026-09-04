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
 * Being installed and enabled is NOT enough: the copy on disk must actually
 * carry `hooks/hooks.json`. The plugin only gained the session hooks in this
 * release, so a machine that installed it earlier has an enabled plugin with
 * no hooks at all. Treating that as active made `enable` skip the repo-local
 * install, which left the repo activated and listening to nothing — observed
 * on a real machine carrying a 0.20.1 plugin cache, where four repos were
 * enabled and captured no events. Each install records its `installPath`, so
 * the hooks are checked where they would actually be read from.
 *
 * Read from Claude Code's own registry: `~/.claude/plugins/installed_plugins.json`
 * (v2: `plugins["vibedrift@vibedrift"]` is a non-empty array of installs) and
 * `~/.claude/settings.json` (`enabledPlugins["vibedrift@vibedrift"]`, where an
 * explicit `false` disables). Fail-closed: any read or parse error means
 * "not active", so the repo-local install proceeds as before.
 */

import { existsSync, readFileSync } from "node:fs";
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
  // The installed copy must carry the hooks, or it captures nothing.
  return installs.some(shipsHooks);
}

/** Does this recorded install actually carry `hooks/hooks.json` on disk? */
function shipsHooks(install: unknown): boolean {
  if (install === null || typeof install !== "object") return false;
  const path = (install as Record<string, unknown>).installPath;
  if (typeof path !== "string" || path.length === 0) return false;
  try {
    return existsSync(join(path, "hooks", "hooks.json"));
  } catch {
    return false;
  }
}
