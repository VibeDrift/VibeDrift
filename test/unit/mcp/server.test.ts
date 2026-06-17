import { describe, it, expect } from "vitest";
import { createServer } from "../../../src/mcp/server.js";

describe("MCP server scaffold", () => {
  it("createServer returns a connectable McpServer with the SDK surface", () => {
    const s = createServer() as unknown as { registerTool: unknown; connect: unknown };
    expect(typeof s.registerTool).toBe("function");
    expect(typeof s.connect).toBe("function");
  });
});
