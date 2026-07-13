/**
 * Drift injectors. Each takes a baseline file set and a rate (0–1), and
 * returns a new file set with `Math.round(eligibleFiles × rate)` files
 * mutated to deviate from the dominant pattern.
 *
 * Injectors are deterministic: the same (baseline, rate) produces the
 * same output. This matters for reproducible CI runs.
 */

import type { BaselineFile } from "./baseline.js";

function mutate(files: BaselineFile[], matcher: RegExp, count: number, transform: (content: string) => string): BaselineFile[] {
  const eligible = files.filter((f) => matcher.test(f.path));
  const targets = new Set(eligible.slice(0, count).map((f) => f.path));
  return files.map((f) => (targets.has(f.path) ? { ...f, content: transform(f.content) } : f));
}

export function injectArchDrift(baseline: BaselineFile[], rate: number): BaselineFile[] {
  const eligible = baseline.filter((f) => /handlers\/.+Handler\.ts$/.test(f.path)).length;
  const count = Math.round(eligible * rate);
  if (count === 0) return baseline;

  return mutate(baseline, /handlers\/.+Handler\.ts$/, count, (content) => {
    return content
      .replace(/import \{ \w+Repository \} from[^;]+;\n/g, "")
      .replace(/const repo = new \w+Repository\(\);\s*\n\s*const row = await repo\.findById\(id\);/, `const db = await import("../db/database.js").then(m => m.getDatabase());\n  const row = await db.query("SELECT * FROM items WHERE id = $1", [id]);`)
      .replace(/return repo\.findAll\(\);/, `const db = await import("../db/database.js").then(m => m.getDatabase());\n  return db.query("SELECT * FROM items");`);
  });
}

export function injectErrorHandlingDrift(baseline: BaselineFile[], rate: number): BaselineFile[] {
  const eligible = baseline.filter((f) => /services\/.+Service\.ts$/.test(f.path)).length;
  const count = Math.round(eligible * rate);
  if (count === 0) return baseline;

  return mutate(baseline, /services\/.+Service\.ts$/, count, (content) => {
    return content
      .replace(/import \{ ValidationError \} from[^;]+;\n/, "")
      .replace(/throw new ValidationError\([^)]+\);/, `return { error: "name is required" };`);
  });
}

export function injectNamingDrift(baseline: BaselineFile[], rate: number): BaselineFile[] {
  const eligible = baseline.filter((f) => /handlers\/.+Handler\.ts$/.test(f.path)).length;
  const count = Math.round(eligible * rate);
  if (count === 0) return baseline;

  return mutate(baseline, /handlers\/.+Handler\.ts$/, count, (content) => {
    // True snake_case: lowercase the captured name (was `get_$1`, which kept
    // the capital → `get_User`, an ambiguous mixed form the classifier
    // couldn't read as snake_case). A function replacer lowercases the group.
    return content
      .replace(/export async function get(\w+)/g, (_m, n) => `export async function get_${String(n).toLowerCase()}`)
      .replace(/export async function list(\w+)/g, (_m, n) => `export async function list_${String(n).toLowerCase()}`);
  });
}

export function injectSecurityDrift(baseline: BaselineFile[], rate: number): BaselineFile[] {
  const eligible = baseline.filter((f) => /^src\/routes\//.test(f.path)).length;
  const count = Math.round(eligible * rate);
  if (count === 0) return baseline;

  return mutate(baseline, /^src\/routes\//, count, (content) =>
    // Strip the auth middleware arg: router.post("/x", requireAuth, handler)
    // -> router.post("/x", handler). The route survives as a valid (still
    // mutating) route, just missing the auth arg the AST extractor reads.
    content.replace(/,\s*requireAuth\s*,/g, ", "),
  );
}

/**
 * Distinct from `injectSecurityDrift` above, which STRIPS auth from routes (a
 * dominance-vote drift signal on `drift-security_posture`). This plants an
 * ABSOLUTE floor violation — a committed private key literal — into
 * otherwise-clean, non-route files. It trips the high-precision
 * `security-floor` rule (`private-key`, src/analyzers/security.ts), which is
 * scored on its own axis (analyzerId "security-floor") independent of any
 * auth vote, so it calibrates a different rule family than `security` does.
 */
export function injectSecurityFloor(baseline: BaselineFile[], rate: number): BaselineFile[] {
  const eligible = baseline.filter((f) => /^src\/handlers\/.+Handler\.ts$/.test(f.path)).length;
  const count = Math.round(eligible * rate);
  if (count === 0) return baseline;

  return mutate(baseline, /^src\/handlers\/.+Handler\.ts$/, count, (content) =>
    `${content}\n` +
    `// Committed by mistake during a deploy debugging session (do not do this).\n` +
    "const DEPLOY_KEY = `-----BEGIN PRIVATE KEY-----\n" +
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDU9fpAstUbeMwd\n" +
    "Qhq3iF0vG6dGzq2Q4h8mR3jK7yN1pW5xL9tC8sV2bE6oA4uY7wZ0rD3nF1kJ5xHq\n" +
    "-----END PRIVATE KEY-----`;\n",
  );
}

export const INJECTORS: Record<string, (base: BaselineFile[], rate: number) => BaselineFile[]> = {
  architectural: injectArchDrift,
  error_handling: injectErrorHandlingDrift,
  naming: injectNamingDrift,
  security: injectSecurityDrift,
  security_floor: injectSecurityFloor,
};

/**
 * Compound injector: applies every registered injector at the same rate.
 * Used for the "mixed drift" row in the calibration report.
 */
export function injectAll(baseline: BaselineFile[], rate: number): BaselineFile[] {
  let out = baseline;
  for (const inj of Object.values(INJECTORS)) {
    out = inj(out, rate);
  }
  return out;
}
