import { describe, it, expect } from "vitest";
import { duplicatesAnalyzer } from "../../../src/analyzers/duplicates.js";
import type { AnalysisContext } from "../../../src/core/types.js";

function makeCtx(files: { relativePath: string; content: string }[]): AnalysisContext {
  return {
    rootDir: "/test",
    files: files.map((f) => ({
      path: "/test/" + f.relativePath,
      relativePath: f.relativePath,
      language: "typescript" as const,
      content: f.content,
      lineCount: f.content.split("\n").length,
    })),
    packageJson: null,
    goMod: null,
    cargoToml: null,
    requirementsTxt: null,
    envExample: null,
    totalLines: files.reduce((s, f) => s + f.content.split("\n").length, 0),
    languageBreakdown: new Map([["typescript", { files: files.length, lines: 100 }]]),
    dominantLanguage: "typescript",
  };
}

describe("duplicates analyzer", () => {
  it("detects duplicate functions with similar token structure across files", async () => {
    const ctx = makeCtx([
      {
        relativePath: "a.ts",
        content: `export async function fetchUsers(page: number) {
  const response = await fetch('/api/users?page=' + page);
  const data = await response.json();
  if (!data.success) {
    throw new Error('Failed to fetch users');
  }
  return data.results;
}`,
      },
      {
        relativePath: "b.ts",
        content: `export async function getUsers(page: number) {
  const response = await fetch('/api/users?page=' + page);
  const data = await response.json();
  if (!data.success) {
    throw new Error('Failed to get users');
  }
  return data.results;
}`,
      },
    ]);

    const findings = await duplicatesAnalyzer.analyze(ctx);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].tags).toContain("token-based");
  });

  it("returns empty for distinct functions", async () => {
    const ctx = makeCtx([
      {
        relativePath: "a.ts",
        content: `export function add(a: number, b: number) { return a + b; }`,
      },
      {
        relativePath: "b.ts",
        content: `export async function fetchData(url: string) {
  const res = await fetch(url);
  return res.json();
}`,
      },
    ]);

    const findings = await duplicatesAnalyzer.analyze(ctx);
    expect(findings).toEqual([]);
  });

  it("is insensitive to variable/parameter renames", async () => {
    // Same logic, different local names. Should still flag.
    const ctx = makeCtx([
      {
        relativePath: "a.ts",
        content: `export function processA(input: Input) {
  const result = input.data;
  const count = result.length;
  if (count > 0) {
    for (const item of result) {
      handle(item);
    }
  }
  return count;
}`,
      },
      {
        relativePath: "b.ts",
        content: `export function processB(payload: Payload) {
  const value = payload.data;
  const total = value.length;
  if (total > 0) {
    for (const entry of value) {
      handle(entry);
    }
  }
  return total;
}`,
      },
    ]);

    const findings = await duplicatesAnalyzer.analyze(ctx);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("does NOT conflate functions that call different APIs with identical control flow", async () => {
    // Key S3 invariant: db.query and Repository.find both "do a lookup and
    // return the result", but the API call carries architectural meaning.
    // The old tokenizer normalized both to ID0.ID1() — these became
    // duplicates. The new normalizer preserves call targets literally.
    const ctx = makeCtx([
      {
        relativePath: "raw.ts",
        content: `export async function getUserRaw(id: string) {
  const row = await db.query('SELECT * FROM users WHERE id = ?', [id]);
  if (!row) {
    throw new Error('not found');
  }
  return row;
}`,
      },
      {
        relativePath: "repo.ts",
        content: `export async function getUserRepo(id: string) {
  const entity = await Repository.find('users', id);
  if (!entity) {
    throw new Error('not found');
  }
  return entity;
}`,
      },
    ]);

    const findings = await duplicatesAnalyzer.analyze(ctx);
    // These are architecturally DIFFERENT (raw SQL vs repository pattern).
    // The analyzer must not treat them as duplicates.
    expect(findings).toHaveLength(0);
  });

  it("still flags two functions that call the SAME API with same control flow", async () => {
    // Control: two handlers that both use `db.query` with the same flow.
    // Should be flagged — they really are duplicates.
    const ctx = makeCtx([
      {
        relativePath: "users.ts",
        content: `export async function getUser(id: string) {
  const row = await db.query('SELECT * FROM users WHERE id = ?', [id]);
  if (!row) {
    throw new Error('not found');
  }
  return row;
}`,
      },
      {
        relativePath: "orders.ts",
        content: `export async function getOrder(id: string) {
  const row = await db.query('SELECT * FROM orders WHERE id = ?', [id]);
  if (!row) {
    throw new Error('not found');
  }
  return row;
}`,
      },
    ]);

    const findings = await duplicatesAnalyzer.analyze(ctx);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("handles a 500-function corpus in reasonable time and without the old 200-fn warning", async () => {
    // The old code emitted an info finding saying detection was limited
    // once a project had >200 functions; the new code handles this
    // natively via LSH.
    const makeFn = (i: number) => `
export function op${i}(x: number) {
  const result = x * ${i};
  if (result > 0) {
    return result + ${i};
  }
  return ${i};
}
`;
    const files = Array.from({ length: 500 }, (_, i) => ({
      relativePath: `f${i}.ts`,
      content: makeFn(i),
    }));
    const ctx = makeCtx(files);

    const t0 = Date.now();
    const findings = await duplicatesAnalyzer.analyze(ctx);
    const ms = Date.now() - t0;

    // Must finish in under 30 seconds on the 500-function corpus.
    expect(ms).toBeLessThan(30_000);
    // Critically: no "detection limited" fallback finding.
    expect(findings.some((f) => f.tags.includes("scalability"))).toBe(false);
  });

  it("skips tiny functions below the minimum token threshold", async () => {
    const ctx = makeCtx([
      { relativePath: "a.ts", content: `export function tiny() { return 1; }` },
      { relativePath: "b.ts", content: `export function tiny2() { return 2; }` },
    ]);
    const findings = await duplicatesAnalyzer.analyze(ctx);
    // Both too small to tokenize meaningfully (<15 tokens / <20-byte body).
    expect(findings).toEqual([]);
  });

  it("has a monotonically-bumped version so the findings cache invalidates", () => {
    expect(duplicatesAnalyzer.version).toBeGreaterThanOrEqual(2);
  });
});
