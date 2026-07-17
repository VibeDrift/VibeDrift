/**
 * Lightweight, scoped debug logging for the scan pipeline.
 *
 * Always writes to STDERR (never stdout), so it can never corrupt `--json`
 * output that downstream tools parse. Off by default; enable via either:
 *
 *   VIBEDRIFT_DEBUG=1 vibedrift <path> --deep        # all scopes
 *   VIBEDRIFT_DEBUG=scan,dedup vibedrift <path>      # only these scopes
 *   vibedrift <path> --deep --verbose                # --verbose implies debug
 *
 * Why this exists: a finding-count regression (the cross-layer dedup aliasing
 * bug that silently zeroed every finding in deep mode) was invisible without
 * stage-by-stage counts. Permanent, gated breadcrumbs at the pipeline
 * chokepoints make that class of bug observable without editing source.
 */

let forced = false;

/** Force-enable debug regardless of env (wired to --verbose). */
export function setDebugEnabled(on: boolean): void {
  forced = on;
}

function enabledFor(scope: string): boolean {
  if (forced) return true;
  const v = process.env.VIBEDRIFT_DEBUG;
  if (!v) return false;
  if (v === "1" || v === "true" || v === "*") return true;
  return v.split(",").map((s) => s.trim()).includes(scope);
}

/** True when ANY debug scope is active (guards expensive-to-build messages). */
export function isDebugEnabled(scope = "*"): boolean {
  return enabledFor(scope);
}

/** Emit a scoped debug line to stderr when the scope is enabled. */
export function debug(scope: string, ...args: unknown[]): void {
  if (!enabledFor(scope)) return;
  console.error(`[debug:${scope}]`, ...args);
}
