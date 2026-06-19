/**
 * Architectural guard: src/tools-core is the channel-neutral core. It must never
 * depend on a transport. If a tool's logic starts importing the MCP SDK, the
 * "core + adapters" boundary has leaked and re-shipping the tools over another
 * channel (Agent Skill, code-mode import, git hook) stops being a thin adapter.
 *
 * This is intentionally a string check, not a type check: it catches the coupling
 * at the source, including in comments-as-code or dynamic imports.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const CORE_DIR = join(process.cwd(), "src", "tools-core");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("tools-core channel neutrality", () => {
  const files = walk(CORE_DIR);

  it("finds the core modules to check", () => {
    // result + nudge + finalize + index + 5 tools = at least 9 files.
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files.map((f) => [relative(process.cwd(), f), f] as const))(
    "%s does not import the MCP SDK",
    (_label, file) => {
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/@modelcontextprotocol\/sdk/);
    },
  );
});
