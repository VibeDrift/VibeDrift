import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, registerGetIntentHints } from "../../../../src/mcp/tools/get-intent-hints.js";

describe("get_intent_hints tool", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "vd-intent-tool-"));
    writeFileSync(
      join(repo, "CLAUDE.md"),
      [
        "# Project conventions",
        "",
        "## Conventions",
        "- Use the repository pattern for data access.",
        "- Use async/await throughout. No .then() chains.",
        "- Use named exports only. Avoid default exports.",
        "",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("returns declared hints with source + line, no baseline required, confidence dropped", async () => {
    const out = await run({ rootDir: repo });
    expect(out.status).toBe("ok");
    expect(out.hints.length).toBeGreaterThan(0);
    const h = out.hints[0];
    expect(typeof h.dimension).toBe("string"); // mapped from IntentHint.category
    expect(typeof h.pattern).toBe("string");
    expect(h.source).toMatch(/CLAUDE\.md/);
    expect(typeof h.line).toBe("number");
    expect(h.binding).toBe(true);
    expect(h).not.toHaveProperty("confidence"); // agent shouldn't threshold
  });

  it("returns ok with an empty list when no intent files exist (not an error)", async () => {
    const bare = mkdtempSync(join(tmpdir(), "vd-bare-"));
    try {
      const out = await run({ rootDir: bare });
      expect(out.status).toBe("ok");
      expect(out.hints).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("registers on a fresh server without throwing", () => {
    const s = new McpServer({ name: "t", version: "0" });
    expect(() => registerGetIntentHints.register(s)).not.toThrow();
  });
});
