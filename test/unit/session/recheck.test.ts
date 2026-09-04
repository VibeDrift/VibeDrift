import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, type RepoDriftBaseline } from "@/core/baseline";
import { runEditChecks } from "@/session/check";
import { writeOutcomeState, readOutcomeState } from "@/session/outcomes";
import { sessionFilePath } from "@/session/ledger";
import { recheckProject, sessionsWithOutcomes, RECHECK_VIA } from "@/session/recheck";
import { ANCHOR_VOCAB } from "@/session/finding-anchor";

const HELPER = `export function exponentialBackoff(attempt: number): number {
  const base = 250;
  const cap = 30_000;
  const jitter = Math.random() * 100;
  return Math.min(cap, base * 2 ** attempt) + jitter;
}`;

let repo: string;
let sessionsDir: string;
let baseline: RepoDriftBaseline;
const HASH = "feedfacefeedface";

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "vd-recheck-repo-")));
  sessionsDir = realpathSync(mkdtempSync(join(tmpdir(), "vd-recheck-sessions-")));
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export async function a(){ return await fetch('/a'); }\n");
  writeFileSync(join(repo, "src", "lib", "backoff.ts"), `${HELPER}\n`);
  baseline = await buildBaseline(repo);
}, 60_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

/** Raise a real duplicate flag on src/retry.ts for `sid` and persist its
 *  anchor into the outcome sidecar, exactly as the hook does. */
async function raiseDup(sid: string): Promise<string> {
  const file = join(repo, "src", "retry.ts");
  writeFileSync(file, `${HELPER}\n`);
  const out = await runEditChecks({
    rootDir: repo,
    projectHash: HASH,
    sessionId: sid,
    sessionsDir,
    file,
    body: HELPER,
    loadBaselineFor: async () => baseline,
  });
  const flag = out.flags.find((f) => f.detail.category === "redundancy")!;
  await writeOutcomeState(sessionsDir, HASH, sid, {
    open: [{ findingId: flag.findingId!, file: "src/retry.ts", category: "redundancy", anchor: out.anchors[flag.findingId!] }],
    hashes: {},
    resolved: [],
  });
  return flag.findingId!;
}

describe("recheckProject", () => {
  it("leaves a finding open while the clone is still on disk (dry run appends nothing)", async () => {
    const id = await raiseDup("s-still");
    const res = await recheckProject({ rootDir: repo, projectHash: HASH, sessionsDir, baseline, sessionId: "s-still", dryRun: true });
    expect(res).toHaveLength(1);
    expect(res[0].resolved).toEqual([]);
    expect(res[0].stillOpen.map((f) => f.findingId)).toEqual([id]);
    expect(existsSync(sessionFilePath(sessionsDir, HASH, "s-still"))).toBe(false);
  });

  it("dry run: a clearable finding is reported, nothing is appended, the sidecar is untouched", async () => {
    const id = await raiseDup("s-dry-clearable");
    writeFileSync(join(repo, "src", "retry.ts"), 'export { exponentialBackoff } from "./lib/backoff";\n');
    const sidecarBefore = JSON.stringify(await readOutcomeState(sessionsDir, HASH, "s-dry-clearable"));
    const res = await recheckProject({ rootDir: repo, projectHash: HASH, sessionsDir, baseline, sessionId: "s-dry-clearable", dryRun: true });
    expect(res[0].resolved.map((f) => f.findingId)).toEqual([id]);
    expect(existsSync(sessionFilePath(sessionsDir, HASH, "s-dry-clearable"))).toBe(false);
    expect(JSON.stringify(await readOutcomeState(sessionsDir, HASH, "s-dry-clearable"))).toBe(sidecarBefore);
  });

  it("resolves a finding whose construct is gone, tagging the resolve via=recheck", async () => {
    const id = await raiseDup("s-fixed");
    writeFileSync(join(repo, "src", "retry.ts"), 'export { exponentialBackoff } from "./lib/backoff";\n');
    const res = await recheckProject({
      rootDir: repo,
      projectHash: HASH,
      sessionsDir,
      baseline,
      sessionId: "s-fixed",
      now: () => new Date("2026-09-03T12:00:00Z"),
    });
    expect(res[0].resolved.map((f) => f.findingId)).toEqual([id]);
    expect(res[0].stillOpen).toEqual([]);
    const lines = readFileSync(sessionFilePath(sessionsDir, HASH, "s-fixed"), "utf8").trim().split("\n");
    const ev = JSON.parse(lines[lines.length - 1]);
    expect(ev).toMatchObject({
      type: "resolve",
      findingId: id,
      outcome: "resolved",
      ts: "2026-09-03T12:00:00.000Z",
      detail: { file: "src/retry.ts", category: "redundancy", via: RECHECK_VIA },
    });
    // the sidecar no longer lists it, so the hook will not resolve it twice
    expect((await readOutcomeState(sessionsDir, HASH, "s-fixed")).open).toEqual([]);
  });

  it("keeps a finding open when its file cannot be read, and reports the file", async () => {
    const id = await raiseDup("s-missing");
    rmSync(join(repo, "src", "retry.ts"));
    const res = await recheckProject({ rootDir: repo, projectHash: HASH, sessionsDir, baseline, sessionId: "s-missing" });
    expect(res[0].missingFiles).toEqual(["src/retry.ts"]);
    expect(res[0].stillOpen.map((f) => f.findingId)).toEqual([id]);
    expect(res[0].resolved).toEqual([]);
  });

  // A tokenizer change makes every PERSISTED anchor incomparable with a body it
  // once matched: the same unchanged code normalizes to a different token
  // stream, the presence predicate reads that as "the flagged construct is
  // gone", and the finding clears although nothing was fixed. Measured on this
  // repo across the 0.20.1 to 0.20.2 tokenizer change: 5% of anchors stop
  // matching their own unchanged body and a full sweep falsely cleared one.
  // This command is the only path that reaches anchors from an earlier build.
  it("never clears a finding whose anchor came from a build with another tokenizer", async () => {
    const id = await raiseDup("s-old-vocab");
    const state = await readOutcomeState(sessionsDir, HASH, "s-old-vocab");
    // exactly what a sidecar written before the stamp existed looks like
    delete (state.open[0].anchor as { vocab?: number }).vocab;
    await writeOutcomeState(sessionsDir, HASH, "s-old-vocab", state);
    // the clone IS gone: a current-vocabulary anchor would clear here
    writeFileSync(join(repo, "src", "retry.ts"), 'export { exponentialBackoff } from "./lib/backoff";\n');
    const res = await recheckProject({ rootDir: repo, projectHash: HASH, sessionsDir, baseline, sessionId: "s-old-vocab" });
    expect(res[0].resolved).toEqual([]);
    expect(res[0].staleAnchors.map((f) => f.findingId)).toEqual([id]);
    // nothing appended, and the finding is still open on disk
    expect(existsSync(sessionFilePath(sessionsDir, HASH, "s-old-vocab"))).toBe(false);
    expect((await readOutcomeState(sessionsDir, HASH, "s-old-vocab")).open.map((f) => f.findingId)).toEqual([id]);
  });

  it("clears the same finding once the anchor carries the current vocabulary", async () => {
    const id = await raiseDup("s-new-vocab");
    const state = await readOutcomeState(sessionsDir, HASH, "s-new-vocab");
    expect(state.open[0].anchor).toMatchObject({ vocab: ANCHOR_VOCAB });
    writeFileSync(join(repo, "src", "retry.ts"), 'export { exponentialBackoff } from "./lib/backoff";\n');
    const res = await recheckProject({ rootDir: repo, projectHash: HASH, sessionsDir, baseline, sessionId: "s-new-vocab", dryRun: true });
    expect(res[0].resolved.map((f) => f.findingId)).toEqual([id]);
    expect(res[0].staleAnchors).toEqual([]);
  });

  it("walks every session with an outcome sidecar when no session id is given", async () => {
    const ids = await sessionsWithOutcomes(sessionsDir, HASH);
    expect(ids).toEqual(expect.arrayContaining(["s-still", "s-fixed", "s-missing"]));
    expect([...ids]).toEqual([...ids].sort());
    const res = await recheckProject({ rootDir: repo, projectHash: HASH, sessionsDir, baseline, dryRun: true });
    // s-fixed has nothing open any more, so it is not in the report
    expect(res.map((r) => r.sessionId)).not.toContain("s-fixed");
  });
});
