import { describe, it, expect, afterEach, vi } from "vitest";
import { synthesizeFixPrompts } from "../../../src/ml-client/fix-prompts.js";
import type { AnalysisContext, Finding } from "../../../src/core/types.js";

function ctxWith(files: Array<{ relativePath: string; content: string }>): AnalysisContext {
  return { files: files.map((f) => ({ ...f, path: f.relativePath, language: "typescript", lineCount: f.content.split("\n").length })) } as unknown as AnalysisContext;
}

function driftFinding(over: Partial<Finding> = {}): Finding {
  return {
    analyzerId: "drift-architectural_consistency",
    severity: "warning",
    confidence: 0.8,
    message: "DRIFT: src/order.ts uses raw SQL while peers use a repository",
    locations: [{ file: "src/order.ts", line: 1 }],
    tags: [],
    consistencyImpact: 1.2,
    metadata: { dominantPattern: "repository", dominantFiles: ["src/repo.ts"] },
    ...over,
  } as Finding;
}

function stubFetch(impl: (init: any) => any) {
  const spy = vi.fn(async (_url: string, init: any) => impl(init));
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("synthesizeFixPrompts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the DRIFTING code + peer references, and attaches the returned fix prose", async () => {
    const ctx = ctxWith([
      { relativePath: "src/order.ts", content: "export function loadOrder(id){ const r = db.query('select * from orders'); return r; }" },
      { relativePath: "src/repo.ts", content: "export async function findOrder(id){ return await OrderRepo.findById(id); }" },
    ]);
    const finding = driftFinding();
    const spy = stubFetch(() => ({ ok: true, json: async () => ({ prompts: { "1": "1) Replace db.query with OrderRepo.findById()." } }) }));

    await synthesizeFixPrompts([finding], ctx, { token: "tok" });

    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(spy.mock.calls[0][1].body);
    const item = body.items[0];
    expect(item.deviating_snippet).toContain("db.query"); // the code to fix is sent
    expect(item.dominant_pattern).toBe("repository");
    expect(item.reference_files[0].path).toBe("src/repo.ts");
    expect(finding.metadata!.fixPromptProse).toMatch(/OrderRepo\.findById/);
  });

  it("prefers the finding's own evidence snippet for the drifting code when present", async () => {
    const ctx = ctxWith([
      { relativePath: "src/order.ts", content: "// big file\n".repeat(100) },
      { relativePath: "src/repo.ts", content: "export async function findOrder(id){ return await OrderRepo.findById(id); }" },
    ]);
    const finding = driftFinding({ locations: [{ file: "src/order.ts", line: 5, snippet: "db.query('SELECT 1')" }] });
    const spy = stubFetch(() => ({ ok: true, json: async () => ({ prompts: { "1": "fix it" } }) }));

    await synthesizeFixPrompts([finding], ctx, { token: "tok" });
    const item = JSON.parse(spy.mock.calls[0][1].body).items[0];
    expect(item.deviating_snippet).toBe("db.query('SELECT 1')");
  });

  it("skips findings with no peer reference files (nothing to ground the fix in)", async () => {
    const ctx = ctxWith([{ relativePath: "src/order.ts", content: "function f(){}" }]);
    const finding = driftFinding({ metadata: { dominantPattern: "repository", dominantFiles: [] } });
    const spy = stubFetch(() => ({ ok: true, json: async () => ({ prompts: {} }) }));
    await synthesizeFixPrompts([finding], ctx, { token: "tok" });
    expect(spy).not.toHaveBeenCalled();
  });
});
