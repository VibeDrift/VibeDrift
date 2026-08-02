/**
 * Characterization golden for the three shared single-body classifiers.
 *
 * These classifiers are not session-only helpers: they feed the drift detectors
 * and therefore the composite score every user sees. Any refactor that pulls a
 * shared helper out of them must leave their output over this corpus
 * byte-identical. The corpus lives in test/fixtures/classifier-bodies.txt and
 * mixes slices of this repo's own code with realistic bodies for vocabulary the
 * repo itself never uses (ORM, raw SQL, tuple returns) and with boundary bodies
 * that sit ON the thresholds and priority tie-breaks the real code never comes
 * near.
 *
 * What this file catches is bounded by that corpus: it holds a rule only when
 * some body straddles it. The boundary bodies are what make moving an async
 * cutoff or reordering a priority list fail here — without them a classifier can
 * be rewritten around this test.
 *
 * A value below that looks wrong is still the CONTRACT: this file records what
 * the classifiers do today, not what they should ideally do. Changing one means
 * changing the score, so it is a deliberate act, never a refactor side effect.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { classifyAsyncStyle } from "@/drift/async-style";
import { classifyDataAccessLabel } from "@/drift/architectural-contradiction";
import { classifyReturnShapeLabel } from "@/drift/return-shape-consistency";

const CORPUS = readFileSync(new URL("../../fixtures/classifier-bodies.txt", import.meta.url), "utf8");

/** The same file path for every body, so a path-sensitive rule (isRepoFile)
 *  cannot vary between cases. */
const PATH = "src/app/service.ts";

function loadBodies(): Map<string, string> {
  const parts = CORPUS.split(/^=== (.+) ===$/m);
  const out = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 2) {
    out.set(parts[i].trim().split(" ")[0], parts[i + 1].replace(/^\n/, "").replace(/\n$/, ""));
  }
  return out;
}

// name, classifyAsyncStyle, classifyDataAccessLabel, classifyReturnShapeLabel
const GOLDEN: [string, string | null, string | null, string | null][] = [
  ["maskSecrets", null, null, null],
  ["deepAnalyze", "async_await", null, null],
  ["runUploaderOnce", "async_await", "repository pattern", null],
  ["detectRevert", null, null, null],
  ["readOutcomeState", null, null, null],
  ["validateChange", null, null, null],
  ["classifyShape", null, null, null],
  ["classifyAsyncStyle", null, null, "null/undefined sentinels"],
  ["extractFunctionBodies", null, null, "null/undefined sentinels"],
  ["classifyDataAccessLabel", null, null, "null/undefined sentinels"],
  ["loadUserRowsRawSql", "async_await", "direct database calls", null],
  ["listActiveUsersOrm", "async_await", "ORM methods", null],
  ["saveOrderViaRepository", null, "repository pattern", null],
  ["fetchInvoiceThenChain", "then_chains", "inline HTTP client calls", null],
  ["readSettingsNullSentinel", null, null, "null/undefined sentinels"],
  ["parseAmountTuple", null, null, "tuple returns (value, error)"],
  ["createSessionResultObject", null, null, "error-object returns"],
  ["assertPositiveThrows", null, null, "throws on error"],
  // Boundary bodies. Everything above sits at an await ratio of 0 or 1 and
  // shows one pattern per axis, so it pins no threshold and no tie-break: both
  // async cutoffs and both priority orders can be rewritten with the rows above
  // still green. These six sit ON the boundaries instead — 0.8 and 0.2 straddle
  // the 0.7/0.3 cutoffs, 0.5 lands in the mixed band, and the last three each
  // hold two patterns at equal evidence, so only the priority order decides.
  ["retryMostlyAwait", "async_await", null, null],
  ["syncQueueMostlyThen", "then_chains", null, null],
  ["hydrateEvenSplit", "mixed", null, null],
  ["decodeTokenShapeTie", null, null, "tuple returns (value, error)"],
  ["readCursorShapeTie", null, null, "error-object returns"],
  ["loadProfileAccessTie", "async_await", "inline HTTP client calls", null],

  // Issue #87: route registrations share verb names with ORM CRUD calls.
  // The first three must classify as null (they are routers, not data access);
  // the next three are real ORM idioms that must keep classifying as ORM.
  ["mountChiRoutes", null, null, null],
  ["mountFiberRoutes", null, null, null],
  ["mountCustomRouter", null, null, null],
  ["loadUserViaGorm", null, "ORM methods", "tuple returns (value, error)"],
  ["listSeatsViaSequelize", null, "ORM methods", null],
  ["filterUsersViaDjango", null, "ORM methods", null],
  // KNOWN REMAINING FALSE POSITIVE, deliberately pinned rather than fixed.
  // `routes.findOne(pattern)` passes an identifier, not a route-path literal,
  // so it is indistinguishable from `Model.findOne(id)` without receiver or
  // import knowledge. Both gates that would provide that knowledge cost 4 to 6
  // of 8 real ORM idioms, so the recall trade was refused. Tracked in todo.md.
  ["lookupRouteTable", null, "ORM methods", "null/undefined sentinels"],
];

describe("shared single-body classifiers (characterization golden)", () => {
  const bodies = loadBodies();

  it("covers every body in the corpus", () => {
    expect([...bodies.keys()]).toEqual(GOLDEN.map(([name]) => name));
  });

  it.each(GOLDEN)("%s classifies identically", (name, async_, dataAccess, returnShape) => {
    const body = bodies.get(name)!;
    expect(body.length).toBeGreaterThan(0);
    expect(classifyAsyncStyle(body)).toBe(async_);
    expect(classifyDataAccessLabel(body, PATH)).toBe(dataAccess);
    expect(classifyReturnShapeLabel(body)).toBe(returnShape);
  });
});
