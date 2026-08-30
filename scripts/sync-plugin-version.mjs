#!/usr/bin/env node
/**
 * sync-plugin-version.mjs
 *
 * Keeps .claude-plugin/plugin.json's "version" in lockstep with the
 * package.json version that scripts/release.sh bumps. The two files must
 * never drift: plugin.json is what `/plugin` installs from, and a stale
 * version there is invisible until someone diffs the two by hand.
 *
 * Regex-replaces just the "version" value in plugin.json in place, so the
 * rest of the file's formatting (key order, spacing) is untouched — unlike
 * a JSON.parse/stringify round-trip, which would reformat the whole file.
 *
 * Usage:
 *   node scripts/sync-plugin-version.mjs          # write plugin.json to match package.json
 *   node scripts/sync-plugin-version.mjs --check   # CI: fail if they differ, write nothing
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PKG_PATH = path.join(REPO_ROOT, "package.json");
const PLUGIN_PATH = path.join(REPO_ROOT, ".claude-plugin", "plugin.json");

const checkOnly = process.argv.includes("--check");

const pkgVersion = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")).version;
if (!pkgVersion) {
  console.error(`ERROR: no "version" field in ${PKG_PATH}`);
  process.exit(1);
}

const pluginRaw = fs.readFileSync(PLUGIN_PATH, "utf8");
const versionLine = /^(\s*"version"\s*:\s*")([^"]*)(")/m;
const match = pluginRaw.match(versionLine);
if (!match) {
  console.error(`ERROR: no "version" field found in ${PLUGIN_PATH}`);
  process.exit(1);
}
const pluginVersion = match[2];

if (checkOnly) {
  if (pluginVersion !== pkgVersion) {
    console.error(
      `ERROR: version drift between package.json (${pkgVersion}) and ` +
        `.claude-plugin/plugin.json (${pluginVersion}).\n` +
        `       Run: node scripts/sync-plugin-version.mjs`,
    );
    process.exit(1);
  }
  console.log(`OK: .claude-plugin/plugin.json matches package.json (${pkgVersion})`);
  process.exit(0);
}

if (pluginVersion === pkgVersion) {
  console.log(`.claude-plugin/plugin.json already at ${pkgVersion}, nothing to do`);
  process.exit(0);
}

const updated = pluginRaw.replace(versionLine, `$1${pkgVersion}$3`);
fs.writeFileSync(PLUGIN_PATH, updated);
console.log(`Synced .claude-plugin/plugin.json: ${pluginVersion} -> ${pkgVersion}`);
