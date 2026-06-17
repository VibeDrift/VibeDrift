import { describe, it, expect } from "vitest";
import { toToolResult, noBaselineResult } from "../../../src/mcp/envelope.js";

describe("MCP envelope", () => {
  it("mirrors structuredContent into a text block (SDK convention) and is not an error", () => {
    const r = toToolResult({ status: "ok", file: "a.ts", fits: true, deviations: [] });
    expect(r.structuredContent).toEqual({ status: "ok", file: "a.ts", fits: true, deviations: [] });
    expect(r.content).toEqual([{ type: "text", text: JSON.stringify(r.structuredContent, null, 2) }]);
    expect((r as { isError?: boolean }).isError).toBeUndefined();
  });

  it("noBaselineResult is an empty-but-valid result that points at `vibedrift scan`, not an error", () => {
    const r = noBaselineResult();
    expect(r.structuredContent.status).toBe("no_baseline");
    expect(r.structuredContent.message).toMatch(/vibedrift scan/);
    expect((r as { isError?: boolean }).isError).toBeUndefined();
  });
});
