import { describe, it, expect } from "vitest";
import { sanitizeResultForUpload } from "../../../src/ml-client/sanitize-result.js";
import type { ScanResult } from "../../../src/core/types.js";

/**
 * The cloud cannot backfill stored scores by version unless the CLI actually
 * uploads the scoring version. Before this fix the version was computed but
 * stripped before reaching Supabase (root cause of the dashboard's fragile
 * `score.max === 80 ?` sniff). sanitizeResultForUpload must carry it through.
 */
function mkResult(overrides: Partial<ScanResult>): ScanResult {
  return {
    context: {
      rootDir: "/tmp/proj",
      dominantLanguage: "typescript",
      languageBreakdown: new Map(),
      totalLines: 100,
      files: [],
    },
    compositeScore: 70,
    maxCompositeScore: 100,
    scores: {},
    hygieneScore: 90,
    maxHygieneScore: 100,
    hygieneScores: {},
    findings: [],
    driftFindings: [],
    driftScores: {},
    perFileScores: new Map(),
    teaseMessages: [],
    scanTimeMs: 5,
    ...overrides,
  } as unknown as ScanResult;
}

describe("sanitizeResultForUpload — scoringVersion passthrough", () => {
  it("includes scoringVersion in the uploaded payload", () => {
    const out = sanitizeResultForUpload(mkResult({ scoringVersion: "v3" }));
    expect(out.scoringVersion).toBe("v3");
  });

  it("sends null (not undefined) when no scoringVersion is set", () => {
    const out = sanitizeResultForUpload(mkResult({ scoringVersion: undefined }));
    expect(out.scoringVersion).toBeNull();
  });
});

/**
 * Source-code egress. The sanitizer's own header and the published privacy
 * policy both promise that no source code or file contents are uploaded, but
 * the helper that strips them (`sanitizeFilesList`) was only reachable when a
 * `files` key was found INSIDE an object. The top-level call passes the array
 * directly, so every file kept its `content` and shipped.
 *
 * The pre-existing tests above could not catch it: they pass `files: []`.
 */
const SECRET_SOURCE = "const STRIPE_KEY = 'sk_live_NEVER_UPLOAD_ME';\nfunction billing() { return 42; }";
const SECRET_SNIPPET = "const API_TOKEN = 'tok_live_NEVER_UPLOAD_ME';";

function withCode(): ScanResult {
  return mkResult({
    context: {
      rootDir: "/Users/someone/private-repo",
      dominantLanguage: "typescript",
      languageBreakdown: new Map(),
      totalLines: 11,
      files: [
        {
          path: "/Users/someone/private-repo/src/billing.ts",
          relativePath: "src/billing.ts",
          language: "typescript",
          content: SECRET_SOURCE,
          lineCount: 2,
          tree: { type: "program" },
        },
        {
          path: "/Users/someone/private-repo/src/auth.ts",
          relativePath: "src/auth.ts",
          language: "typescript",
          content: SECRET_SOURCE,
          lineCount: 9,
        },
      ],
    },
    findings: [
      {
        id: "f1",
        category: "architectural_consistency",
        message: "3 handlers bypass the repository layer",
        locations: [{ file: "src/billing.ts", line: 3, snippet: SECRET_SNIPPET }],
      },
    ],
  } as unknown as Partial<ScanResult>);
}

const files = (r: ScanResult) =>
  (sanitizeResultForUpload(r) as { files?: Array<Record<string, unknown>> }).files ?? [];

describe("sanitizeResultForUpload — source code never leaves the machine", () => {
  it("does not upload raw file contents", () => {
    expect(JSON.stringify(sanitizeResultForUpload(withCode()))).not.toContain("sk_live_NEVER_UPLOAD_ME");
  });

  it("does not upload any part of a file body", () => {
    expect(JSON.stringify(sanitizeResultForUpload(withCode()))).not.toContain("function billing()");
  });

  it("strips the content key from every file entry", () => {
    const out = files(withCode());
    expect(out.length).toBe(2);
    for (const f of out) expect(f).not.toHaveProperty("content");
  });

  it("never leaks the user's absolute paths", () => {
    expect(JSON.stringify(sanitizeResultForUpload(withCode()))).not.toContain("/Users/someone/private-repo");
  });

  it("drops tree-sitter AST nodes", () => {
    for (const f of files(withCode())) expect(f).not.toHaveProperty("tree");
  });
});

describe("sanitizeResultForUpload — keeps what the dashboard needs", () => {
  it("preserves the file count, which the dashboard reads as files.length", () => {
    expect(files(withCode())).toHaveLength(2);
    expect((sanitizeResultForUpload(withCode()) as { fileCount?: number }).fileCount).toBe(2);
  });

  it("keeps repo-relative paths and per-file metadata", () => {
    const f = files(withCode())[0];
    expect(f.relativePath).toBe("src/billing.ts");
    expect(f.language).toBe("typescript");
    expect(f.lineCount).toBe(2);
  });

  it("keeps the finding metadata the dashboard renders", () => {
    const out = sanitizeResultForUpload(withCode()) as Record<string, unknown>;
    const finding = (out.findings as Array<Record<string, unknown>>)[0];
    expect(finding.message).toBe("3 handlers bypass the repository layer");
    expect(finding.category).toBe("architectural_consistency");
    const loc = (finding.locations as Array<Record<string, unknown>>)[0];
    expect(loc.file).toBe("src/billing.ts");
    expect(loc.line).toBe(3);
  });

  /**
   * Deliberate, not an oversight. A finding's `snippet` is the excerpt the
   * dashboard renders under "Evidence" (see ScanReport.tsx), so stripping it
   * would blank that view. It is a few lines cited as proof of a specific
   * finding, which is a different thing from shipping whole file bodies.
   * Pinned so nobody "fixes" it into a regression.
   */
  it("keeps the finding evidence snippet the report renders", () => {
    const out = sanitizeResultForUpload(withCode()) as Record<string, unknown>;
    const loc = (out.findings as Array<{ locations: Array<Record<string, unknown>> }>)[0].locations[0];
    expect(loc.snippet).toBe(SECRET_SNIPPET);
  });
});

/**
 * codeDnaResult.functions[] (ExtractedFunction) carries `rawBody` — the
 * COMPLETE body of every function extracted from the codebase, unbounded —
 * plus `declarationCode` (the signature line) and `bodyTokens` (a
 * near-lossless token reconstruction of the body). Unlike a finding's
 * `snippet` or a drift `Evidence.code` (bounded, cited excerpts — see the
 * pinned test above), these three fields have no size bound and are not
 * cited against a specific finding: they are the function, verbatim.
 *
 * `log-scan.ts`'s `compactPayload` used to drop `codeDnaResult.functions`
 * ONLY as a >9MB size-trimming fallback — a payload-size concern, not a
 * privacy boundary. On any scan under that threshold (the common case),
 * every function body in the repo shipped to the dashboard on every
 * signed-in scan, contradicting this module's own "no file contents"
 * header.
 */
describe("sanitizeResultForUpload — codeDnaResult never carries function bodies", () => {
  function withCodeDna(): ScanResult {
    return mkResult({
      codeDnaResult: {
        functions: [
          {
            name: "billing",
            file: "/Users/someone/private-repo/src/billing.ts",
            relativePath: "src/billing.ts",
            line: 2,
            language: "typescript",
            params: [],
            paramCount: 0,
            rawBody: SECRET_SOURCE,
            declarationCode: "function billing() {",
            domainCategory: "billing",
            bodyTokens: ["function", "billing", "(", ")", "{", "return", "42", ";", "}"],
            bodyTokenCount: 9,
            bodyHash: 123456,
          },
        ],
        fingerprints: [],
        duplicateGroups: [],
        sequenceSimilarities: [],
        patternDistributions: [],
        taintFlows: [],
        deviationJustifications: [],
        findings: [],
        timings: {
          extractionMs: 1,
          fingerprintMs: 1,
          sequenceMs: 1,
          patternMs: 1,
          taintMs: 1,
          deviationMs: 1,
          totalMs: 6,
        },
      },
    } as unknown as Partial<ScanResult>);
  }

  it("does not upload any function's raw body", () => {
    expect(JSON.stringify(sanitizeResultForUpload(withCodeDna()))).not.toContain("sk_live_NEVER_UPLOAD_ME");
  });

  it("does not upload any part of a function body via rawBody", () => {
    expect(JSON.stringify(sanitizeResultForUpload(withCodeDna()))).not.toContain("function billing()");
  });

  it("does not upload declarationCode or bodyTokens", () => {
    const out = sanitizeResultForUpload(withCodeDna()) as Record<string, unknown>;
    const cdr = out.codeDnaResult as { functions: Array<Record<string, unknown>> };
    const fn = cdr.functions[0];
    expect(fn).not.toHaveProperty("rawBody");
    expect(fn).not.toHaveProperty("declarationCode");
    expect(fn).not.toHaveProperty("bodyTokens");
  });

  it("keeps the function metadata the dashboard's codeDnaSummary needs", () => {
    const out = sanitizeResultForUpload(withCodeDna()) as Record<string, unknown>;
    const cdr = out.codeDnaResult as { functions: Array<Record<string, unknown>> };
    const fn = cdr.functions[0];
    expect(fn.name).toBe("billing");
    expect(fn.relativePath).toBe("src/billing.ts");
    expect(fn.line).toBe(2);
    expect(fn.language).toBe("typescript");
    expect(fn.bodyTokenCount).toBe(9);
    expect(fn.bodyHash).toBe(123456);
  });
});
