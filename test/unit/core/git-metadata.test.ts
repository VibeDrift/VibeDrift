import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { collectGitMetadata } from "../../../src/core/git-metadata.js";

const execP = promisify(exec);

async function run(cwd: string, cmd: string): Promise<void> {
  await execP(cmd, { cwd });
}

async function initRepo(dir: string): Promise<void> {
  await run(dir, "git init -q");
  await run(dir, 'git config user.email "test@example.com"');
  await run(dir, 'git config user.name "Test"');
  // Suppress any pre-commit/prepare-commit-msg hooks the user may have
  // configured globally — we want hermetic, fast commits.
  await run(dir, "git config core.hooksPath /dev/null");
}

async function commitWithDate(dir: string, isoDate: string, msg: string): Promise<void> {
  const env = `GIT_AUTHOR_DATE="${isoDate}" GIT_COMMITTER_DATE="${isoDate}"`;
  await run(dir, `${env} git add -A`);
  await run(dir, `${env} git commit -q -m "${msg}"`);
}

describe("collectGitMetadata", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vibedrift-git-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when the directory is not a git repo", async () => {
    await writeFile(join(dir, "a.ts"), "export const a = 1;");
    const result = await collectGitMetadata(dir);
    expect(result).toBeNull();
  });

  it("returns null on an empty git repo with no commits", async () => {
    await initRepo(dir);
    const result = await collectGitMetadata(dir);
    expect(result).toBeNull();
  });

  it("collects per-file metadata on a repo with a single commit", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "handlers.ts"), "export const x = 1;");
    await writeFile(join(dir, "utils.ts"), "export const y = 2;");
    await commitWithDate(dir, "2026-04-10T10:00:00Z", "initial");

    const result = await collectGitMetadata(dir);
    expect(result).not.toBeNull();
    expect(result!.byFile.size).toBe(2);

    const handlers = result!.byFile.get("handlers.ts");
    expect(handlers).toBeDefined();
    expect(handlers!.commitCountTotal).toBe(1);
    expect(handlers!.uniqueAuthors).toBe(1);
  });

  it("captures multiple authors and commit counts across history", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "a.ts"), "v1");
    await commitWithDate(dir, "2026-04-01T00:00:00Z", "first");

    await writeFile(join(dir, "a.ts"), "v2");
    await run(dir, 'git config user.email "other@example.com"');
    await commitWithDate(dir, "2026-04-05T00:00:00Z", "second");

    await writeFile(join(dir, "a.ts"), "v3");
    await commitWithDate(dir, "2026-04-14T00:00:00Z", "third");

    const result = await collectGitMetadata(dir);
    const meta = result!.byFile.get("a.ts");
    expect(meta!.commitCountTotal).toBe(3);
    expect(meta!.uniqueAuthors).toBe(2);
  });

  it("distinguishes recent (≤90d) vs older commits in the 90d bucket", async () => {
    await initRepo(dir);
    // One very old commit touching a.ts
    await writeFile(join(dir, "a.ts"), "old");
    await commitWithDate(dir, "2023-01-01T00:00:00Z", "ancient");

    // One recent commit touching a.ts
    await writeFile(join(dir, "a.ts"), "recent");
    await commitWithDate(dir, new Date().toISOString(), "fresh");

    const result = await collectGitMetadata(dir);
    const meta = result!.byFile.get("a.ts");
    // 2 total, but only 1 within the last 90 days
    expect(meta!.commitCountTotal).toBe(2);
    expect(meta!.commitCount90d).toBe(1);
  });

  it("caches results across runs and serves from cache on the second call", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "a.ts"), "v1");
    await commitWithDate(dir, "2026-04-10T00:00:00Z", "first");

    const first = await collectGitMetadata(dir);
    expect(first).not.toBeNull();
    const head1 = first!.headCommit;

    const second = await collectGitMetadata(dir);
    expect(second).not.toBeNull();
    expect(second!.headCommit).toBe(head1);

    // Make a new commit → HEAD changes → cache should invalidate
    await writeFile(join(dir, "b.ts"), "v1");
    await commitWithDate(dir, "2026-04-14T00:00:00Z", "second");

    const third = await collectGitMetadata(dir);
    expect(third!.headCommit).not.toBe(head1);
    expect(third!.byFile.size).toBe(2); // a.ts + b.ts now
  });

  it("computes lastModifiedDaysAgo against now", async () => {
    await initRepo(dir);
    // Commit dated exactly 30 days ago
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
    await writeFile(join(dir, "a.ts"), "v1");
    await commitWithDate(dir, thirtyDaysAgo, "30 days old");

    const result = await collectGitMetadata(dir);
    const meta = result!.byFile.get("a.ts");
    // Allow ±1 day tolerance for timing
    expect(meta!.lastModifiedDaysAgo).toBeGreaterThanOrEqual(29);
    expect(meta!.lastModifiedDaysAgo).toBeLessThanOrEqual(31);
  });
});
