/**
 * Dependency-drift detector (FINDINGS-ONLY — not wired into any score).
 *
 * VibeDrift measures DRIFT — inconsistency in the codebase's OWN choices, not
 * external quality/vulnerability/outdatedness (that is off-mission). This
 * detector surfaces drift in the repo's dependency SELECTION:
 *
 *   1. Duplicate-purpose dependencies — the manifest declares 2+ libraries
 *      that do the same job (e.g. both `axios` and `got` for HTTP). Curated
 *      equivalence groups; one finding per group with 2+ members present.
 *
 *   2. Version-pinning inconsistency (JS/TS package.json only, secondary) —
 *      the version specifiers mix exact pins and caret/tilde ranges without a
 *      dominant style. Conservative: flagged only when BOTH styles are each
 *      >= 25% of the classified deps AND there are >= 8 such deps.
 *
 * IMPORTANT: `analyzerId` is `dependency-drift`, which is deliberately NOT
 * registered in `src/scoring/categories.ts`. The scoring engine keys category
 * membership off `analyzerId` (see computeScoresForKind), so these findings
 * feed NEITHER the composite Vibe Drift Score NOR the Hygiene Score — they are
 * emitted only so we can COUNT them for corpus discrimination validation
 * before deciding whether to score them (per the reimplementation lesson).
 */

import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding } from "../core/types.js";

/**
 * Curated equivalence groups: libraries that do substantially the same job.
 * Declaring 2+ members of a group is dependency drift — the codebase picked
 * more than one way to accomplish the same thing. `label` names the shared
 * purpose so the finding message reads clearly.
 */
interface EquivalenceGroup {
  label: string;
  members: string[];
}

// JS/TS groups matched against package.json dependencies + devDependencies.
const JS_EQUIVALENCE_GROUPS: EquivalenceGroup[] = [
  { label: "utility/functional helpers", members: ["lodash", "underscore", "ramda", "remeda"] },
  { label: "date/time handling", members: ["moment", "dayjs", "date-fns", "luxon"] },
  { label: "HTTP requests", members: ["axios", "got", "node-fetch", "superagent", "request", "ky"] },
  { label: "test runners", members: ["mocha", "jest", "vitest", "jasmine", "ava", "tape"] },
  { label: "assertion libraries", members: ["chai", "expect", "should"] },
  { label: "web frameworks", members: ["express", "koa", "fastify", "hapi", "restify"] },
  { label: "bundlers", members: ["webpack", "rollup", "esbuild", "parcel", "vite"] },
  { label: "state management", members: ["redux", "mobx", "zustand", "jotai", "recoil", "valtio"] },
  { label: "schema validation", members: ["zod", "yup", "joi", "ajv", "superstruct"] },
  { label: "CSS-in-JS", members: ["styled-components", "emotion", "@emotion/react", "stitches"] },
  { label: "React component testing", members: ["enzyme", "@testing-library/react"] },
];

// Python groups matched against requirements.txt / pyproject.toml dependency
// names (already lowercased + version-stripped by loadRequirementsTxt).
const PYTHON_EQUIVALENCE_GROUPS: EquivalenceGroup[] = [
  { label: "HTTP clients", members: ["requests", "httpx", "aiohttp", "urllib3"] },
  { label: "web frameworks", members: ["flask", "django", "fastapi", "bottle", "tornado"] },
  { label: "test frameworks", members: ["unittest", "pytest", "nose2"] },
  { label: "ORMs", members: ["sqlalchemy", "peewee", "tortoise-orm"] },
  { label: "data validation", members: ["pydantic", "marshmallow", "cerberus"] },
];

/**
 * Emit one duplicate-purpose finding per equivalence group with 2+ declared
 * members. Groups with 0 or 1 member present are ignored.
 */
function detectDuplicatePurpose(
  declared: Set<string>,
  groups: EquivalenceGroup[],
  manifestFile: string,
): Finding[] {
  const findings: Finding[] = [];

  for (const group of groups) {
    const present = group.members.filter((m) => declared.has(m));
    if (present.length < 2) continue;

    findings.push({
      analyzerId: "dependency-drift",
      severity: "warning",
      confidence: 0.85,
      message:
        `Duplicate-purpose dependencies: ${present.join(", ")} all do ${group.label} — ` +
        `the codebase drifted across ${present.length} equivalent libraries`,
      locations: [{ file: manifestFile }],
      tags: ["dependencies", "drift", "duplicate-purpose"],
    });
  }

  return findings;
}

type PinStyle = "exact" | "caretTilde" | "other";

/**
 * Classify a package.json version specifier as an exact pin, a caret/tilde
 * range, or "other" (wildcards, workspace/file/link/git/url protocols, comparator
 * ranges, npm: aliases, `latest`). Only exact vs caret/tilde participate in the
 * pinning-inconsistency signal; "other" specifiers are neither a pin nor a range
 * style and are excluded so they don't skew the fractions.
 */
function classifyPinStyle(spec: string): PinStyle {
  const s = spec.trim();
  if (!s) return "other";
  if (s.startsWith("^") || s.startsWith("~")) return "caretTilde";
  // Non-semver / protocol specifiers — not a pin-vs-range style signal.
  if (
    s === "*" ||
    s === "latest" ||
    s === "x" ||
    /^(workspace|file|link|git|github|npm|http|https):/i.test(s) ||
    s.includes("/") || // github shorthand like user/repo, or url paths
    /[<>=|]/.test(s) || // comparator ranges: >=1.2.3, 1 || 2
    s.includes(" ") || // range unions: "1.2.3 - 2.0.0"
    s.includes("*") ||
    s.includes("x")
  ) {
    return "other";
  }
  // A bare version (optionally with prerelease/build metadata), no range prefix.
  if (/^\d+\.\d+\.\d+/.test(s) || /^\d+\.\d+$/.test(s) || /^\d+$/.test(s)) return "exact";
  return "other";
}

const PIN_MIN_CLASSIFIED = 8;
const PIN_MIN_STYLE_FRACTION = 0.25;

/**
 * Detect version-pinning inconsistency: a significant split between exact pins
 * and caret/tilde ranges. Conservative — flagged only when there are at least
 * PIN_MIN_CLASSIFIED classified deps and each style is at least
 * PIN_MIN_STYLE_FRACTION of them. "other"-style specifiers are excluded from
 * both the denominator and the fractions.
 */
function detectPinningInconsistency(
  specifiers: string[],
  manifestFile: string,
): Finding[] {
  let exact = 0;
  let caretTilde = 0;
  for (const spec of specifiers) {
    const style = classifyPinStyle(spec);
    if (style === "exact") exact++;
    else if (style === "caretTilde") caretTilde++;
  }

  const classified = exact + caretTilde;
  if (classified < PIN_MIN_CLASSIFIED) return [];

  const exactFrac = exact / classified;
  const caretFrac = caretTilde / classified;
  if (exactFrac < PIN_MIN_STYLE_FRACTION || caretFrac < PIN_MIN_STYLE_FRACTION) return [];

  return [
    {
      analyzerId: "dependency-drift",
      severity: "info",
      confidence: 0.7,
      message:
        `Inconsistent version pinning: ${exact} exact pins vs ${caretTilde} caret/tilde ranges ` +
        `(${Math.round(exactFrac * 100)}% exact / ${Math.round(caretFrac * 100)}% ranged across ${classified} deps) — ` +
        `the manifest drifted between two pinning styles`,
      locations: [{ file: manifestFile }],
      tags: ["dependencies", "drift", "version-pinning"],
    },
  ];
}

export const dependencyDriftAnalyzer: Analyzer = {
  id: "dependency-drift",
  name: "Dependency Drift",
  // NOTE: `category` is a required field on the Analyzer interface, but the
  // scoring engine does NOT read it — category membership is resolved by
  // `analyzerId` against CATEGORY_CONFIG (src/scoring/categories.ts), where
  // `dependency-drift` is intentionally ABSENT. This value is therefore inert
  // for scoring; it exists only to satisfy the type. Findings from this
  // analyzer feed neither the composite nor the hygiene score.
  category: "dependencyHealth",
  requiresAST: false,
  applicableLanguages: "all",
  version: 1,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    // JS/TS: duplicate-purpose across dependencies + devDependencies, plus the
    // version-pinning consistency check (JS-only, package.json specifiers).
    if (ctx.packageJson) {
      const pkg = ctx.packageJson;
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const declared = new Set(Object.keys(deps).map((d) => d.toLowerCase()));

      findings.push(
        ...detectDuplicatePurpose(declared, JS_EQUIVALENCE_GROUPS, "package.json"),
      );
      findings.push(
        ...detectPinningInconsistency(Object.values(deps), "package.json"),
      );
    }

    // Python: duplicate-purpose across requirements.txt / pyproject.toml deps.
    // (No pinning check — the loader strips versions, so specifier styles aren't
    // available; pinning is a JS-only signal for now.)
    if (ctx.requirementsTxt) {
      const declared = new Set(ctx.requirementsTxt.map((d) => d.toLowerCase()));
      findings.push(
        ...detectDuplicatePurpose(declared, PYTHON_EQUIVALENCE_GROUPS, "requirements.txt"),
      );
    }

    return findings;
  },
};
