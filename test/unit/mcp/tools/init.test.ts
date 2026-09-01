import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInit } from "../../../../src/mcp/tools/init.js";
import { ImplausibleRootDirError } from "../../../../src/tools-core/root-dir-guard.js";

type Handler = (args: { rootDir: string; detectOnly?: boolean; format?: "json" }) => Promise<{
  structuredContent: Record<string, unknown>;
}>;

/**
 * Capture the handler the adapter registers, without going through a
 * transport. `registerTool(name, config, handler)` is the SDK's signature.
 */
function captureHandler(): Handler {
  const registerTool = vi.fn();
  registerInit.register({ registerTool } as unknown as McpServer);
  expect(registerTool).toHaveBeenCalledTimes(1);
  const [name, , handler] = registerTool.mock.calls[0] as [string, unknown, Handler];
  expect(name).toBe("init");
  return handler;
}

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("init MCP adapter: root-dir guard", () => {
  it("registers on a fresh server without throwing", () => {
    const s = new McpServer({ name: "t", version: "0" });
    expect(() => registerInit.register(s)).not.toThrow();
  });

  // The guard lives in the adapter, not the core: over MCP the rootDir is
  // agent-controlled and init has no Allow/Deny prompt, so this is its only
  // check before writing into the directory. A thrown error here is turned
  // into an `isError` tool result by the SDK — a normal tool error, not a
  // server crash.
  it("refuses a marker-less directory and writes nothing", async () => {
    const handler = captureHandler();
    const bare = tmp("vd-mcp-init-bare-");
    await expect(handler({ rootDir: bare, format: "json" })).rejects.toBeInstanceOf(
      ImplausibleRootDirError,
    );
    expect(existsSync(join(bare, ".vibedrift"))).toBe(false);
  });

  it("refuses a marker-less directory even for a detectOnly preview", async () => {
    const handler = captureHandler();
    const bare = tmp("vd-mcp-init-bare-preview-");
    await expect(handler({ rootDir: bare, detectOnly: true })).rejects.toBeInstanceOf(
      ImplausibleRootDirError,
    );
  });

  it("refuses a path that does not exist", async () => {
    const handler = captureHandler();
    const missing = join(tmpdir(), "vd-mcp-init-missing-" + Date.now());
    await expect(handler({ rootDir: missing })).rejects.toBeInstanceOf(ImplausibleRootDirError);
  });

  it("initializes a directory that carries a project marker", async () => {
    const handler = captureHandler();
    const repo = tmp("vd-mcp-init-repo-");
    mkdirSync(join(repo, ".git"));
    const out = await handler({ rootDir: repo, format: "json" });
    expect(out.structuredContent.status).toBe("ok");
    expect(out.structuredContent.wrote).toBe(true);
    expect(existsSync(join(repo, ".vibedrift", "config.json"))).toBe(true);
  });
});
