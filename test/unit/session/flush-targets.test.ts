import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectFlushCandidates,
  orderFlushTargets,
  MAX_CATCH_UP_TARGETS,
  type FlushCandidate,
} from "@/session/flush-targets";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-ftargets-")));

function candidate(over: Partial<FlushCandidate> & { projectHash: string }): FlushCandidate {
  return { pending: 0, inSession: false, touchedAt: 0, ...over };
}

/** A project dir with ledgers and, optionally, committed offsets. */
function project(
  sessionsDir: string,
  hash: string,
  files: Record<string, { body: string; offset?: number; mtime?: number }>,
): void {
  const dir = join(sessionsDir, hash);
  mkdirSync(dir, { recursive: true });
  const state: Record<string, { offset: number }> = {};
  for (const [name, spec] of Object.entries(files)) {
    writeFileSync(join(dir, name), spec.body);
    if (spec.mtime !== undefined) utimesSync(join(dir, name), spec.mtime, spec.mtime);
    if (spec.offset !== undefined) state[name] = { offset: spec.offset };
  }
  if (Object.keys(state).length > 0) {
    writeFileSync(join(dir, "upload-state.json"), JSON.stringify({ v: 1, files: state }));
  }
}

describe("orderFlushTargets", () => {
  it("puts the turn's own project first even with nothing queued", () => {
    const order = orderFlushTargets(
      [candidate({ projectHash: "other", pending: 500, touchedAt: 9 })],
      "mine",
    );
    expect(order[0]).toBe("mine");
    expect(order).toContain("other");
  });

  it("prefers the other repos this session wrote to", () => {
    const order = orderFlushTargets(
      [
        candidate({ projectHash: "stale", pending: 900, touchedAt: 50 }),
        candidate({ projectHash: "sibling", pending: 10, inSession: true, touchedAt: 1 }),
      ],
      "mine",
    );
    expect(order).toEqual(["mine", "sibling", "stale"]);
  });

  it("skips projects with nothing pending", () => {
    const order = orderFlushTargets(
      [
        candidate({ projectHash: "empty", pending: 0, inSession: true }),
        candidate({ projectHash: "queued", pending: 1 }),
      ],
      "mine",
    );
    expect(order).toEqual(["mine", "queued"]);
  });

  it("never repeats the current project", () => {
    const order = orderFlushTargets(
      [candidate({ projectHash: "mine", pending: 400, inSession: true })],
      "mine",
    );
    expect(order).toEqual(["mine"]);
  });

  it("caps the catch-up tail and takes the newest, deterministically", () => {
    const many = Array.from({ length: MAX_CATCH_UP_TARGETS + 4 }, (_, i) =>
      candidate({ projectHash: `p${i}`, pending: 10, touchedAt: i }),
    );
    const order = orderFlushTargets(many, "mine");
    expect(order.length).toBe(MAX_CATCH_UP_TARGETS + 1);
    // newest first: the highest touchedAt wins
    expect(order[1]).toBe(`p${MAX_CATCH_UP_TARGETS + 3}`);
    expect(orderFlushTargets([...many].reverse(), "mine")).toEqual(order);
  });

  it("works with no current project", () => {
    expect(orderFlushTargets([candidate({ projectHash: "a", pending: 5 })])).toEqual(["a"]);
  });
});

describe("collectFlushCandidates", () => {
  it("reports unsent bytes per project and which ones this session touched", async () => {
    const dir = tmp();
    project(dir, "hashA", {
      "sid-1.jsonl": { body: "x".repeat(100), offset: 40 },
      "sid-old.jsonl": { body: "y".repeat(10), offset: 10 },
    });
    project(dir, "hashB", { "sid-2.jsonl": { body: "z".repeat(30) } });

    const found = await collectFlushCandidates(dir, "sid-1");
    const a = found.find((c) => c.projectHash === "hashA");
    const b = found.find((c) => c.projectHash === "hashB");

    expect(a?.pending).toBe(60);
    expect(a?.inSession).toBe(true);
    expect(b?.pending).toBe(30);
    expect(b?.inSession).toBe(false);
  });

  it("reports nothing pending once the offsets have caught up", async () => {
    const dir = tmp();
    project(dir, "hashA", { "sid-1.jsonl": { body: "x".repeat(80), offset: 80 } });
    const [only] = await collectFlushCandidates(dir, "sid-1");
    expect(only.pending).toBe(0);
  });

  it("ignores non-ledger files and unreadable entries", async () => {
    const dir = tmp();
    project(dir, "hashA", { "sid-1.jsonl": { body: "x".repeat(20) } });
    writeFileSync(join(dir, "hashA", "notes.txt"), "not a ledger");
    writeFileSync(join(dir, "loose-file"), "not a project");
    const found = await collectFlushCandidates(dir, "sid-1");
    expect(found.map((c) => c.projectHash)).toEqual(["hashA"]);
    expect(found[0].pending).toBe(20);
  });

  it("returns nothing when the sessions dir does not exist", async () => {
    expect(await collectFlushCandidates(join(tmp(), "missing"), "sid-1")).toEqual([]);
  });

  it("without a session id, no project claims to be in-session", async () => {
    const dir = tmp();
    project(dir, "hashA", { "sid-1.jsonl": { body: "x".repeat(20) } });
    const found = await collectFlushCandidates(dir);
    expect(found[0].inSession).toBe(false);
    expect(found[0].pending).toBe(20);
  });
});
