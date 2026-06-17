import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseIntentFiles, labelFor } from "../../../src/intent/parser.js";

describe("parseIntentFiles", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vibedrift-intent-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty hints + all-missing when no intent files exist", async () => {
    const result = await parseIntentFiles(dir);
    expect(result.hints).toEqual([]);
    expect(result.sourcesScanned).toEqual([]);
    expect(result.sourcesMissing.length).toBeGreaterThan(0);
  });

  it("extracts a repository pattern hint from CLAUDE.md", async () => {
    await writeFile(
      join(dir, "CLAUDE.md"),
      `# My Project\n\n## Conventions\n- Use the repository pattern for data access\n`,
    );
    const result = await parseIntentFiles(dir);
    expect(result.sourcesScanned).toContain("CLAUDE.md");
    const archHints = result.hints.filter((h) => h.category === "architectural_consistency");
    expect(archHints.length).toBeGreaterThan(0);
    const repo = archHints.find((h) => h.pattern === "repository");
    expect(repo).toBeDefined();
    expect(repo!.source).toBe("CLAUDE.md");
    // Inside "Conventions" heading + "use" imperative should push confidence ≥ 0.9
    expect(repo!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("extracts a security_posture (auth required) hint", async () => {
    await writeFile(
      join(dir, "CLAUDE.md"),
      `# Conventions\n- All endpoints require authentication\n`,
    );
    const result = await parseIntentFiles(dir);
    const sec = result.hints.find((h) => h.category === "security_posture");
    expect(sec).toBeDefined();
    expect(sec!.pattern).toBe("auth_required");
  });

  it("extracts from AGENTS.md and .cursorrules", async () => {
    await writeFile(
      join(dir, "AGENTS.md"),
      `## Architecture\n- async/await everywhere\n`,
    );
    await writeFile(
      join(dir, ".cursorrules"),
      `Prefer named exports\nAvoid default exports\n`,
    );
    const result = await parseIntentFiles(dir);
    expect(result.sourcesScanned).toEqual(expect.arrayContaining(["AGENTS.md", ".cursorrules"]));

    const async = result.hints.find((h) => h.pattern === "async_await");
    expect(async).toBeDefined();
    expect(async!.source).toBe("AGENTS.md");

    const named = result.hints.find((h) => h.pattern === "named");
    expect(named).toBeDefined();
    expect(named!.source).toBe(".cursorrules");
  });

  it("respects negation — 'do not use default exports' does NOT emit a default-export hint", async () => {
    await writeFile(
      join(dir, "CLAUDE.md"),
      `# Conventions\n- Do not use default exports\n- Avoid .then() chains\n`,
    );
    const result = await parseIntentFiles(dir);
    const defaultExport = result.hints.find((h) => h.pattern === "default");
    expect(defaultExport).toBeUndefined();
    const thenChain = result.hints.find((h) => h.pattern === "then_chain");
    expect(thenChain).toBeUndefined();
  });

  it("dedupes: CLAUDE.md wins over AGENTS.md on ties", async () => {
    await writeFile(join(dir, "CLAUDE.md"), `# Conventions\n- Use camelCase\n`);
    await writeFile(join(dir, "AGENTS.md"), `# Conventions\n- Use camelCase\n`);
    const result = await parseIntentFiles(dir);
    const camel = result.hints.filter((h) => h.pattern === "camelCase");
    expect(camel).toHaveLength(1);
    expect(camel[0].source).toBe("CLAUDE.md");
  });

  it("keeps higher-confidence hint when two sources have the same pattern", async () => {
    // CLAUDE.md mentions repository in prose (lower confidence)
    await writeFile(
      join(dir, "CLAUDE.md"),
      `We sometimes use the repository pattern.\n`,
    );
    // AGENTS.md declares it formally (higher confidence)
    await writeFile(
      join(dir, "AGENTS.md"),
      `## Conventions\n- Use repository pattern\n`,
    );
    const result = await parseIntentFiles(dir);
    const repo = result.hints.find((h) => h.pattern === "repository");
    expect(repo).toBeDefined();
    expect(repo!.source).toBe("AGENTS.md");
    expect(repo!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("assigns line numbers matching where the declaration lives", async () => {
    await writeFile(
      join(dir, "CLAUDE.md"),
      [
        "# Project",           // 1
        "",                    // 2
        "## Conventions",      // 3
        "- Use async/await",   // 4
        "",                    // 5
        "## Other",            // 6
      ].join("\n"),
    );
    const result = await parseIntentFiles(dir);
    const async = result.hints.find((h) => h.pattern === "async_await");
    expect(async!.line).toBe(4);
  });

  it("handles empty files without crashing", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "");
    await writeFile(join(dir, ".cursorrules"), "\n\n\n");
    const result = await parseIntentFiles(dir);
    expect(result.hints).toEqual([]);
  });

  it("is tolerant of .claude/instructions.md being inside a subdirectory", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ".claude/instructions.md"),
      `## Conventions\n- Use the repository pattern\n`,
    );
    const result = await parseIntentFiles(dir);
    expect(result.sourcesScanned).toContain(".claude/instructions.md");
    expect(result.hints.some((h) => h.pattern === "repository")).toBe(true);
  });

  describe("newly-added categories (Epic 2)", () => {
    it("parses a logging_consistency declaration (winston)", async () => {
      await writeFile(
        join(dir, "CLAUDE.md"),
        `## Conventions\n- Use winston for structured logging\n`,
      );
      const result = await parseIntentFiles(dir);
      const hint = result.hints.find((h) => h.category === "logging_consistency");
      expect(hint).toBeDefined();
      expect(hint!.pattern).toBe("structured");
    });

    it("parses a state_management_consistency declaration (zustand)", async () => {
      await writeFile(
        join(dir, "CLAUDE.md"),
        `## Conventions\n- Use Zustand for global state\n`,
      );
      const result = await parseIntentFiles(dir);
      const hint = result.hints.find((h) => h.category === "state_management_consistency");
      expect(hint).toBeDefined();
      expect(hint!.pattern).toBe("zustand");
    });

    it("parses a test_structure_consistency declaration (describe/it)", async () => {
      await writeFile(
        join(dir, "CLAUDE.md"),
        `## Conventions\n- Use describe/it for BDD style tests\n`,
      );
      const result = await parseIntentFiles(dir);
      const hint = result.hints.find((h) => h.category === "test_structure_consistency");
      expect(hint).toBeDefined();
      expect(hint!.pattern).toBe("bdd_nested");
    });

    it("parses return_shape_consistency with the updated canonical pattern values", async () => {
      // Epic 2 renamed `throw` → `throws` to match the detector's emitted
      // values. Confirm the parser now emits the correct canonical name.
      await writeFile(
        join(dir, "CLAUDE.md"),
        `## Conventions\n- Throw on error instead of returning null\n`,
      );
      const result = await parseIntentFiles(dir);
      const hint = result.hints.find((h) => h.category === "return_shape_consistency");
      expect(hint).toBeDefined();
      expect(hint!.pattern).toBe("throws");
    });
  });
});

describe("labelFor", () => {
  it("returns the human label for a known (category, pattern) pair", () => {
    expect(labelFor("architectural_consistency", "repository")).toBe("repository pattern");
    expect(labelFor("naming_conventions", "camelCase")).toBe("camelCase");
  });

  it("returns null for unknown categories or patterns", () => {
    expect(labelFor("phantom_scaffolding", "anything")).toBeNull();
    expect(labelFor("architectural_consistency", "nonexistent_pattern")).toBeNull();
  });
});
