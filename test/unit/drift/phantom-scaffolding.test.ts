import { describe, it, expect } from "vitest";
import { phantomScaffolding } from "../../../src/drift/phantom-scaffolding.js";
import { driftFindingToFinding } from "../../../src/drift/index.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function mkCtx(files: DriftFile[]): DriftContext {
  return {
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

function file(path: string, content: string): DriftFile {
  return { path, language: "typescript", content, lineCount: content.split("\n").length };
}

describe("phantom-scaffolding detector", () => {
  it("flags CRUD handlers that have zero incoming imports and no route registration", () => {
    const files = [
      // A file with unused CRUD exports and no route wiring.
      file(
        "src/handlers/ghost.ts",
        `export function createUser() {}\nexport function getUser() {}\nexport function deleteUser() {}\n`,
      ),
      // Another directory with unused CRUD exports.
      file(
        "src/handlers/unused.ts",
        `export function fetchOrder() {}\nexport function updateOrder() {}\n`,
      ),
      // And a file that IS imported somewhere (simulated by having another
      // file import from it) to prove the detector doesn't flag wired exports.
      file(
        "src/services/active.ts",
        `export function fetchThing() {}\n`,
      ),
      file(
        "src/index.ts",
        `import { fetchThing } from "./services/active";\nfetchThing();\n`,
      ),
    ];
    const findings = phantomScaffolding.detect(mkCtx(files));
    // At least one finding for the phantom handlers; none for services/active.ts.
    expect(findings.length).toBeGreaterThan(0);
    const allDeviating = findings.flatMap((f) => f.deviatingFiles.map((d) => d.path));
    expect(allDeviating.some((p) => p.includes("services/active.ts"))).toBe(false);
  });

  it("recognizes Express route registrations and skips registered handlers", () => {
    const files = [
      file(
        "src/handlers/userHandler.ts",
        `export function getUser() {}\nexport function createUser() {}\n`,
      ),
      file(
        "src/routes.ts",
        `import { getUser, createUser } from "./handlers/userHandler";\nrouter.get("/users/:id", getUser);\nrouter.post("/users", createUser);\n`,
      ),
    ];
    const findings = phantomScaffolding.detect(mkCtx(files));
    // Handlers registered in routes.ts — no phantom findings expected.
    expect(findings).toHaveLength(0);
  });

  it("marks every finding countBased so the engine size-normalizes it (no driftSignal)", () => {
    const files = [
      file(
        "src/handlers/ghost.ts",
        `export function createUser() {}\nexport function getUser() {}\nexport function deleteUser() {}\n`,
      ),
      file("src/index.ts", `console.log("entry");\n`),
    ];
    const findings = phantomScaffolding.detect(mkCtx(files));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.countBased).toBe(true);
    }
    // Routed through driftFindingToFinding, a countBased finding omits driftSignal.
    const wired = findings.map(driftFindingToFinding);
    for (const f of wired) {
      expect(f.driftSignal).toBeUndefined();
    }
  });

  it("grades a directory dominated by phantoms as error (high dead share)", () => {
    // 6 CRUD exports in one file, all phantom → dead share 1.0 → error.
    const files = [
      file(
        "src/handlers/dead.ts",
        `export function createUser() {}\nexport function getUser() {}\nexport function updateUser() {}\nexport function deleteUser() {}\nexport function listUser() {}\nexport function findUser() {}\n`,
      ),
      file("src/index.ts", `console.log("entry");\n`),
    ];
    const findings = phantomScaffolding.detect(mkCtx(files));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.severity === "error")).toBe(true);
  });

  it("grades a directory where phantoms are a small share of CRUD exports as info/warning, not error", () => {
    // Same directory: one wired file with many CRUD exports (it IS imported,
    // so none of its exports are phantom) plus one tiny orphan file with a
    // couple of phantom CRUD exports → low dead share for the directory.
    const wiredExports = Array.from({ length: 12 }, (_, i) => `export function getThing${i}() {}`).join("\n");
    const files = [
      file("src/handlers/wired.ts", `${wiredExports}\n`),
      file("src/handlers/orphan.ts", `export function deleteOrphan() {}\nexport function removeStale() {}\n`),
      // Import wired.ts so its 12 CRUD exports count as live; orphan.ts is never imported.
      file(
        "src/index.ts",
        `import { getThing0 } from "./handlers/wired";\ngetThing0();\n`,
      ),
    ];
    const findings = phantomScaffolding.detect(mkCtx(files));
    expect(findings.length).toBeGreaterThan(0);
    // dead share = 2 phantoms / 14 CRUD exports in the dir ≈ 0.14 → info.
    for (const f of findings) {
      expect(f.severity).not.toBe("error");
    }
  });
});
