import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildAnalysisContext } from "../../src/core/discovery.js";
import { runDriftDetection } from "../../src/drift/index.js";

/**
 * Helper: write a typescript handler that uses one of two architectural
 * patterns (same pair used by the temporal-pivot integration test).
 */
function handlerCode(pattern: "raw_sql" | "repository"): string {
  if (pattern === "raw_sql") {
    return `
export async function getUser(id: string) {
  const db = await import("../db/database.js").then((m) => m.getDatabase());
  const result = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0];
}
export async function listUsers() {
  const db = await import("../db/database.js").then((m) => m.getDatabase());
  const result = await db.query("SELECT * FROM users");
  return result.rows;
}
`;
  }
  return `
import { UserRepository } from "../repos/UserRepository.js";
export async function getUser(id: string) {
  const repo = new UserRepository();
  return repo.findById(id);
}
export async function listUsers() {
  const repo = new UserRepository();
  return repo.findAll();
}
`;
}

async function setupSkeleton(dir: string): Promise<void> {
  await mkdir(join(dir, "src/handlers"), { recursive: true });
  await mkdir(join(dir, "src/repos"), { recursive: true });
  await mkdir(join(dir, "src/db"), { recursive: true });
  await writeFile(
    join(dir, "src/repos/UserRepository.ts"),
    `export class UserRepository {
  async findById(id: string) { return null; }
  async findAll() { return []; }
}\n`,
  );
  await writeFile(
    join(dir, "src/db/database.ts"),
    `export function getDatabase() {
  return { query: async (_sql: string, _args?: any[]) => ({ rows: [] }) };
}\n`,
  );
  await writeFile(join(dir, "package.json"), '{"name":"intent-test","type":"module"}\n');
}

describe("intent hints — integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vibedrift-intent-int-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads intent hints into the scan context", async () => {
    await setupSkeleton(dir);
    await writeFile(
      join(dir, "CLAUDE.md"),
      `## Conventions\n- Use the repository pattern for data access\n- Use async/await (no .then chains)\n`,
    );
    const { ctx } = await buildAnalysisContext(dir);
    expect(ctx.intentHints).toBeDefined();
    expect(ctx.intentHints!.length).toBeGreaterThan(0);
    const repo = ctx.intentHints!.find((h) => h.pattern === "repository");
    expect(repo).toBeDefined();
    expect(repo!.source).toBe("CLAUDE.md");
  });

  it("flags intent divergence when CLAUDE.md declares repository but code uses raw SQL", async () => {
    await setupSkeleton(dir);
    await writeFile(
      join(dir, "CLAUDE.md"),
      `## Conventions\n- Use the repository pattern for data access\n`,
    );
    // 6 handlers using raw SQL (violating the declaration)
    for (let i = 0; i < 6; i++) {
      await writeFile(
        join(dir, `src/handlers/handler${i}.ts`),
        handlerCode("raw_sql"),
      );
    }

    const { ctx } = await buildAnalysisContext(dir);
    expect(ctx.intentHints!.length).toBeGreaterThan(0);

    const { driftFindings } = runDriftDetection(ctx);
    const archFindings = driftFindings.filter(
      (f) => f.driftCategory === "architectural_consistency" && f.subCategory === "data_access",
    );
    // There should be at least one finding with intentDivergence populated
    const withDivergence = archFindings.find((f) => f.intentDivergence !== undefined);
    expect(withDivergence).toBeDefined();
    expect(withDivergence!.intentDivergence!.declaredPattern).toBe("repository");
    expect(withDivergence!.intentDivergence!.source).toBe("CLAUDE.md");
  });

  it("no intent-divergence tag when CLAUDE.md's declaration matches the code", async () => {
    await setupSkeleton(dir);
    await writeFile(
      join(dir, "CLAUDE.md"),
      `## Conventions\n- Use the repository pattern for data access\n`,
    );
    // All handlers using repository (agreeing with the declaration)
    for (let i = 0; i < 6; i++) {
      await writeFile(
        join(dir, `src/handlers/handler${i}.ts`),
        handlerCode("repository"),
      );
    }

    const { ctx } = await buildAnalysisContext(dir);
    const { driftFindings } = runDriftDetection(ctx);
    const archFindings = driftFindings.filter(
      (f) => f.driftCategory === "architectural_consistency" && f.subCategory === "data_access",
    );
    // No finding should carry intentDivergence — the declaration matches
    expect(archFindings.every((f) => f.intentDivergence === undefined)).toBe(true);
  });

  it("boosts the declared pattern in a close-call vote", async () => {
    // 3 repository + 4 raw_sql = raw_sql would win flat (4 > 3).
    // With +50% boost on "repository", weighted: repo = 3 × 1.5 = 4.5
    // beats raw_sql = 4. The vote flips.
    await setupSkeleton(dir);
    await writeFile(
      join(dir, "CLAUDE.md"),
      `## Conventions\n- Use the repository pattern for data access\n`,
    );
    for (let i = 0; i < 3; i++) {
      await writeFile(
        join(dir, `src/handlers/repoHandler${i}.ts`),
        handlerCode("repository"),
      );
    }
    for (let i = 0; i < 4; i++) {
      await writeFile(
        join(dir, `src/handlers/sqlHandler${i}.ts`),
        handlerCode("raw_sql"),
      );
    }

    const { ctx } = await buildAnalysisContext(dir);
    const { driftFindings } = runDriftDetection(ctx);
    const archFindings = driftFindings.filter(
      (f) => f.driftCategory === "architectural_consistency" && f.subCategory === "data_access",
    );
    // With the boost, repository should win the vote → 4 raw_sql files
    // are now the deviators.
    const f = archFindings[0];
    expect(f).toBeDefined();
    expect(f.dominantPattern).toBe("repository pattern");
    expect(f.deviatingFiles.length).toBe(4);
  });

  it("handles missing intent files gracefully (silent no-op)", async () => {
    await setupSkeleton(dir);
    // No CLAUDE.md / AGENTS.md / .cursorrules at all
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(dir, `src/handlers/handler${i}.ts`),
        handlerCode("repository"),
      );
    }
    await writeFile(
      join(dir, "src/handlers/oddOne.ts"),
      handlerCode("raw_sql"),
    );

    const { ctx } = await buildAnalysisContext(dir);
    expect(ctx.intentHints).toBeDefined();
    expect(ctx.intentHints!.length).toBe(0);

    const { driftFindings } = runDriftDetection(ctx);
    // Should run normally with no intent-divergence stamps
    expect(driftFindings.every((f) => f.intentDivergence === undefined)).toBe(true);
  });
});
