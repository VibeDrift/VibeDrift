/**
 * Test-structure consistency detector.
 *
 * Looks at test files only (*.test.*, *.spec.*, __tests__/*) and classifies:
 *   - framework: bdd_nested (describe/it), flat_test (test()),
 *                 mocha-specific, ava-specific
 *   - mocking style: framework_mocks (jest.fn / vi.fn), sinon, manual
 *
 * AI-generated tests are notoriously inconsistent — same project will have
 * three frameworks of mock + two test styles. Project-scoped vote (test
 * conventions usually do span the whole project).
 */

import type { DriftDetector, DriftContext, DriftFinding, DriftFile, Evidence, DeviatingFile } from "./types.js";
import { buildPatternDistribution, collectDeviatingFiles, pickDominantFiles, pickIntentHint, seedDominanceVote } from "./utils.js";
import type { IntentHint } from "../intent/types.js";

type Framework = "bdd_nested" | "flat_test" | "mocha" | "ava" | "tap";
type MockStyle = "framework_mocks" | "sinon" | "manual";

const FRAMEWORK_NAMES: Record<Framework, string> = {
  bdd_nested: "describe/it (BDD)",
  flat_test: "test() (flat)",
  mocha: "mocha",
  ava: "ava",
  tap: "tap",
};

const MOCK_NAMES: Record<MockStyle, string> = {
  framework_mocks: "jest.fn / vi.fn",
  sinon: "sinon",
  manual: "manual stubs",
};

function isTestFile(path: string): boolean {
  return /(?:\.test\.|\.spec\.|__tests__\/|__test__\/)/i.test(path);
}

interface TestProfile {
  file: string;
  patterns: { pattern: string; evidence: Evidence[] }[];
}

function classifyFramework(content: string): Framework | null {
  if (/\btap\.test\(|tap\.beforeEach\(/.test(content)) return "tap";
  if (/^import\s+test\s+from\s+['"]ava['"]/m.test(content) || /\bava\.test\(/.test(content)) return "ava";
  if (/\bdescribe\s*\([^)]*\)\s*,\s*function\b/.test(content) && /\bbefore\(|\bafter\(/.test(content)) return "mocha";
  if (/\bdescribe\s*\(\s*['"]/.test(content) && /\bit\s*\(\s*['"]/.test(content)) return "bdd_nested";
  if (/^test\s*\(\s*['"]/m.test(content) || /\bvitest\b.*\btest\(/.test(content)) return "flat_test";
  return null;
}

function classifyMockStyle(content: string): MockStyle | null {
  if (/\b(?:jest|vi)\.(?:fn|mock|spyOn|spyOn)\(/.test(content)) return "framework_mocks";
  if (/\bsinon\.(?:stub|spy|mock|fake)\(/.test(content)) return "sinon";
  if (/\bconst\s+\w+Stub\s*=\s*\{|\bconst\s+\w+Mock\s*=\s*\{/.test(content)) return "manual";
  return null;
}

function buildTestProfiles(files: DriftFile[], classifier: (c: string) => string | null): TestProfile[] {
  const profiles: TestProfile[] = [];
  for (const file of files) {
    if (!file.language) continue;
    if (file.language !== "javascript" && file.language !== "typescript") continue;
    if (!isTestFile(file.path)) continue;
    const family = classifier(file.content);
    if (!family) continue;
    // Empty evidence: framework / mock-style classification is a file-level
    // property. A synthetic line-1 entry would render as a misleading code
    // snippet in the report.
    profiles.push({
      file: file.path,
      patterns: [{ pattern: family, evidence: [] }],
    });
  }
  return profiles;
}

function buildFinding<T extends string>(
  profiles: TestProfile[],
  names: Record<T, string>,
  axis: string,
  hint: IntentHint | null,
): DriftFinding | null {
  if (profiles.length < 5) return null;
  const dist = buildPatternDistribution(profiles as { file: string; patterns: { pattern: T; evidence: Evidence[] }[] }[]);
  // With a hint we proceed even when all files agree — so we can emit a
  // divergence finding if the unanimous choice disagrees with the hint.
  if (dist.size < 2 && !hint) return null;

  // Hint must target the correct sub-axis. The framework and mocking-style
  // axes share a parser category (`test_structure_consistency`) but the
  // hint's pattern must match a value from the right enum. If the hint
  // targets a pattern not in `names`, treat it as absent for this axis.
  const applicableHint = hint && (hint.pattern in names) ? hint : null;

  const seeded = seedDominanceVote(dist, applicableHint);
  if (!seeded.dominant) return null;
  // Without a hint require the usual 70% majority. With a hint, the
  // declaration alone justifies emitting.
  if (!applicableHint && seeded.dominantCount / profiles.length < 0.7) return null;

  const deviators: DeviatingFile[] = collectDeviatingFiles(
    dist,
    seeded.dominant,
    profiles as { file: string; patterns: { pattern: T; evidence: Evidence[] }[] }[],
    names,
  );
  const divergence = seeded.declaredMatched === false;
  if (deviators.length === 0 && !divergence) return null;

  return {
    detector: "test-structure-consistency",
    subCategory: axis,
    driftCategory: "test_structure_consistency",
    severity: deviators.length >= 3 ? "warning" : "info",
    confidence: 0.7,
    finding: divergence
      ? `Team declared ${names[seeded.declaredPattern as T] ?? seeded.declaredPattern} in ${applicableHint!.source} but ${axis} in ${seeded.dominantCount}/${profiles.length} test files is ${names[seeded.dominant]}`
      : `Test ${axis}: ${seeded.dominantCount} files use ${names[seeded.dominant]}, ${deviators.length} use a different style`,
    dominantPattern: names[seeded.dominant],
    dominantCount: seeded.dominantCount,
    totalRelevantFiles: profiles.length,
    consistencyScore: Math.round((seeded.dominantCount / profiles.length) * 100),
    deviatingFiles: deviators,
    dominantFiles: pickDominantFiles(dist, seeded.dominant),
    recommendation: divergence
      ? `Team convention in ${applicableHint!.source}:${applicableHint!.line} says use ${applicableHint!.label}. Migrate test ${axis} to match the declaration.`
      : `Standardize on ${names[seeded.dominant]}. Inconsistent test ${axis} makes the suite harder to read and maintain.`,
  };
}

export const testStructureConsistency: DriftDetector = {
  id: "test-structure-consistency",
  name: "Test Structure Consistency",
  category: "test_structure_consistency",

  detect(ctx: DriftContext): DriftFinding[] {
    const findings: DriftFinding[] = [];

    // Single parser category `test_structure_consistency` covers both
    // axes (framework + mock style). `buildFinding` filters the hint to
    // only apply when its pattern belongs to the axis being processed.
    const hint = pickIntentHint(ctx, "test_structure_consistency");

    const fwProfiles = buildTestProfiles(ctx.files, classifyFramework);
    const fwFinding = buildFinding(fwProfiles, FRAMEWORK_NAMES, "framework", hint);
    if (fwFinding) findings.push(fwFinding);

    const mockProfiles = buildTestProfiles(ctx.files, classifyMockStyle);
    const mockFinding = buildFinding(mockProfiles, MOCK_NAMES, "mocking_style", hint);
    if (mockFinding) findings.push(mockFinding);

    return findings;
  },
};
