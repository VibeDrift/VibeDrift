import { describe, it, expect } from "vitest";
import { phantomScaffolding } from "../../../src/drift/phantom-scaffolding.js";
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
});
