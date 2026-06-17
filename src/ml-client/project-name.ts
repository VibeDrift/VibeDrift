import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

/**
 * Project identity helpers.
 *
 * The dashboard groups scans by `project_hash` and displays them under a
 * human-readable `project_name`. Both values are computed CLI-side so the
 * server never sees absolute paths, only hashes.
 *
 * Autodetect order for `project_name`:
 *   1. --project-name <flag>                  (explicit override)
 *   2. package.json.name                      (Node/TS projects)
 *   3. Cargo.toml [package] name              (Rust)
 *   4. go.mod module basename                 (Go)
 *   5. pyproject.toml [project] / [tool.poetry] name (Python)
 *   6. basename(rootDir)                      (fallback)
 *
 * `project_hash` is always SHA-256 of the absolute rootDir so the same
 * checkout always groups under the same project, even if the user
 * renames it. Collisions across machines are fine — the hash is scoped
 * to the user's scan history.
 */

export interface ProjectIdentity {
  name: string;
  hash: string;
}

export async function detectProjectIdentity(
  rootDir: string,
  override?: string,
  isPrivate?: boolean,
): Promise<ProjectIdentity> {
  const hash = createHash("sha256").update(rootDir).digest("hex");

  // --private flag: use anonymized name
  if (isPrivate) {
    return { name: `priv${hash.slice(0, 12)}`, hash };
  }

  // Explicit --project-name override wins
  if (override && override.trim()) {
    return { name: override.trim(), hash };
  }

  // Auto-detect from manifest files
  const detected = await autoDetectName(rootDir);
  return { name: detected, hash };
}

/**
 * Auto-detect project name from manifest files.
 * Used for both server upload and local display.
 */
async function autoDetectName(rootDir: string): Promise<string> {
  const fromPackageJson = await readJsonField(join(rootDir, "package.json"), "name");
  if (fromPackageJson) return fromPackageJson;

  const fromCargo = await readTomlFieldInSection(join(rootDir, "Cargo.toml"), "package", "name");
  if (fromCargo) return fromCargo;

  const fromGoMod = await readGoModule(join(rootDir, "go.mod"));
  if (fromGoMod) return fromGoMod;

  const fromPyProject =
    (await readTomlFieldInSection(join(rootDir, "pyproject.toml"), "project", "name")) ??
    (await readTomlFieldInSection(join(rootDir, "pyproject.toml"), "tool.poetry", "name"));
  if (fromPyProject) return fromPyProject;

  return basename(rootDir) || "untitled";
}

/**
 * Returns a display name for local CLI output.
 * Same logic as autoDetectName but allows an explicit override.
 */
export async function detectLocalDisplayName(
  rootDir: string,
  override?: string,
): Promise<string> {
  if (override && override.trim()) return override.trim();
  return autoDetectName(rootDir);
}

async function readJsonField(path: string, field: string): Promise<string | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  } catch {
    // File missing or malformed — treat as "not found"
  }
  return null;
}

/**
 * Minimal TOML reader — finds `[section]` then the first `key = "value"`
 * line within it. Good enough for Cargo.toml / pyproject.toml which
 * both follow a strict structure. Doesn't handle multi-line strings or
 * nested tables, which is fine for our use case.
 */
async function readTomlFieldInSection(
  path: string,
  section: string,
  key: string,
): Promise<string | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n");
    let inSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        inSection = trimmed === `[${section}]`;
        continue;
      }
      if (!inSection) continue;
      const match = trimmed.match(/^([\w-]+)\s*=\s*"([^"]+)"/);
      if (match && match[1] === key && match[2]) {
        return match[2];
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function readGoModule(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const match = raw.match(/^\s*module\s+(\S+)/m);
    if (match && match[1]) {
      // Take the last path segment so "github.com/foo/bar" → "bar"
      const segs = match[1].split("/");
      const last = segs[segs.length - 1];
      if (last) return last;
    }
  } catch {
    // ignore
  }
  return null;
}
