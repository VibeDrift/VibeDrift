import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Spawn via the real CLI subcommand (`vibedrift mcp`), the exact path users hit
// through `npx @vibedrift/cli mcp` — proves commander dispatch, the paid-plan
// gate, and a clean stdout (any non-JSON-RPC byte would break the handshake).
const CLI = resolve("dist/cli/index.js");
const THEN_BODY = ["export function feature(){", "  return a()", "    .then(r => r)", "    .then(s => s);", "}"].join("\n");

const EXPECTED_TOOLS = [
  "check_file_drift",
  "find_similar_function",
  "get_dominant_pattern",
  "get_intent_hints",
  "validate_change",
];

/** A fake ~/.vibedrift home with a cached plan, so the gate resolves without real auth. */
function fakeHome(plan: string): string {
  const home = mkdtempSync(join(tmpdir(), "vd-home-"));
  mkdirSync(join(home, ".vibedrift"), { recursive: true });
  writeFileSync(join(home, ".vibedrift", "config.json"), JSON.stringify({ token: "test-token", plan }));
  return home;
}

async function connect(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [CLI, "mcp"],
    env: { ...process.env, HOME: home },
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("MCP integration — Pro plan (tools serve)", () => {
  let repo: string;
  let home: string;
  let client: Client;

  beforeAll(async () => {
    home = fakeHome("pro");
    repo = mkdtempSync(join(tmpdir(), "vd-mcp-int-"));
    writeFileSync(join(repo, "CLAUDE.md"), "## Conventions\n- Use async/await throughout.\n");
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(repo, `aw${i}.ts`), `export async function aw${i}(){\n  const a = await x${i}();\n  const b = await y${i}();\n  return a + b;\n}\n`);
    }
    writeFileSync(join(repo, "then0.ts"), "export function then0(){\n  return a()\n    .then(r => r)\n    .then(s => s);\n}\n");
    // Build the baseline the real way: a scan under the SAME HOME the server reads
    // (the cache dir is derived from HOME, so this writes to home/.vibedrift).
    execFileSync("node", [CLI, repo, "--local-only", "--format", "terminal"], {
      env: { ...process.env, HOME: home },
      stdio: "ignore",
    });
    client = await connect(home);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("advertises exactly the five tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  const calls: Array<[string, Record<string, unknown>]> = [
    ["get_intent_hints", { rootDir: () => repo }],
    ["get_dominant_pattern", { rootDir: () => repo, dimension: "async" }],
    ["check_file_drift", { rootDir: () => repo, filePath: () => join(repo, "then0.ts") }],
    ["find_similar_function", { rootDir: () => repo, body: "async function q(){ const a = await x0(); const b = await y0(); return a + b; }" }],
    ["validate_change", { rootDir: () => repo, targetPath: () => join(repo, "feature.ts"), body: THEN_BODY }],
  ];

  for (const [name, rawArgs] of calls) {
    it(`${name} returns a valid result in under 3s`, async () => {
      const args = Object.fromEntries(
        Object.entries(rawArgs).map(([k, v]) => [k, typeof v === "function" ? (v as () => unknown)() : v]),
      );
      const t0 = performance.now();
      const res = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: { status?: string };
      };
      const ms = performance.now() - t0;
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent?.status).toMatch(/^(ok|stale)$/);
      expect(ms).toBeLessThan(3000); // generous ceiling — steady-state is tens of ms
    });
  }
});

describe("MCP integration — signed-out user gets the local tools free", () => {
  let repo: string;
  let home: string;
  let client: Client;

  beforeAll(async () => {
    // A home with a .vibedrift dir but NO config.json — fully signed out.
    home = mkdtempSync(join(tmpdir(), "vd-home-"));
    mkdirSync(join(home, ".vibedrift"), { recursive: true });
    repo = mkdtempSync(join(tmpdir(), "vd-mcp-anon-"));
    writeFileSync(join(repo, "CLAUDE.md"), "## Conventions\n- Use async/await throughout.\n");
    client = await connect(home);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("still advertises exactly the five tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("returns a REAL result (not upgrade_required) for a signed-out user", async () => {
    const res = (await client.callTool({
      name: "get_intent_hints",
      arguments: { rootDir: repo },
    })) as { isError?: boolean; structuredContent?: { status?: string } };
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.status).toBe("ok");
  });
});

describe("MCP integration — deep-scan nudge piggybacks on a write-time tool", () => {
  let repo: string;
  let home: string;
  let client: Client;

  beforeAll(async () => {
    // Signed in, with a STALE last deep scan (10 days ago) so a nudge is due.
    home = mkdtempSync(join(tmpdir(), "vd-home-"));
    mkdirSync(join(home, ".vibedrift"), { recursive: true });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(home, ".vibedrift", "config.json"),
      JSON.stringify({ token: "test-token", plan: "pro", lastDeepScanAt: tenDaysAgo }),
    );
    repo = mkdtempSync(join(tmpdir(), "vd-mcp-nudge-"));
    writeFileSync(join(repo, "CLAUDE.md"), "## Conventions\n- Use async/await throughout.\n");
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(repo, `aw${i}.ts`), `export async function aw${i}(){\n  const a = await x${i}();\n  return a;\n}\n`);
    }
    writeFileSync(join(repo, "then0.ts"), "export function then0(){\n  return a().then(r => r);\n}\n");
    execFileSync("node", [CLI, repo, "--local-only", "--format", "terminal"], {
      env: { ...process.env, HOME: home },
      stdio: "ignore",
    });
    client = await connect(home);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("surfaces the nudge once the session has been active (and only once)", async () => {
    const nudges: Array<{ reason?: string; type?: string }> = [];
    for (let i = 0; i < 9; i++) {
      const res = (await client.callTool({
        name: "check_file_drift",
        arguments: { rootDir: repo, filePath: join(repo, "then0.ts") },
      })) as { structuredContent?: { nudge?: { reason?: string; type?: string } } };
      if (res.structuredContent?.nudge) nudges.push(res.structuredContent.nudge);
    }
    // Below the activity floor (8 calls) it stays quiet; then exactly one fires
    // (the cooldown suppresses the rest in the same session).
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatchObject({ type: "deep_scan", reason: "stale_deep_scan" });
  });
});
