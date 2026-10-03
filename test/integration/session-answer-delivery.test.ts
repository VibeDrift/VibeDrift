/**
 * The mid-turn answer loop (the 0.21.2 promise, made true).
 *
 * "Answer a flag from the dashboard, and the agent gets it" (0.21.2) shipped
 * two halves: SessionStart announces whatever is waiting, and a once-a-minute
 * mid-turn tick collects new answers into the ledger. The mid-turn half wrote
 * the answer AND acknowledged it to the server, but never announced it — and
 * because it was acked, no later SessionStart would ever see it queued again.
 * An answer given while the agent was mid-turn vanished. The fix hands the
 * briefing back to the edit path, which speaks through the same exit-2
 * channel the drift advisory uses.
 *
 * Integration on purpose: the bug lived in the wiring between the hook's
 * flush tick and its output channel, which only exists as a real process with
 * a real config, a real ledger, and a real HTTP call (the API is a loopback
 * stub; 127.0.0.1 is the one plaintext host the resolver accepts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectHash } from "@/core/baseline";

vi.setConfig({ testTimeout: 60_000 });

const ENTRY = join(process.cwd(), "src", "session", "hook-entry.ts");
const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");

let home: string;
let repo: string;
let server: Server;
let apiUrl: string;
let ackedIds: string[];
let pendingBody: unknown;

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * ASYNC spawn, deliberately: the stub API lives in this test process, and a
 * blocking spawnSync would freeze the event loop that is supposed to answer
 * the hook's /pending fetch (the child then times out and silently returns
 * no answers — the exact failure shape this test exists to catch, for the
 * wrong reason).
 */
function runHook(payload: unknown): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [ENTRY], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        VIBEDRIFT_HOOK_DEBUG: "",
        VIBEDRIFT_API_URL: apiUrl,
        // The flush child is beside the point here; the seam keeps the test
        // from spawning real uploads against the stub. process.execPath
        // (node, given non-script args, exits at once) because it exists
        // everywhere this suite runs; /bin/true does not (modern macOS).
        VIBEDRIFT_SESSION_FLUSH_CMD: process.execPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "vd-ans-home-")));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "vd-ans-repo-")));
  mkdirSync(join(repo, ".git"));
  ackedIds = [];
  pendingBody = { responses: [] };
  server = createServer((req, res) => {
    if (req.url?.startsWith("/v1/sessions/flags/pending")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(pendingBody));
      return;
    }
    if (req.url === "/v1/sessions/flags/ack" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        for (const id of JSON.parse(body).ids ?? []) ackedIds.push(id);
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Signed-in + sync on: the mid-turn tick gates on both.
  mkdirSync(join(home, ".vibedrift"), { recursive: true });
  writeFileSync(
    join(home, ".vibedrift", "config.json"),
    JSON.stringify({ token: "t", sessionsSyncEnabled: true, apiUrl, telemetryEnabled: false }),
  );
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const editPayload = () => ({
  session_id: "s-agent",
  cwd: repo,
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: join(repo, "src", "new.ts"), content: "export const fresh = 1;\n" },
});

/** The flag a person is answering, raised by an earlier session, in the
 *  ledger the answer's decision event will join. The file in its detail is
 *  what the briefing names, because DF-1 means a different flag per sitting. */
function seedFlag(): string {
  const hash = projectHash(repo);
  const dir = join(home, ".vibedrift", "sessions", hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "s-person.jsonl"),
    JSON.stringify({
      v: 1,
      sid: "s-person",
      aid: "evt-1",
      ts: "2026-10-02T10:00:00.000Z",
      agent: "claude-code",
      projectHash: hash,
      channel: "hook",
      type: "flag",
      mode: "passive",
      findingId: "DF-1",
      detail: { category: "async_patterns", file: "src/api.ts", observed: ".then() chains", dominant: "async/await" },
      outcome: null,
    }) + "\n",
  );
  return hash;
}

describe("a person's mid-turn answer reaches the running agent", () => {
  it("announces the answer on the edit path, acked exactly once", async () => {
    const hash = seedFlag();
    pendingBody = {
      responses: [
        {
          id: "r1",
          project_hash: hash,
          session_id: "s-person",
          finding_id: "DF-1",
          decision: "accept",
          reason: "the rest of routes/ is async/await",
        },
      ],
    };
    const r = await runHook(editPayload());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("A person answered a VibeDrift flag");
    expect(r.stderr).toContain("DF-1 in src/api.ts");
    expect(r.stderr).toContain("accepted, so change the code");
    expect(ackedIds).toEqual(["r1"]);
    // ...and it is on the record in the raising session's ledger.
    const ledger = readFileSync(join(home, ".vibedrift", "sessions", hash, "s-person.jsonl"), "utf8");
    const decision = ledger
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.type === "decision");
    expect(decision.detail.decision).toBe("accept");
  });

  it("stays quiet when nobody answered anything", async () => {
    seedFlag();
    const r = await runHook(editPayload());
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("A person answered");
    expect(ackedIds).toEqual([]);
  });

  it("a broken flush-command seam cannot take the hook down (found writing this suite)", async () => {
    // The first draft of this suite used /bin/true as the seam — absent on
    // modern macOS — and the hook CRASHED: spawn() reports a missing
    // executable as an async 'error' event, and maybeSpawnFlush had no
    // listener, so the event threw and exit was 1. The handler added there
    // is what this test binds: a seam pointing at nothing must degrade to
    // "no flush spawned", never to a dead hook.
    const r = await new Promise<HookResult>((resolve, reject) => {
      const child = spawn(TSX, [ENTRY], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          VIBEDRIFT_HOOK_DEBUG: "",
          VIBEDRIFT_API_URL: apiUrl,
          VIBEDRIFT_SESSION_FLUSH_CMD: "/nonexistent/vibedrift-flush-stub",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.write(JSON.stringify(editPayload()));
      child.stdin.end();
    });
    expect(r.status).toBe(0);
  });
});
