import { describe, it, expect } from "vitest";
import { createServer, SERVER_INSTRUCTIONS } from "../../../src/mcp/server.js";

describe("MCP server scaffold", () => {
  it("createServer returns a connectable McpServer with the SDK surface", () => {
    const s = createServer() as unknown as { registerTool: unknown; connect: unknown };
    expect(typeof s.registerTool).toBe("function");
    expect(typeof s.connect).toBe("function");
  });

  it("instructions give the headless fallback for respond_to_flag", () => {
    // In non-interactive runs the tool call can be denied; without this
    // sentence the agent's decision is silently lost.
    expect(SERVER_INSTRUCTIONS).toContain(
      "If the tool is unavailable or the call is denied, state your decision and reason in your reply instead.",
    );
  });
});
