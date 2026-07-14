import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { buildAnalysisContext } from "../../src/core/discovery.js";
import { runDriftDetection } from "../../src/drift/index.js";

const execP = promisify(exec);

async function run(cwd: string, cmd: string): Promise<void> {
  await execP(cmd, { cwd });
}

async function gitInit(dir: string): Promise<void> {
  await run(dir, "git init -q");
  await run(dir, 'git config user.email "test@example.com"');
  await run(dir, 'git config user.name "Test"');
  await run(dir, "git config core.hooksPath .git/hooks-disabled");
}

async function commit(dir: string, isoDate: string, msg: string): Promise<void> {
  const env = { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
  await execP("git add -A", { cwd: dir, env });
  await execP(`git commit -q -m "${msg}"`, { cwd: dir, env });
}

/**
 * Write a handler file using one of two architectural patterns so the
 * architectural-contradiction detector can classify it.
 */
function handlerFile(pattern: "raw_sql" | "repository"): string {
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

describe("temporal pivot detection — integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vibedrift-pivot-int-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("identifies legacy files when the codebase has pivoted to a new pattern", async () => {
    // Setup:
    //   - 5 handlers committed 400 days ago, all using raw_sql
    //   - 5 handlers committed 10 days ago, all using repository
    //
    // Without temporal awareness, the vote would be a 5-5 tie and no
    // drift would be flagged. With temporal awareness, the repository
    // pattern wins (recent files ~2x weight), and the 5 old raw_sql
    // handlers get classified as `legacy` (not drift).

    await gitInit(dir);
    await mkdir(join(dir, "src/handlers"), { recursive: true });
    await mkdir(join(dir, "src/repos"), { recursive: true });
    await mkdir(join(dir, "src/db"), { recursive: true });

    // Skeleton files to provide minimum directory structure. Repositoryclass
    // + database helper — these are consistent with the "repository" pattern
    // the new handlers use, and don't themselves trigger the contradiction
    // detector.
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
    await writeFile(join(dir, "package.json"), '{"name":"pivot-test","type":"module"}\n');

    // Round 1: 5 old raw_sql handlers, committed 400 days ago
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(dir, `src/handlers/legacy${i}Handler.ts`),
        handlerFile("raw_sql"),
      );
    }
    const oldDate = new Date(Date.now() - 400 * 86400 * 1000).toISOString();
    await commit(dir, oldDate, "legacy handlers (raw_sql)");

    // Round 2: 5 new repository handlers, committed 10 days ago
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(dir, `src/handlers/new${i}Handler.ts`),
        handlerFile("repository"),
      );
    }
    const recentDate = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
    await commit(dir, recentDate, "new handlers (repository)");

    // Run the full scan pipeline
    const { ctx } = await buildAnalysisContext(dir);
    expect(ctx.hasGitMetadata).toBe(true);

    const { driftFindings } = runDriftDetection(ctx);

    // The architectural data-access finding should have:
    //   - a pivot detection (raw_sql → repository)
    //   - the 5 old files classified as `legacy`
    const archFindings = driftFindings.filter(
      (f) => f.driftCategory === "architectural_consistency" && f.subCategory === "data_access",
    );

    expect(archFindings.length).toBeGreaterThan(0);
    const withPivot = archFindings.find((f) => f.pivot !== undefined);
    expect(withPivot).toBeDefined();
    // The exact pattern label depends on the detector's classifier — we
    // don't assert the name, just that a pivot happened and the
    // legacy→new direction is preserved
    expect(withPivot!.pivot!.toPattern).toBe("repository pattern");
    expect(withPivot!.pivot!.fromPattern).not.toBe("repository pattern");
    expect(withPivot!.legacyFiles).toBeDefined();
    expect(withPivot!.legacyFiles!.length).toBe(5);
    // Every legacy file should be flagged as classification="legacy"
    expect(withPivot!.legacyFiles!.every((f) => f.classification === "legacy")).toBe(true);
  }, 20_000);

  it("does NOT emit a pivot when all files are the same age (no temporal shift)", async () => {
    // Setup: 5 raw_sql + 3 repository, all committed in the same commit.
    // Raw dominant is raw_sql. With equal ages, temporal weighting is
    // uniform and the 3 repository files are ordinary drift — not legacy.
    await gitInit(dir);
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
    await writeFile(join(dir, "package.json"), '{"name":"pivot-test","type":"module"}\n');

    for (let i = 0; i < 5; i++) {
      await writeFile(join(dir, `src/handlers/raw${i}Handler.ts`), handlerFile("raw_sql"));
    }
    for (let i = 0; i < 3; i++) {
      await writeFile(join(dir, `src/handlers/repo${i}Handler.ts`), handlerFile("repository"));
    }
    await commit(dir, new Date().toISOString(), "single commit, mixed patterns");

    const { ctx } = await buildAnalysisContext(dir);
    const { driftFindings } = runDriftDetection(ctx);

    const archFindings = driftFindings.filter(
      (f) => f.driftCategory === "architectural_consistency" && f.subCategory === "data_access",
    );

    // No finding should carry a pivot — everything is same age
    expect(archFindings.every((f) => f.pivot === undefined)).toBe(true);
  }, 20_000);
});
