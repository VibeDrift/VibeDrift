import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFlush } from "@/session/flush-run";
import { appendEvent } from "@/session/ledger";
import { readFileSync } from "node:fs";
import { readEntitlementCache, writeEntitlementCache, computeEntitlement } from "@/session/entitlement";
import { setShareFileNames, setNamesDeletePending, namesDeleteIsPending, loadActivation } from "@/session/activation";
import type { FileNameEntry } from "@/session/file-names";
import type { UploadEvent } from "@/session/upload-schema";
import type { IngestAck } from "@/session/ingest-ack";
import type { SessionEvent } from "@/session/types";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-flushrun-")));
const NOW = 1_700_000_000_000;

let seq = 0;
const ev = (over: Partial<SessionEvent> = {}): SessionEvent => ({
  v: 1,
  sid: "s1",
  aid: `evt-${seq++}`,
  ts: new Date().toISOString(),
  agent: "claude-code",
  // the hook stamps every event with the SAME hash it uses for the ledger dir
  projectHash: "h1",
  channel: "hook",
  type: "edit",
  mode: "passive",
  // inRepo is the hook's provenance stamp: this edit landed inside the repo,
  // which is what makes "a.ts" shareable as a name at all.
  detail: { file: "a.ts", diffstat: "+1", inRepo: true },
  ...over,
});

const fullAck = (events: UploadEvent[]): IngestAck => ({
  accepted: events.length,
  results: events.map((e) => ({ activityId: e.activityId, status: "accepted" as const })),
});

/** A project with one uploadable edit in its ledger. */
async function project(): Promise<{ base: string; sessionsDir: string; hash: string }> {
  const base = tmp();
  const sessionsDir = join(base, "sessions");
  const hash = "h1";
  await appendEvent(sessionsDir, hash, "s1", ev());
  return { base, sessionsDir, hash };
}

describe("runFlush (the native path's per-turn flush)", () => {
  it("refreshes the entitlement cache on a first run, then uploads", async () => {
    const { base, sessionsDir, hash } = await project();
    expect(readEntitlementCache(base)).toBeNull();
    const posted: UploadEvent[] = [];
    const out = await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: hash,
      now: () => NOW,
      fetchEntitlement: async () => ({ plan: "free", trial_used: 1, trial_limit: 5 }),
      post: async (e) => { posted.push(...e); return fullAck(e); },
    });
    expect(readEntitlementCache(base)).toMatchObject({ entitled: true, trialUsed: 1 });
    expect(posted).toHaveLength(1);
    expect(out).toMatchObject({ uploaded: true, locked: false });
  });

  it("locks the cache and uploads NOTHING once the trial is spent", async () => {
    const { base, sessionsDir, hash } = await project();
    let posts = 0;
    const out = await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: hash,
      now: () => NOW,
      fetchEntitlement: async () => ({ plan: "free", trial_used: 5, trial_limit: 5 }),
      post: async (e) => { posts++; return fullAck(e); },
    });
    expect(posts).toBe(0);
    expect(out).toMatchObject({ uploaded: false, locked: true });
    expect(readEntitlementCache(base)).toMatchObject({ entitled: false, reason: "locked" });
  });

  it("locks the cache when ingest answers 402 mid-flush", async () => {
    const { base, sessionsDir, hash } = await project();
    // cache says entitled and is fresh, so the pre-flight refresh is skipped;
    // the server disagrees at ingest time.
    writeEntitlementCache(base, computeEntitlement("free", 4, 5), () => NOW);
    let entitlementCalls = 0;
    const out = await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: hash,
      now: () => NOW,
      fetchEntitlement: async () => { entitlementCalls++; return { plan: "free", trial_used: 5, trial_limit: 5 }; },
      post: async () => { const err = new Error("locked") as Error & { status?: number }; err.status = 402; throw err; },
    });
    expect(out.locked).toBe(true);
    expect(entitlementCalls).toBe(1); // the forced re-ask after the 402
    expect(readEntitlementCache(base)).toMatchObject({ entitled: false, reason: "locked" });
  });

  it("still uploads when the entitlement check is unreachable (network blip never locks)", async () => {
    const { base, sessionsDir, hash } = await project();
    const posted: UploadEvent[] = [];
    const out = await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: hash,
      now: () => NOW,
      fetchEntitlement: async () => { throw new Error("offline"); },
      post: async (e) => { posted.push(...e); return fullAck(e); },
    });
    expect(posted).toHaveLength(1);
    expect(out.locked).toBe(false);
    expect(readEntitlementCache(base)).toBeNull(); // nothing fabricated
  });

  it("skips the entitlement round-trip when the cache is fresh and entitled", async () => {
    const { base, sessionsDir, hash } = await project();
    writeEntitlementCache(base, computeEntitlement("pro", 0, 5), () => NOW);
    let entitlementCalls = 0;
    await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: hash,
      now: () => NOW,
      fetchEntitlement: async () => { entitlementCalls++; return { plan: "pro", trial_used: 0, trial_limit: 5 }; },
      post: async (e) => fullAck(e),
    });
    expect(entitlementCalls).toBe(0);
  });

  it("re-asks a locked cache every turn, and uploads again once the account is Pro", async () => {
    const { base, sessionsDir, hash } = await project();
    writeEntitlementCache(base, computeEntitlement("free", 5, 5), () => NOW);
    const posted: UploadEvent[] = [];
    const out = await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: hash,
      now: () => NOW,
      fetchEntitlement: async () => ({ plan: "pro", trial_used: 5, trial_limit: 5 }),
      post: async (e) => { posted.push(...e); return fullAck(e); },
    });
    expect(readEntitlementCache(base)).toMatchObject({ entitled: true, reason: "pro" });
    expect(posted).toHaveLength(1);
    expect(out).toMatchObject({ uploaded: true, locked: false });
  });

  it("never throws when everything fails at once", async () => {
    const { base, sessionsDir, hash } = await project();
    await expect(
      runFlush({
        baseDir: base,
        sessionsDir,
        projectHash: hash,
        now: () => NOW,
        fetchEntitlement: async () => { throw new Error("offline"); },
        post: async () => { throw new Error("network down"); },
      }),
    ).resolves.toBeTruthy();
  });

  it("a missing ledger directory flushes cleanly: nothing posted, not locked", async () => {
    const base = tmp();
    // never created: no sessions dir, no project dir, no ledger, no offsets
    const sessionsDir = join(base, "sessions");
    const posted: UploadEvent[] = [];
    const out = await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: "h-missing",
      now: () => NOW,
      fetchEntitlement: async () => ({ plan: "pro" }),
      post: async (e) => { posted.push(...e); return fullAck(e); },
    });
    expect(posted).toHaveLength(0);
    expect(out).toMatchObject({ uploaded: true, locked: false });
  });
});

describe("runFlush — opt-in file-name manifest", () => {
  const uploadedOffsets = (sessionsDir: string, hash: string): Record<string, { offset: number }> =>
    JSON.parse(readFileSync(join(sessionsDir, hash, "upload-state.json"), "utf8")).files;

  it("makes NO names request when the repo never opted in (the default)", async () => {
    const { base, sessionsDir, hash } = await project();
    let nameCalls = 0;
    await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: hash,
      now: () => NOW,
      fetchEntitlement: async () => ({ plan: "pro" }),
      post: async (e) => fullAck(e),
      postNames: async () => { nameCalls++; },
      deleteNames: async () => { nameCalls++; },
    });
    expect(nameCalls).toBe(0);
  });

  it("posts the manifest for the flushed events once the repo opted in", async () => {
    const { base, sessionsDir, hash } = await project();
    setShareFileNames(hash, true, base);
    const sent: FileNameEntry[] = [];
    await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: hash,
      now: () => NOW,
      fetchEntitlement: async () => ({ plan: "pro" }),
      post: async (e) => fullAck(e),
      postNames: async (entries) => { sent.push(...entries); },
    });
    expect(sent).toEqual([{ fileHash: expect.stringMatching(/^[0-9a-f]{16}$/), path: "a.ts" }]);
  });

  it("a names failure never blocks the flush: events still commit their offsets", async () => {
    const { base, sessionsDir, hash } = await project();
    setShareFileNames(hash, true, base);
    const posted: UploadEvent[] = [];
    const out = await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: hash,
      now: () => NOW,
      fetchEntitlement: async () => ({ plan: "pro" }),
      post: async (e) => { posted.push(...e); return fullAck(e); },
      postNames: async () => { throw new Error("names endpoint down"); },
    });
    expect(posted).toHaveLength(1);
    expect(out).toMatchObject({ uploaded: true, locked: false });
    expect(Object.values(uploadedOffsets(sessionsDir, hash))[0].offset).toBeGreaterThan(0);
  });

  it("honors a pending opt-out delete even when the account is locked", async () => {
    const { base, sessionsDir, hash } = await project();
    setNamesDeletePending(hash, true, base);
    let deletes = 0;
    const out = await runFlush({
      baseDir: base,
      sessionsDir,
      projectHash: hash,
      now: () => NOW,
      fetchEntitlement: async () => ({ plan: "free", trial_used: 5, trial_limit: 5 }),
      post: async (e) => fullAck(e),
      deleteNames: async () => { deletes++; },
    });
    expect(out).toMatchObject({ uploaded: false, locked: true });
    expect(deletes).toBe(1);
    expect(namesDeleteIsPending(loadActivation(base), hash)).toBe(false);
  });
});
