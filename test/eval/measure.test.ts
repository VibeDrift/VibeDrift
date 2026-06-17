import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { introducedDrift } from "../../eval/measure.js";

// ESM-safe fixture path (no __dirname under "type":"module").
const REPO = fileURLToPath(new URL("../../eval/fixtures/repos/async-await-repo", import.meta.url));

// Multi-line bodies: asyncCounts counts per LINE, so the async ops must be on
// separate lines to register (a one-liner `.then().then()` counts as 1).
const THEN_BODY = [
  "export function loadThing(id) {",
  "  return db.things.findById(id)",
  "    .then((row) => enrich(row))",
  "    .then((full) => full);",
  "}",
].join("\n");

const AWAIT_BODY = [
  "export async function loadThing(id) {",
  "  const row = await db.things.findById(id);",
  "  const full = await enrich(row);",
  "  return full;",
  "}",
].join("\n");

describe("introducedDrift", () => {
  it("counts drift when the new file violates the repo's dominant async style", async () => {
    const m = await introducedDrift(REPO, [{ path: "thing-service.ts", body: THEN_BODY }]);
    expect(m.introduced).toBeGreaterThan(0);
    expect(m.findings.some((x) => x.category === "async_patterns" && x.file === "thing-service.ts")).toBe(true);
    expect(m.scoringVersion).toBeTruthy();
  });

  it("counts ZERO async drift when the new file conforms to async/await", async () => {
    const m = await introducedDrift(REPO, [{ path: "thing-service.ts", body: AWAIT_BODY }]);
    expect(m.findings.some((x) => x.category === "async_patterns")).toBe(false);
  });
});

// Verifies the discriminating experiment's metric BEFORE spending API money:
// in the .then()-dominant repo, an async/await file (Opus's default) must count
// as drift, and a .then() file (the repo's convention) must not.
const THEN_REPO = fileURLToPath(new URL("../../eval/fixtures/repos/then-chain-repo", import.meta.url));

describe("introducedDrift — then-chain-repo (metric direction is inverted vs async repo)", () => {
  it("flags async/await as drift in a .then()-dominant repo", async () => {
    const m = await introducedDrift(THEN_REPO, [{ path: "things.ts", body: AWAIT_BODY }]);
    expect(m.findings.some((x) => x.category === "async_patterns" && x.file === "things.ts")).toBe(true);
  });
  it("does NOT flag .then() (the repo's convention) as async drift", async () => {
    const m = await introducedDrift(THEN_REPO, [{ path: "things.ts", body: THEN_BODY }]);
    expect(m.findings.some((x) => x.category === "async_patterns")).toBe(false);
  });
});
