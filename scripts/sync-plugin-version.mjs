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
 * A JSON.parse cross-check guards the regex: if the first version-shaped
 * line ever stops being the top-level "version" key, the disagreement
 * fails loudly instead of silently rewriting the wrong line.
 *
 * --check additionally validates the plugin manifests themselves: both
 * .claude-plugin JSON files parse, and every path in plugin.json's "skills"
 * array contains a SKILL.md. CI runs --check, so a malformed manifest or a
 * renamed skills directory cannot ship green on version lockstep alone.
 *
 * Usage:
 *   node scripts/sync-plugin-version.mjs          # write plugin.json to match package.json
 *   node scripts/sync-plugin-version.mjs --check   # CI: fail on drift or invalid manifests, write nothing
 *
 * SYNC_PLUGIN_ROOT overrides the repo root (used by the unit tests to run
 * against fixture directories).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.SYNC_PLUGIN_ROOT ?? path.resolve(__dirname, "..");
const PKG_PATH = path.join(REPO_ROOT, "package.json");
const PLUGIN_PATH = path.join(REPO_ROOT, ".claude-plugin", "plugin.json");
const MARKETPLACE_PATH = path.join(REPO_ROOT, ".claude-plugin", "marketplace.json");

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

// Cross-check the regex against a real parse: the line the regex found must
// be the top-level "version" key, or the format-preserving writer would
// target the wrong line.
let pluginParsed;
try {
  pluginParsed = JSON.parse(pluginRaw);
} catch (err) {
  console.error(`ERROR: ${PLUGIN_PATH} is not valid JSON: ${err.message}`);
  process.exit(1);
}
if (pluginParsed.version !== pluginVersion) {
  console.error(
    `ERROR: the first "version" line in ${PLUGIN_PATH} (${pluginVersion}) is not ` +
      `the top-level version key (${pluginParsed.version}). Fix the file layout ` +
      `before syncing.`,
  );
  process.exit(1);
}

if (checkOnly) {
  if (pluginVersion !== pkgVersion) {
    console.error(
      `ERROR: version drift between package.json (${pkgVersion}) and ` +
        `.claude-plugin/plugin.json (${pluginVersion}).\n` +
        `       Run: node scripts/sync-plugin-version.mjs`,
    );
    process.exit(1);
  }

  // Manifest validity: marketplace.json parses, and every declared skill
  // path actually contains a SKILL.md.
  try {
    JSON.parse(fs.readFileSync(MARKETPLACE_PATH, "utf8"));
  } catch (err) {
    console.error(`ERROR: ${MARKETPLACE_PATH} is missing or not valid JSON: ${err.message}`);
    process.exit(1);
  }
  for (const skillPath of pluginParsed.skills ?? []) {
    const skillMd = path.join(REPO_ROOT, skillPath, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      console.error(
        `ERROR: plugin.json declares skill "${skillPath}" but ${skillMd} does not exist.`,
      );
      process.exit(1);
    }
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
