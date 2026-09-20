/**
 * `vibedrift respond` — the human half of respond_to_flag.
 *
 * The state this closes: an agent parks a flag *for a person*, the dashboard
 * says "waiting on you", and until this command existed the person had
 * nowhere to answer. The dashboard reads the ledger and never writes to it,
 * and there was no local verb either.
 *
 * So the load-bearing property is that a person's call is stored EXACTLY like
 * an agent's: same event, same ledger, same flush. Anything else would mean
 * two sources of truth about one flag.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRespond } from "../../src/cli/commands/respond.js";
import { projectHash } from "../../src/core/baseline.js";

let home: string;
let repo: string;
let sessionsDir: string;

/** A ledger with one raised flag, as the hook would have written it.
 *  The hash is taken from the CANONICAL path: repoIdentity() realpaths its
 *  argument, and on macOS a temp dir under /var resolves to /private/var, so
 *  hashing the raw path would key the fixture to a repo the command never
 *  looks for. */
function ledger(findingId = "DF-1"): string {
  const hash = projectHash(realpathSync(repo));
  const dir = join(sessionsDir, hash);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "s1.jsonl");
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      sid: "s1",
      aid: "evt-1",
      ts: "2026-09-20T12:00:00.000Z",
      agent: "claude-code",
      projectHash: hash,
      channel: "hook",
      type: "flag",
      mode: "passive",
      findingId,
      detail: { category: "redundancy" },
    }) + "\n",
  );
  return path;
}

function events(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vd-respond-"));
  repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  sessionsDir = join(home, "sessions");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("a person can answer a flag the agent left for them", () => {
  it("records the call in the same ledger the agent writes to", async () => {
    const path = ledger();
    const status = await runRespond("DF-1", "accept", repo, { sessionsDir, reason: "fair catch" });
    expect(status).toBe("ok");

    const decision = events(path).find((e) => e.type === "decision");
    expect(decision).toBeDefined();
    expect(decision?.findingId).toBe("DF-1");
    expect((decision?.detail as Record<string, unknown>).decision).toBe("accept");
    expect((decision?.detail as Record<string, unknown>).reason).toBe("fair catch");
  });

  it("takes every call the agent can make", async () => {
    for (const d of ["accept", "park", "decline"]) {
      const path = ledger(`DF-${d}`);
      expect(await runRespond(`DF-${d}`, d, repo, { sessionsDir })).toBe("ok");
      expect(events(path).some((e) => e.type === "decision")).toBe(true);
      rmSync(path);
    }
  });

  it("records the call without a reason rather than demanding a sentence", async () => {
    const path = ledger();
    expect(await runRespond("DF-1", "park", repo, { sessionsDir })).toBe("ok");
    const decision = events(path).find((e) => e.type === "decision");
    expect((decision?.detail as Record<string, unknown>).reason).toBe("");
  });
});

describe("it refuses what it cannot honestly record", () => {
  it("rejects a decision that is not one", async () => {
    ledger();
    expect(await runRespond("DF-1", "maybe", repo, { sessionsDir })).toBe("bad_decision");
  });

  it("says so when the flag was never raised here, and lists what was", async () => {
    const path = ledger("DF-7");
    expect(await runRespond("DF-1", "accept", repo, { sessionsDir })).toBe("unknown_finding");
    expect(events(path).some((e) => e.type === "decision")).toBe(false);
  });

  it("says so when this repo has no session at all", async () => {
    expect(await runRespond("DF-1", "accept", repo, { sessionsDir })).toBe("no_session");
  });
});
