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
  NAMES_BATCH_MAX_BYTES,
  MAX_REL_PATH_LEN,
  planNameBatches,
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
  detail: { file: "src/a.ts", diffstat: "+1", inRepo: true },
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
  for (const file of files) await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file, diffstat: "+1", inRepo: true } }));
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
    expect(isSafeRelPath("../notes.ts")).toBe(false); // the hook's out-of-repo marker
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
    const e = ev({ detail: { file: "src/payments/refund.ts", diffstat: "+9", inRepo: true } });
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
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/flushed.ts", diffstat: "+1", inRepo: true } }));
    const firstLineEnd = readFileSync(join(sessionsDir, hash, "s1.jsonl"), "utf8").length;
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/pending.ts", diffstat: "+1", inRepo: true } }));
    await markFlushed(sessionsDir, hash, firstLineEnd);
    const entries = await collectFileNames(sessionsDir, hash);
    expect(entries.map((e) => e.path)).toEqual(["src/flushed.ts"]);
  });

  it("ignores a ledger line stamped with ANOTHER project's hash", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/mine.ts", diffstat: "+1", inRepo: true } }));
    await appendEvent(sessionsDir, hash, "s1", ev({ projectHash: "other", detail: { file: "src/theirs.ts", diffstat: "+1", inRepo: true } }));
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
      await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file, diffstat: "+1", inRepo: true } }));
    }
    await markFlushed(sessionsDir, hash);
    const entries = await collectFileNames(sessionsDir, hash);
    expect(entries.map((e) => e.path)).toEqual(["src/ok.ts"]);
  });

  it("never shares a file the hook recorded as OUTSIDE this repo, whatever its path looks like", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    // The hook records an out-of-repo edit by BASENAME, which is shaped exactly
    // like a file at the repo root: only the provenance mark tells them apart.
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "secrets.env", diffstat: "+1", inRepo: false } }));
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "README.md", diffstat: "+1", inRepo: true } }));
    await markFlushed(sessionsDir, hash);
    const entries = await collectFileNames(sessionsDir, hash);
    expect(entries.map((e) => e.path)).toEqual(["README.md"]);
  });

  it("fails closed: a line with no provenance mark is never shared", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/legacy.ts", diffstat: "+1" } }));
    await markFlushed(sessionsDir, hash);
    expect(await collectFileNames(sessionsDir, hash)).toEqual([]);
  });

  it("tolerates a corrupt line and a missing project dir", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    expect(await collectFileNames(sessionsDir, hash)).toEqual([]);
    mkdirSync(join(sessionsDir, hash), { recursive: true });
    writeFileSync(join(sessionsDir, hash, "s1.jsonl"), "{not json\n");
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/a.ts", diffstat: "+1", inRepo: true } }));
    await markFlushed(sessionsDir, hash);
    expect((await collectFileNames(sessionsDir, hash)).map((e) => e.path)).toEqual(["src/a.ts"]);
  });
});

const batchBytes = (batch: FileNameEntry[]): number =>
  Buffer.byteLength(JSON.stringify({ projectHash: "0123456789abcdef", names: batch }), "utf8");

describe("planNameBatches (what one request may carry)", () => {
  const entry = (i: number, path?: string): FileNameEntry => ({
    fileHash: i.toString(16).padStart(16, "0"),
    path: path ?? `src/f${i}.ts`,
  });

  it("caps a request at 500 entries", () => {
    const batches = planNameBatches(Array.from({ length: NAMES_BATCH_MAX * 2 + 3 }, (_, i) => entry(i)));
    expect(batches.map((b) => b.length)).toEqual([NAMES_BATCH_MAX, NAMES_BATCH_MAX, 3]);
  });

  it("caps a request by BYTES too, so a multi-byte monorepo never nears the server limit", () => {
    // 500 entries of long multi-byte paths blow past the byte budget well
    // before the entry cap; a silent 413 would lose the names entirely.
    const long = `src/${"\u65e5\u672c\u8a9e".repeat(60)}.ts`;
    expect(long.length).toBeLessThanOrEqual(MAX_REL_PATH_LEN);
    const batches = planNameBatches(Array.from({ length: NAMES_BATCH_MAX }, (_, i) => entry(i, `${i}/${long}`)));
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(batchBytes(b)).toBeLessThanOrEqual(NAMES_BATCH_MAX_BYTES);
    expect(batches.flat()).toHaveLength(NAMES_BATCH_MAX);
  });

  it("never repeats a fileHash inside a batch: last occurrence wins", () => {
    const batches = planNameBatches([
      { fileHash: "a".repeat(16), path: "src/old.ts" },
      { fileHash: "b".repeat(16), path: "src/other.ts" },
      { fileHash: "a".repeat(16), path: "src/new.ts" },
    ]);
    expect(batches).toEqual([
      [
        { fileHash: "a".repeat(16), path: "src/new.ts" },
        { fileHash: "b".repeat(16), path: "src/other.ts" },
      ],
    ]);
  });

  it("is the last gate: bad hashes and unsafe paths never reach a request", () => {
    const batches = planNameBatches([
      { fileHash: "NOTHEX", path: "src/a.ts" },
      { fileHash: "a".repeat(16), path: "/etc/passwd" },
      { fileHash: "b".repeat(16), path: "../../.ssh/id_rsa" },
      { fileHash: "c".repeat(16), path: "src/ok.ts" },
    ]);
    expect(batches).toEqual([[{ fileHash: "c".repeat(16), path: "src/ok.ts" }]]);
  });

  it("returns no batches for nothing to send", () => {
    expect(planNameBatches([])).toEqual([]);
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
      JSON.stringify(ev({ detail: { file: `src/f${i}.ts`, diffstat: "+1", inRepo: true } })),
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
    await appendEvent(sessionsDir, hash, "s1", ev({ detail: { file: "src/new.ts", diffstat: "+1", inRepo: true } }));
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
      JSON.stringify(ev({ detail: { file: `src/f${i}.ts`, diffstat: "+1", inRepo: true } })),
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

  it("keeps every request inside the entry AND byte caps", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    const dir = join(sessionsDir, hash);
    mkdirSync(dir, { recursive: true });
    const long = `${"\u65e5\u672c\u8a9e".repeat(60)}.ts`;
    const lines = Array.from({ length: NAMES_BATCH_MAX }, (_, i) =>
      JSON.stringify(ev({ detail: { file: `src/${i}/${long}`, diffstat: "+1", inRepo: true } })),
    );
    writeFileSync(join(dir, "s1.jsonl"), `${lines.join("\n")}\n`);
    await markFlushed(sessionsDir, hash);
    setShareFileNames(hash, true, base);
    const sent: FileNameEntry[][] = [];
    await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async (entries) => { sent.push(entries); },
    });
    expect(sent.length).toBeGreaterThan(1);
    for (const b of sent) {
      expect(b.length).toBeLessThanOrEqual(NAMES_BATCH_MAX);
      expect(batchBytes(b)).toBeLessThanOrEqual(NAMES_BATCH_MAX_BYTES);
      expect(new Set(b.map((e) => e.fileHash)).size).toBe(b.length);
    }
    expect(sent.flat()).toHaveLength(NAMES_BATCH_MAX);
  });

  it("counts server-side rejections without retrying them", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts", "src/b.ts"]);
    setShareFileNames(hash, true, base);
    let posts = 0;
    const res = await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async () => { posts++; return { ok: true, stored: 1, rejected: 1 }; },
    });
    expect(posts).toBe(1);
    expect(res).toMatchObject({ batches: 1, rejected: 1 });
  });

  it("sends a REJECTED entry exactly once, while a held one keeps retrying", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts", "src/b.ts"]);
    setShareFileNames(hash, true, base);
    const sent: string[][] = [];
    // The server refuses one entry outright and holds the other: a rejection is
    // settled (we validated before sending, so it will never be accepted), a
    // hold is not.
    const postNames = async (entries: FileNameEntry[]) => {
      sent.push(entries.map((e) => e.path));
      return {
        ok: true,
        stored: 0,
        rejected: 1,
        results: entries.map((e) =>
          e.path === "src/a.ts"
            ? { fileHash: e.fileHash, status: "rejected" as const, code: "bad_path" }
            : { fileHash: e.fileHash, status: "held" as const, code: "db_error" },
        ),
      };
    };
    const opts = { sessionsDir, projectHash: hash, home: base, canUpload: true, postNames };
    const first = await syncFileNames(opts);
    await syncFileNames(opts);
    await syncFileNames(opts);
    expect(first).toMatchObject({ uploaded: 0, rejected: 1, held: 1 });
    expect(sent.flat().filter((p) => p === "src/a.ts")).toHaveLength(1);
    expect(sent.flat().filter((p) => p === "src/b.ts")).toHaveLength(3);
  });

  it("a held batch (ok:false) records nothing, and the next flush re-sends it", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts", "src/b.ts"]);
    setShareFileNames(hash, true, base);
    const res = await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async (entries) => ({
        ok: false,
        stored: 0,
        rejected: 0,
        results: entries.map((e) => ({ fileHash: e.fileHash, status: "held" as const, code: "db_error" })),
      }),
    });
    expect(res).toMatchObject({ uploaded: 0, held: 2 });
    // nothing was written to the local record, so nothing is filtered out later
    expect(existsSync(namesStatePath(sessionsDir, hash))).toBe(false);
    const sent: FileNameEntry[][] = [];
    await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async (entries) => { sent.push(entries); return { ok: true, stored: entries.length, rejected: 0 }; },
    });
    expect(sent.flat().map((e) => e.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("a held batch stops the run: the remaining batches wait for the next flush", async () => {
    const base = tmp();
    const sessionsDir = join(base, "sessions");
    const hash = "p1";
    const dir = join(sessionsDir, hash);
    mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: NAMES_BATCH_MAX + 3 }, (_, i) =>
      JSON.stringify(ev({ detail: { file: `src/f${i}.ts`, diffstat: "+1", inRepo: true } })),
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
      postNames: async () => { posts++; return { ok: false, stored: 0, rejected: 0 }; },
    });
    expect(posts).toBe(1);
    expect(res.uploaded).toBe(0);
    expect(res.held).toBe(NAMES_BATCH_MAX);
  });

  it("an ok:true batch IS recorded, so the next flush sends nothing", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts"]);
    setShareFileNames(hash, true, base);
    const opts = {
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async (entries: FileNameEntry[]) => ({ ok: true, stored: entries.length, rejected: 0 }),
    };
    const first = await syncFileNames(opts);
    expect(first).toMatchObject({ uploaded: 1, batches: 1, held: 0 });
    let posts = 0;
    await syncFileNames({ ...opts, postNames: async (e) => { posts++; return { ok: true, stored: e.length, rejected: 0 }; } });
    expect(posts).toBe(0);
  });

  it("per-entry results: only the entries the server stored are recorded", async () => {
    const { base, sessionsDir, hash } = await project(["src/a.ts", "src/b.ts"]);
    setShareFileNames(hash, true, base);
    const first = await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async (entries) => ({
        ok: true,
        stored: 1,
        rejected: 0,
        results: [
          { fileHash: entries[0].fileHash, status: "stored" as const },
          { fileHash: entries[1].fileHash, status: "held" as const, code: "db_error" },
        ],
      }),
    });
    expect(first).toMatchObject({ uploaded: 1, held: 1 });
    const sent: FileNameEntry[][] = [];
    await syncFileNames({
      sessionsDir,
      projectHash: hash,
      home: base,
      canUpload: true,
      postNames: async (entries) => { sent.push(entries); return { ok: true, stored: entries.length, rejected: 0 }; },
    });
    expect(sent.flat().map((e) => e.path)).toEqual(["src/b.ts"]);
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
