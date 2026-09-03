import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedSourceFiles,
  readHookClock,
  writeHookClock,
  hookClockPath,
  BASH_CHANGES_MAX_FILES,
  MTIME_SLACK_MS,
} from "@/session/bash-changes";

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Write a file and pin its mtime to `atMs` (utimes takes seconds). */
function writeAt(root: string, rel: string, content: string, atMs: number): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  utimesSync(abs, atMs / 1000, atMs / 1000);
}

const OLD = Date.UTC(2026, 0, 1, 0, 0, 0);
const CLOCK = OLD + 60 * 60 * 1000; // one hour later
const NEW = CLOCK + 60 * 1000; // a minute after the clock

describe("changedSourceFiles", () => {
  it("returns only checkable source files modified since the clock, sorted, repo-relative", async () => {
    const root = tmp("vd-bash-");
    writeAt(root, "src/old.ts", "export const a = 1;\n", OLD);
    writeAt(root, "src/zeta.ts", "export const z = 1;\n", NEW);
    writeAt(root, "src/alpha.ts", "export const b = 1;\n", NEW);
    writeAt(root, "README.md", "# no\n", NEW); // non-code
    writeAt(root, "src/x.test.ts", "it('y', () => {});\n", NEW); // excluded class
    writeAt(root, "scripts/seed-dev.ts", "throw new Error('x');\n", NEW); // excluded class
    writeAt(root, "node_modules/dep/index.ts", "export const d = 1;\n", NEW); // skip dir
    writeAt(root, ".hidden/h.ts", "export const h = 1;\n", NEW); // dot dir
    const r = await changedSourceFiles(root, CLOCK);
    expect(r.files).toEqual(["src/alpha.ts", "src/zeta.ts"]);
    expect(r.truncated).toBe(false);
  });

  it("keeps a file written within the mtime slack of the clock", async () => {
    const root = tmp("vd-bash-slack-");
    writeAt(root, "src/edge.ts", "export const e = 1;\n", CLOCK - MTIME_SLACK_MS + 1);
    writeAt(root, "src/older.ts", "export const o = 1;\n", CLOCK - MTIME_SLACK_MS - 5000);
    const r = await changedSourceFiles(root, CLOCK);
    expect(r.files).toEqual(["src/edge.ts"]);
  });

  it("caps the result at maxFiles and says so", async () => {
    const root = tmp("vd-bash-cap-");
    for (let i = 0; i < BASH_CHANGES_MAX_FILES + 5; i++) {
      writeAt(root, `src/f${String(i).padStart(2, "0")}.ts`, `export const f${i} = ${i};\n`, NEW);
    }
    const r = await changedSourceFiles(root, CLOCK);
    expect(r.files.length).toBe(BASH_CHANGES_MAX_FILES);
    expect(r.truncated).toBe(true);
  });

  it("stops at the wall-clock deadline and reports truncation", async () => {
    const root = tmp("vd-bash-deadline-");
    writeAt(root, "src/a.ts", "export const a = 1;\n", NEW);
    writeAt(root, "src/b.ts", "export const b = 1;\n", NEW);
    let t = 0;
    // every call to now() advances 400ms: the first directory pop is at 400ms
    // (under the 500ms deadline), the second at 800ms is over it.
    const now = () => (t += 400);
    const r = await changedSourceFiles(root, CLOCK, { now, deadlineMs: 500 });
    expect(r.truncated).toBe(true);
    expect(r.files.length).toBeLessThanOrEqual(2);
  });

  it("stops at the visited-entry bound", async () => {
    const root = tmp("vd-bash-visited-");
    for (let i = 0; i < 12; i++) writeAt(root, `src/d${i}/f.ts`, "export const f = 1;\n", NEW);
    const r = await changedSourceFiles(root, CLOCK, { maxVisited: 5 });
    expect(r.truncated).toBe(true);
    expect(r.files.length).toBeLessThan(12);
  });

  it("never throws on an unreadable root", async () => {
    const r = await changedSourceFiles(join(tmp("vd-bash-none-"), "does-not-exist"), CLOCK);
    expect(r).toEqual({ files: [], truncated: false });
  });
});

describe("hook clock", () => {
  it("round-trips lastMs and reads an absent or corrupt clock as empty", async () => {
    const sessions = tmp("vd-clock-");
    expect(await readHookClock(sessions, "hash1", "s1")).toEqual({});
    await writeHookClock(sessions, "hash1", "s1", 1234);
    expect(await readHookClock(sessions, "hash1", "s1")).toEqual({ lastMs: 1234 });
    expect(JSON.parse(readFileSync(hookClockPath(sessions, "hash1", "s1"), "utf8"))).toEqual({ lastMs: 1234 });
    writeFileSync(hookClockPath(sessions, "hash1", "s1"), "{ nope");
    expect(await readHookClock(sessions, "hash1", "s1")).toEqual({});
    writeFileSync(hookClockPath(sessions, "hash1", "s1"), JSON.stringify({ lastMs: "soon" }));
    expect(await readHookClock(sessions, "hash1", "s1")).toEqual({});
  });
});
