import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

let cached: string | null = null;

/**
 * Returns the current VibeDrift version, read from package.json at runtime.
 * Works both in the bundled dist/ output and when running from source.
 */
export function getVersion(): string {
  if (cached) return cached;

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/index.js → ../package.json
    // src/core/version.ts (dev) → ../../package.json
    const candidates = [
      join(here, "..", "package.json"),
      join(here, "..", "..", "package.json"),
      join(here, "..", "..", "..", "package.json"),
    ];

    for (const path of candidates) {
      try {
        const content = readFileSync(path, "utf-8");
        const pkg = JSON.parse(content) as { name?: string; version?: string };
        if (pkg.name === "@vibedrift/cli" && pkg.version) {
          cached = pkg.version;
          return cached;
        }
      } catch {
        // Try next candidate
      }
    }
  } catch {
    // Fall through
  }

  cached = "0.0.0";
  return cached;
}
// Action validation test
// npx -y fix
// shell fix
// composite action
// npm global fix
// report link fix
