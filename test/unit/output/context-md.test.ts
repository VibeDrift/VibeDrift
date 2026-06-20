import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContextMarkdown, writeContextFiles } from "../../../src/output/context-md.js";

function minimalResult() {
  return {
    compositeScore: 80,
    maxCompositeScore: 100,
    context: { rootDir: "/r/proj", dominantLanguage: "typescript", files: [{}, {}], totalLines: 1000 },
    driftFindings: [],
    findings: [],
  } as any;
}

describe("buildContextMarkdown referral link", () => {
  it("includes a vibedrift.ai link so a committed context.md is a silent referral", () => {
    const md = buildContextMarkdown(minimalResult(), "acme-app");
    expect(md).toContain("https://vibedrift.ai");
  });

  it("still renders the project name and score", () => {
    const md = buildContextMarkdown(minimalResult(), "acme-app");
    expect(md).toContain("acme-app");
    expect(md).toContain("Vibe Drift Score");
  });

  it("points to fix-plan.md when paid, and to upgrade when free", () => {
    expect(buildContextMarkdown(minimalResult(), "acme-app", true)).toContain(".vibedrift/fix-plan.md`");
    const free = buildContextMarkdown(minimalResult(), "acme-app", false);
    expect(free).toMatch(/Pro feature/);
    expect(free).toContain("vibedrift upgrade");
  });
});

describe("writeContextFiles — fix prompts are paid", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  function tmp() {
    const d = mkdtempSync(join(tmpdir(), "vd-ctx-"));
    dirs.push(d);
    return d;
  }

  it("FREE: fix-plan.md / fix-prompts.md are an upsell; context.md + patterns.json still written", async () => {
    const dir = tmp();
    const { written } = await writeContextFiles(dir, minimalResult(), "acme-app", false);
    expect(written).toContain(".vibedrift/context.md");
    expect(written).toContain(".vibedrift/patterns.json");
    const fixPlan = readFileSync(join(dir, ".vibedrift", "fix-plan.md"), "utf8");
    const fixPrompts = readFileSync(join(dir, ".vibedrift", "fix-prompts.md"), "utf8");
    expect(fixPlan).toMatch(/Pro/);
    expect(fixPrompts).toMatch(/Pro/);
    // context.md is full content, not an upsell stub
    expect(readFileSync(join(dir, ".vibedrift", "context.md"), "utf8")).toContain("Vibe Drift Score");
  });

  it("PAID (no findings): fix-plan.md is the real well-aligned message, not an upsell", async () => {
    const dir = tmp();
    await writeContextFiles(dir, minimalResult(), "acme-app", true);
    const fixPlan = readFileSync(join(dir, ".vibedrift", "fix-plan.md"), "utf8");
    expect(fixPlan).not.toMatch(/Pro/);
    expect(fixPlan).toContain("well-aligned");
  });
});
