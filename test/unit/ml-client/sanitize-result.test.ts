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
   * Since #112 the excerpt is kept THROUGH maskSecrets: the surrounding code
   * survives, a credential literal inside it does not. Pinned so nobody
   * "fixes" either half into a regression.
   */
  it("keeps the finding evidence snippet the report renders, with secrets masked", () => {
    const out = sanitizeResultForUpload(withCode()) as Record<string, unknown>;
    const loc = (out.findings as Array<{ locations: Array<Record<string, unknown>> }>)[0].locations[0];
    expect(loc.snippet).toBe("const API_TOKEN = [masked];");
    expect(JSON.stringify(out)).not.toContain("tok_live_NEVER_UPLOAD_ME");
  });
});

/**
 * Secret-bearing excerpts (#112). Signed-in scans upload finding snippets,
 * drift evidence lines, and taint expressions, and before this fix none of
 * them passed through a secret masker: a credential inside a cited line
 * reached `/v1/scans/log` verbatim (reproduced on published 0.21.3 with an
 * AKIA-shaped line, telemetry disabled). The excerpts must keep flowing —
 * the dashboard renders them as Evidence — but through `maskSecrets` first.
 * Fake secret fixtures are assembled from split parts (the mask.test.ts
 * pattern) so no contiguous secret-shaped literal appears in source.
 */
const jj = (...parts: string[]): string => parts.join("");
const AWS_KEY = jj("AKIA", "IOSFODNN7EXAMPLE"); // AWS's official docs example key
const DB_PASSWORD = jj("hunter2", "hunter2");

function withSecrets(): ScanResult {
  return mkResult({
    context: {
      rootDir: "/Users/someone/private-repo",
      dominantLanguage: "typescript",
      languageBreakdown: new Map(),
      totalLines: 120,
      files: [],
    },
    findings: [
      {
        id: "f-aws",
        category: "security_posture",
        message: "hardcoded credential in the billing service",
        locations: [
          {
            file: "src/billing/aws-client.ts",
            line: 14,
            snippet: `const s3 = new S3Client({ credentials: { accessKeyId: "${AWS_KEY}" } });`,
          },
          { file: "src/billing/aws-client.ts", line: 18, snippet: `const logger = createLogger("billing");` },
        ],
      },
    ],
    driftFindings: [
      {
        detector: "security-consistency",
        driftCategory: "security_posture",
        severity: "error",
        confidence: 0.9,
        finding: "2 of 9 route handlers read credentials from literals",
        dominantPattern: "process.env for credentials",
        dominantCount: 7,
        totalRelevantFiles: 9,
        consistencyScore: 78,
        deviatingFiles: [
          {
            path: "src/billing/aws-client.ts",
            detectedPattern: "literal credential",
            evidence: [{ line: 14, code: `const accessKeyId = "${AWS_KEY}";` }],
          },
        ],
        recommendation: "move the credential to process.env",
      },
    ],
    codeDnaResult: {
      functions: [],
      fingerprints: [],
      duplicateGroups: [],
      sequenceSimilarities: [],
      patternDistributions: [],
      taintFlows: [
        {
          file: "/Users/someone/private-repo/src/db/pool.ts",
          relativePath: "src/db/pool.ts",
          functionName: "createPool",
          source: { type: "env", expression: "process.env.DATABASE_URL", line: 3, severity: "info" },
          sink: {
            type: "connection",
            expression: `createPool("postgres://billing:${DB_PASSWORD}@db.internal:5432/billing")`,
            line: 9,
            severity: "warning",
          },
          sanitized: false,
          language: "typescript",
        },
      ],
      deviationJustifications: [],
      findings: [],
      timings: {},
    },
  } as unknown as Partial<ScanResult>);
}

describe("sanitizeResultForUpload — secrets are masked before upload (#112)", () => {
  it("masks an AWS key inside a finding's evidence snippet and keeps the code around it", () => {
    const out = sanitizeResultForUpload(withSecrets());
    const locs = (out.findings as Array<{ locations: Array<Record<string, unknown>> }>)[0].locations;
    expect(locs[0].snippet).toBe('const s3 = new S3Client({ credentials: { accessKeyId: "[masked]" } });');
    // Non-secret excerpts pass through untouched, so the Evidence view stays useful.
    expect(locs[1].snippet).toBe('const logger = createLogger("billing");');
  });

  it("masks a credential inside drift evidence code", () => {
    const out = sanitizeResultForUpload(withSecrets());
    const dev = (out.driftFindings as Array<{ deviatingFiles: Array<{ evidence: Array<Record<string, unknown>> }> }>)[0]
      .deviatingFiles[0];
    expect(dev.evidence[0].code).toBe('const accessKeyId = "[masked]";');
  });

  it("masks the password inside a taint sink's connection string and keeps scheme and user", () => {
    const out = sanitizeResultForUpload(withSecrets());
    const flow = (out.codeDnaResult as { taintFlows: Array<{ sink: Record<string, unknown> }> }).taintFlows[0];
    expect(flow.sink.expression).toBe('createPool("postgres://billing:[masked]@db.internal:5432/billing")');
  });

  it("leaves detector prose and pattern labels intact (masking is not redaction)", () => {
    const out = sanitizeResultForUpload(withSecrets());
    const drift = (out.driftFindings as Array<Record<string, unknown>>)[0];
    expect(drift.dominantPattern).toBe("process.env for credentials");
    expect(drift.recommendation).toBe("move the credential to process.env");
  });

  it("no planted secret appears anywhere in the upload payload", () => {
    const payload = JSON.stringify(sanitizeResultForUpload(withSecrets()));
    expect(payload).not.toContain(AWS_KEY);
    expect(payload).not.toContain(DB_PASSWORD);
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
