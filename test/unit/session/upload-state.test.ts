import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UploadStateStore, uploadStatePath } from "@/session/upload-state";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-ustate-")));

async function fresh(dir: string, hash = "h1") {
  const s = new UploadStateStore(dir, hash);
  await s.load();
  return s;
}

describe("UploadStateStore", () => {
  it("empty state when the file is missing", async () => {
    const s = await fresh(tmp());
    expect(s.get("a.jsonl")).toBe(0);
  });

  it("roundtrips commits across instances", async () => {
    const dir = tmp();
    const s1 = await fresh(dir);
    await s1.commit(new Map([["a.jsonl", 120], ["b.jsonl", 40]]));
    // keep the ledgers around so prune-on-load does not discard the entries
    writeFileSync(join(dir, "h1", "a.jsonl"), "x\n");
    writeFileSync(join(dir, "h1", "b.jsonl"), "x\n");
    const s2 = await fresh(dir);
    expect(s2.get("a.jsonl")).toBe(120);
    expect(s2.get("b.jsonl")).toBe(40);
  });

  it("corrupt or wrong-version state fails open to empty", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "h1"), { recursive: true });
    writeFileSync(uploadStatePath(dir, "h1"), "{not json");
    expect((await fresh(dir)).get("a.jsonl")).toBe(0);
    writeFileSync(uploadStatePath(dir, "h1"), JSON.stringify({ v: 99, files: { "a.jsonl": { offset: 7 } } }));
    expect((await fresh(dir)).get("a.jsonl")).toBe(0);
  });

  it("prunes entries whose ledger no longer exists (on load)", async () => {
    const dir = tmp();
    const s1 = await fresh(dir);
    await s1.commit(new Map([["gone.jsonl", 10], ["kept.jsonl", 20]]));
    writeFileSync(join(dir, "h1", "kept.jsonl"), "x\n");
    const s2 = await fresh(dir);
    expect(s2.get("gone.jsonl")).toBe(0);
    expect(s2.get("kept.jsonl")).toBe(20);
  });

  it("max-merges with on-disk state: offsets only ever move forward", async () => {
    const dir = tmp();
    const a = await fresh(dir);
    const b = await fresh(dir);
    await a.commit(new Map([["f.jsonl", 500], ["g.jsonl", 100]]));
    // b, unaware of a's progress, tries to commit lower f and higher g
    await b.commit(new Map([["f.jsonl", 300], ["g.jsonl", 400]]));
    writeFileSync(join(dir, "h1", "f.jsonl"), "x\n");
    writeFileSync(join(dir, "h1", "g.jsonl"), "x\n");
    const s3 = await fresh(dir);
    expect(s3.get("f.jsonl")).toBe(500);
    expect(s3.get("g.jsonl")).toBe(400);
  });

  it("in-memory get never regresses either", async () => {
    const s = await fresh(tmp());
    await s.commit(new Map([["f.jsonl", 200]]));
    await s.commit(new Map([["f.jsonl", 50]]));
    expect(s.get("f.jsonl")).toBe(200);
  });

  it("leaves no tmp residue after commits (atomic rename)", async () => {
    const dir = tmp();
    const s = await fresh(dir);
    await s.commit(new Map([["a.jsonl", 1]]));
    await s.commit(new Map([["a.jsonl", 2]]));
    const leftovers = readdirSync(join(dir, "h1")).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
    expect(JSON.parse(readFileSync(uploadStatePath(dir, "h1"), "utf8")).v).toBe(1);
  });

  it("concurrent commits never tear the file, stay forward-only, and converge", async () => {
    const dir = tmp();
    const a = await fresh(dir);
    const b = await fresh(dir);
    await Promise.all([
      a.commit(new Map([["x.jsonl", 100]])),
      b.commit(new Map([["y.jsonl", 200]])),
    ]);
    writeFileSync(join(dir, "h1", "x.jsonl"), "x\n");
    writeFileSync(join(dir, "h1", "y.jsonl"), "x\n");

    // Invariant 1 — no torn write: the persisted state always parses as v:1
    // (atomic tmp+rename), and any present offset is EXACTLY its committed value
    // (never a partial/garbage number). Lock-free, so one writer's read-merge
    // window may drop the other's entry — that is harmless (ingest is idempotent,
    // dedup re-absorbs), so we do NOT assert both survive the race.
    const persisted = JSON.parse(readFileSync(uploadStatePath(dir, "h1"), "utf8"));
    expect(persisted.v).toBe(1);
    const s3 = await fresh(dir);
    for (const [file, val] of [["x.jsonl", 100], ["y.jsonl", 200]] as const) {
      expect([0, val]).toContain(s3.get(file));
    }
    // at least one writer's value is durably present
    expect(s3.get("x.jsonl") + s3.get("y.jsonl")).toBeGreaterThan(0);

    // Invariant 2 — convergence + forward-only: a later commit lands both and
    // never rewinds either.
    const s4 = await fresh(dir);
    await s4.commit(new Map([["x.jsonl", 100], ["y.jsonl", 200]]));
    await s4.commit(new Map([["x.jsonl", 50], ["y.jsonl", 150]])); // stale, must not rewind
    const s5 = await fresh(dir);
    expect(s5.get("x.jsonl")).toBe(100);
    expect(s5.get("y.jsonl")).toBe(200);
  });
});
