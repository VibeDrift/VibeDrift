import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "@/session/ledger";
import { UploadStateStore } from "@/session/upload-state";
import { toUploadEvent } from "@/session/upload-schema";
import { loadActivation, setShareFileNames, setNamesDeletePending, namesDeleteIsPending } from "@/session/activation";
import {
  NAMES_BATCH_MAX,
  MAX_REL_PATH_LEN,
  isSafeRelPath,
  collectFileNames,
  syncFileNames,
  namesStatePath,
  type FileNameEntry,
} from "@/session/file-names";
import type { SessionEvent } from "@/session/types";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-names-")));

let seq = 0;
const ev = (over: Partial<SessionEvent> = {}): SessionEvent => ({
  v: 1,
  sid: "s1",
  aid: `evt-${seq++}`,
  ts: new Date().toISOString(),
  agent: "claude-code",
  projectHash: "p1",
  channel: "hook",
  type: "edit",
  mode: "passive",
  detail: { file: "src/a.ts", diffstat: "+1" },
  ...over,
});

/** Mark every byte of every ledger file as positively acknowledged, which is
 *  what "already flushed for this project" means on disk. */
async function markFlushed(sessionsDir: string, hash: string, upTo?: number): Promise<void> {
  const dir = join(sessionsDir, hash);
  const store = new UploadStateStore(sessionsDir, hash);
  await store.load();
  const offsets = new Map<string, number>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    const raw = readFileSync(join(dir, f), "utf8");
    offsets.set(f, upTo ?? raw.length);
  }
  await store.commit(offsets);
}

async function project(files: string[]): Promise<{ base: string; sessionsDir: string; hash: string }> {
  const base = tmp();
  const sessionsDir = join(base, "sessions");
  const hash = "p1";
  for (const file of files) await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file, diffstat: "+1" } }));
  await markFlushed(sessionsDir, hash);
  return { base, sessionsDir, hash };
}

describe("isSafeRelPath (client-side mirror of the ingest validation)", () => {
  it("accepts ordinary repo-relative paths", () => {
    expect(isSafeRelPath("src/a.ts")).toBe(true);
    expect(isSafeRelPath("a.ts")).toBe(true);
    expect(isSafeRelPath("packages/api/src/routes/v1/names.py")).toBe(true);
    expect(isSafeRelPath("weird name (1).ts")).toBe(true);
  });

  it("refuses absolute paths, drive letters, traversal, backslashes and control chars", () => {
    expect(isSafeRelPath("/etc/passwd")).toBe(false);
    expect(isSafeRelPath("C:\\repo\\a.ts")).toBe(false);
    expect(isSafeRelPath("c:/repo/a.ts")).toBe(false);
    expect(isSafeRelPath("../../.ssh/id_rsa")).toBe(false);
    expect(isSafeRelPath("src/../../secrets.env")).toBe(false);
    expect(isSafeRelPath("..")).toBe(false);
    expect(isSafeRelPath("src\\a.ts")).toBe(false);
    expect(isSafeRelPath("src/a\n.ts")).toBe(false);
    expect(isSafeRelPath("src/a\u0000.ts")).toBe(false);
  });

  it("refuses empty and overlong paths", () => {
    expect(isSafeRelPath("")).toBe(false);
    expect(isSafeRelPath("   ")).toBe(false);
    expect(isSafeRelPath("a".repeat(MAX_REL_PATH_LEN))).toBe(true);
    expect(isSafeRelPath("a".repeat(MAX_REL_PATH_LEN + 1))).toBe(false);
  });

  it("refuses non-strings", () => {
    expect(isSafeRelPath(undefined)).toBe(false);
    expect(isSafeRelPath(42)).toBe(false);
  });
});

describe("collectFileNames (manifest built from this project's own ledger)", () => {
  it("returns one entry per distinct flushed file, in ledger order", async () => {
    const { sessionsDir, hash } = await project(["src/a.ts", "src/b.ts", "src/a.ts"]);
    const entries = await collectFileNames(sessionsDir, hash);
    expect(entries.map((e) => e.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(new Set(entries.map((e) => e.fileHash)).size).toBe(2);
  });

  it("hash parity: every entry carries the upload schema's OWN fileHash", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    const e = ev({ detail: { file: "src/payments/refund.ts", diffstat: "+9" } });
    await appendEvent(sessionsDir, hash, "s1", e);
    await markFlushed(sessionsDir, hash);
    const [entry] = await collectFileNames(sessionsDir, hash);
    expect(entry.fileHash).toBe(toUploadEvent(e)?.fileHash);
    expect(entry.fileHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("omits events that have not been flushed yet (past the committed offset)", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/flushed.ts", diffstat: "+1" } }));
    const firstLineEnd = readFileSync(join(sessionsDir, hash, "s1.jsonl"), "utf8").length;
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/pending.ts", diffstat: "+1" } }));
    await markFlushed(sessionsDir, hash, firstLineEnd);
    const entries = await collectFileNames(sessionsDir, hash);
    expect(entries.map((e) => e.path)).toEqual(["src/flushed.ts"]);
  });

  it("ignores a ledger line stamped with ANOTHER project's hash", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/mine.ts", diffstat: "+1" } }));
    await appendEvent(sessionsDir, hash, "s1", ev({ projectHash: "other", detail: { file: "src/theirs.ts", diffstat: "+1" } }));
    await markFlushed(sessionsDir, hash);
    const entries = await collectFileNames(sessionsDir, hash);
    expect(entries.map((e) => e.path)).toEqual(["src/mine.ts"]);
  });

  it("ignores event kinds whose upload projection carries no fileHash", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    // `command` is never uploaded at all; it must not contribute a name.
    await appendEvent(sessionsDir, hash, "s1", ev({ type: "command", detail: { file: "scripts/deploy.sh" } }));
    await markFlushed(sessionsDir, hash);
    expect(await collectFileNames(sessionsDir, hash)).toEqual([]);
  });

  it("defense in depth: an absolute or traversal path in the ledger never becomes an entry", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    for (const file of ["/etc/passwd", "../../.ssh/id_rsa", "C:\\Users\\me\\secrets.env", "src/ok.ts"]) {
      await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file, diffstat: "+1" } }));
    }
    await markFlushed(sessionsDir, hash);
    const entries = await collectFileNames(sessionsDir, hash);
    expect(entries.map((e) => e.path)).toEqual(["src/ok.ts"]);
  });

  it("tolerates a corrupt line and a missing project dir", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    expect(await collectFileNames(sessionsDir, hash)).toEqual([]);
    mkdirSync(join(sessionsDir, hash), { recursive: true });
    writeFileSync(join(sessionsDir, hash, "s1.jsonl"), "{not json\n");
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/a.ts", diffstat: "+1" } }));
    await markFlushed(sessionsDir, hash);
    expect((await collectFileNames(sessionsDir, hash)).map((e) => e.path)).toEqual(["src/a.ts"]);
  });
});

describe("syncFileNames (flush-time upload, opt-in gated)", () => {
  it("makes NO request at all when the repo flag is off", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts"]);
    let posts = 0;
    let deletes = 0;
    const res = await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async () => { posts++; },
      deleteNames: async () => { deletes++; },
    });
    expect(posts).toBe(0);
    expect(deletes).toBe(0);
    expect(res).toMatchObject({ uploaded: 0, batches: 0 });
    expect(existsSync(namesStatePath(sessionsDir, hash))).toBe(false);
  });

  it("uploads the manifest when the flag is on", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts", "src/b.ts"]);
    setShareFileNames(hash, true, base);
    const sent: FileNameEntry[][] = [];
    const res = await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async (entries) => { sent.push(entries); },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].map((e) => e.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(res).toMatchObject({ uploaded: 2, batches: 1 });
  });

  it("uploads nothing when the account is entitlement-locked", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts"]);
    setShareFileNames(hash, true, base);
    let posts = 0;
    await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: false,
      postNames: async () => { posts++; },
    });
    expect(posts).toBe(0);
  });

  it("batches at 500 entries per request", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    const dir = join(sessionsDir, hash);
    mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: NAMES_BATCH_MAX + 7 }, (_, i) =>
      JSON.stringify(ev({ detail: { file: `src/f${i}.ts`, diffstat: "+1" } })),
    );
    writeFileSync(join(dir, "s1.jsonl"), `${lines.join("\n")}\n`);
    await markFlushed(sessionsDir, hash);
    setShareFileNames(hash, true, base);
    const sizes: number[] = [];
    const res = await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async (entries) => { sizes.push(entries.length); },
    });
    expect(sizes).toEqual([NAMES_BATCH_MAX, 7]);
    expect(res.uploaded).toBe(NAMES_BATCH_MAX + 7);
  });

  it("remembers what it uploaded: a second flush with nothing new posts nothing", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts"]);
    setShareFileNames(hash, true, base);
    let posts = 0;
    const opts = {
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async () => { posts++; },
    };
    await syncFileNames(opts);
    await syncFileNames(opts);
    expect(posts).toBe(1);
    // a newly edited file is the only thing the next flush sends
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/new.ts", diffstat: "+1" } }));
    await markFlushed(sessionsDir, hash);
    const sent: FileNameEntry[][] = [];
    await syncFileNames({ ...opts, postNames: async (e) => { sent.push(e); } });
    expect(sent).toEqual([[expect.objectContaining({ path: "src/new.ts" })]]);
  });

  it("one attempt per flush run: a failed batch never retries and never throws", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    const dir = join(sessionsDir, hash);
    mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: NAMES_BATCH_MAX + 3 }, (_, i) =>
      JSON.stringify(ev({ detail: { file: `src/f${i}.ts`, diffstat: "+1" } })),
    );
    writeFileSync(join(dir, "s1.jsonl"), `${lines.join("\n")}\n`);
    await markFlushed(sessionsDir, hash);
    setShareFileNames(hash, true, base);
    let posts = 0;
    const res = await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async () => { posts++; throw new Error("names endpoint down"); },
    });
    expect(posts).toBe(1);
    expect(res).toMatchObject({ uploaded: 0, batches: 0 });
    // nothing was recorded as uploaded, so the next flush tries again
    let retried = 0;
    await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async () => { retried++; },
    });
    expect(retried).toBe(2);
  });

  it("retries a pending opt-out delete, clears the flag state and the local manifest record", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts"]);
    setShareFileNames(hash, true, base);
    await syncFileNames({ sessionsDir, projectHash: hash, home: base, canUpload: true, postNames: async () => {} });
    expect(existsSync(namesStatePath(sessionsDir, hash))).toBe(true);
    // the user turned names off but the DELETE never reached the server
    setShareFileNames(hash, false, base);
    setNamesDeletePending(hash, true, base);
    let deletes = 0;
    const res = await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      deleteNames: async () => { deletes++; },
      postNames: async () => { throw new Error("must not upload while off"); },
    });
    expect(deletes).toBe(1);
    expect(res).toMatchObject({ deleted: true, deletePending: false });
    expect(namesDeleteIsPending(loadActivation(base), hash)).toBe(false);
    expect(existsSync(namesStatePath(sessionsDir, hash))).toBe(false);
  });

  it("a delete that fails again stays pending for the next flush", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts"]);
    setNamesDeletePending(hash, true, base);
    const res = await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      deleteNames: async () => { throw new Error("still offline"); },
    });
    expect(res).toMatchObject({ deleted: false, deletePending: true });
    expect(namesDeleteIsPending(loadActivation(base), hash)).toBe(true);
  });

  it("honors a pending delete even when the account is locked", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts"]);
    setNamesDeletePending(hash, true, base);
    let deletes = 0;
    await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: false,
      deleteNames: async () => { deletes++; },
    });
    expect(deletes).toBe(1);
    expect(namesDeleteIsPending(loadActivation(base), hash)).toBe(false);
  });
});
