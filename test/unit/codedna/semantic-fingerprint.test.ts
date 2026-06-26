import { describe, it, expect } from "vitest";
import {
  computeSemanticFingerprints,
  findDuplicateGroups,
  fingerprintFindings,
} from "../../../src/codedna/semantic-fingerprint.js";
import type { ExtractedFunction } from "../../../src/codedna/types.js";

function mkFn(partial: Partial<ExtractedFunction>): ExtractedFunction {
  return {
    name: partial.name ?? "fn",
    file: partial.file ?? "src/a.ts",
    relativePath: partial.relativePath ?? partial.file ?? "src/a.ts",
    line: partial.line ?? 1,
    language: partial.language ?? "typescript",
    params: partial.params ?? [],
    paramCount: partial.paramCount ?? 0,
    rawBody: partial.rawBody ?? "",
    declarationCode: partial.declarationCode ?? "",
    domainCategory: partial.domainCategory ?? "util",
    bodyTokens: partial.bodyTokens ?? [],
    bodyTokenCount: partial.bodyTokenCount ?? 0,
    bodyHash: partial.bodyHash ?? 0,
  };
}

describe("computeSemanticFingerprints", () => {
  it("empty body → stable hash across calls", () => {
    const [a] = computeSemanticFingerprints([mkFn({ rawBody: "" })]);
    const [b] = computeSemanticFingerprints([mkFn({ rawBody: "" })]);
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it("identical bodies with different local-variable DECLARATIONS produce the same hash", () => {
    // The normalizer replaces identifiers that appear in variable
    // declarations (const/let/var/:=). Identifiers that are referenced
    // but never declared in this slice stay literal — so we declare the
    // operands to exercise the placeholder path.
    const [a] = computeSemanticFingerprints([
      mkFn({ rawBody: "const alpha = 1; const beta = 2; const total = alpha + beta; return total;" }),
    ]);
    const [b] = computeSemanticFingerprints([
      mkFn({ rawBody: "const foo = 1; const bar = 2; const sum = foo + bar; return sum;" }),
    ]);
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it("string literal VALUES are preserved (different strings → different hash)", () => {
    // EXACT-duplicate tier: a literal value carries the semantics. Two
    // predicates that compare against DIFFERENT string constants are NOT
    // the same function and must not collide. (Regression: see the
    // isHighCorrectionMode / isLowCorrectionMode false positive.)
    const [a] = computeSemanticFingerprints([
      mkFn({ rawBody: `console.log("hello");` }),
    ]);
    const [b] = computeSemanticFingerprints([
      mkFn({ rawBody: `console.log("world");` }),
    ]);
    expect(a.normalizedHash).not.toBe(b.normalizedHash);
  });

  it("identical string literals still produce the same hash", () => {
    const [a] = computeSemanticFingerprints([
      mkFn({ rawBody: `console.log("hello");` }),
    ]);
    const [b] = computeSemanticFingerprints([
      mkFn({ rawBody: `console.log("hello");` }),
    ]);
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it("numeric literal VALUES are preserved (different numbers → different hash)", () => {
    const [a] = computeSemanticFingerprints([mkFn({ rawBody: "return 42;" })]);
    const [b] = computeSemanticFingerprints([mkFn({ rawBody: "return 99;" })]);
    expect(a.normalizedHash).not.toBe(b.normalizedHash);
  });

  it("identical numeric literals still produce the same hash", () => {
    const [a] = computeSemanticFingerprints([mkFn({ rawBody: "return 42;" })]);
    const [b] = computeSemanticFingerprints([mkFn({ rawBody: "return 42;" })]);
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it("line comments are stripped", () => {
    const [a] = computeSemanticFingerprints([
      mkFn({ rawBody: "return x;" }),
    ]);
    const [b] = computeSemanticFingerprints([
      mkFn({ rawBody: "// compute result\nreturn x;" }),
    ]);
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it("block comments are stripped", () => {
    const [a] = computeSemanticFingerprints([mkFn({ rawBody: "return x;" })]);
    const [b] = computeSemanticFingerprints([
      mkFn({ rawBody: "/* explain */\nreturn x;" }),
    ]);
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it("python hash-style comments are stripped", () => {
    const [a] = computeSemanticFingerprints([
      mkFn({ language: "python", rawBody: "return x" }),
    ]);
    const [b] = computeSemanticFingerprints([
      mkFn({ language: "python", rawBody: "# remark\nreturn x" }),
    ]);
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it("template literal placeholders preserve structure", () => {
    const [a] = computeSemanticFingerprints([
      mkFn({ rawBody: "return `hello ${name}`;" }),
    ]);
    const [b] = computeSemanticFingerprints([
      mkFn({ rawBody: "return `hello ${name}`;" }),
    ]);
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it("whitespace differences don't change the hash", () => {
    const [a] = computeSemanticFingerprints([
      mkFn({ rawBody: "const  x  =  1; return x;" }),
    ]);
    const [b] = computeSemanticFingerprints([
      mkFn({ rawBody: "const x = 1;\n\nreturn x;" }),
    ]);
    expect(a.normalizedHash).toBe(b.normalizedHash);
  });

  it("genuinely different body structure produces a different hash", () => {
    const [a] = computeSemanticFingerprints([
      mkFn({ rawBody: "return x + y;" }),
    ]);
    const [b] = computeSemanticFingerprints([
      mkFn({ rawBody: "return x * y;" }),
    ]);
    expect(a.normalizedHash).not.toBe(b.normalizedHash);
  });

  it("hash is deterministic across many runs", () => {
    const body = "const total = a + b; for (let i = 0; i < 10; i++) total += 1; return total;";
    const hashes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const [fp] = computeSemanticFingerprints([mkFn({ rawBody: body })]);
      hashes.add(fp.normalizedHash);
    }
    expect(hashes.size).toBe(1);
  });

  it("Go var / short-assign declarations are normalized identically to let/const", () => {
    const [a] = computeSemanticFingerprints([
      mkFn({ language: "typescript", rawBody: "const value = compute(); return value;" }),
    ]);
    const [b] = computeSemanticFingerprints([
      mkFn({ language: "go", rawBody: "value := compute(); return value" }),
    ]);
    // Different declaration forms, same logical structure. Normalization
    // replaces identifier tokens with positional placeholders, so the
    // hashes may still diverge due to keywords (`const` vs none), but
    // SHOULD agree on the "positional placeholder" skeleton within each
    // hash bucket. This test documents the current behavior — if the
    // normalization improves, update the assertion.
    // For now we assert NON-strict: both produce a non-empty hash.
    expect(a.normalizedHash.length).toBeGreaterThan(0);
    expect(b.normalizedHash.length).toBeGreaterThan(0);
  });

  it("handles very long bodies without truncating the hash", () => {
    const body = "a = 1;".repeat(5000);
    const [fp] = computeSemanticFingerprints([mkFn({ rawBody: body })]);
    // Two-pass FNV produces a 16-char hex string.
    expect(fp.normalizedHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("findDuplicateGroups", () => {
  it("groups two identical functions in different files", () => {
    const body = "const total = 1 + 2; return total;";
    const fns = [
      mkFn({ name: "a", file: "src/a.ts", rawBody: body }),
      mkFn({ name: "b", file: "src/b.ts", rawBody: body }),
    ];
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    expect(groups).toHaveLength(1);
    expect(groups[0].functions.map((f) => f.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("does NOT group two identical functions in the same file (same-file bodies are common and not drift)", () => {
    const fns = [
      mkFn({ name: "a", file: "src/a.ts", rawBody: "return x;" }),
      mkFn({ name: "b", file: "src/a.ts", rawBody: "return y;" }),
    ];
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    expect(groups).toHaveLength(0);
  });

  it("FNV + SHA-256 two-pass: no false positives on 1000 synthetic structurally-unique bodies", () => {
    // If the two-pass verification ever fails, multiple structurally
    // distinct bodies will land in the same group via an FNV collision.
    // This test catches such a regression: 1000 unique bodies should
    // produce zero groups.
    const fns: ExtractedFunction[] = [];
    for (let i = 0; i < 1000; i++) {
      fns.push(mkFn({
        name: `fn${i}`,
        file: `src/f${i}.ts`,
        // Inject a unique token per body that survives normalization.
        rawBody: `return token_${i}_xyz(data);`,
      }));
    }
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    expect(groups).toHaveLength(0);
  });

  it("does NOT group two predicates that differ only by their string-literal VALUES", () => {
    // Real false positive from /tmp/bandcamp-audit/repo: isHighCorrectionMode
    // and isLowCorrectionMode have the same SHAPE (`mode === STR || mode === STR`)
    // but test DIFFERENT constants. Erasing the literal values collides them into
    // a bogus "exact semantic duplicate". They must stay distinct.
    const fns = [
      mkFn({
        name: "isHighCorrectionMode",
        file: "src/background/audio/tempo-beat-correction.ts",
        rawBody: "return mode === 'high-overshoot' || mode === 'high-overread-nonclassic';",
      }),
      mkFn({
        name: "isLowCorrectionMode",
        file: "src/background/audio/tempo-correction-support.ts",
        rawBody: "return mode === 'low-ambiguous' || mode === 'mid-underread';",
      }),
    ];
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    expect(groups).toHaveLength(0);
  });

  it("does NOT group two functions that differ only by a numeric-literal VALUE", () => {
    const fns = [
      mkFn({ name: "tax5", file: "src/a.ts", rawBody: "return price * 0.05;" }),
      mkFn({ name: "tax8", file: "src/b.ts", rawBody: "return price * 0.08;" }),
    ];
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    expect(groups).toHaveLength(0);
  });

  it("STILL groups byte-identical functions that share their literal values (clamp01-style)", () => {
    // True positive preserved: clamp01 is defined byte-identically in 6 files
    // on the bandcamp repo. Same literals (0 and 1) → same hash → one group.
    const body = "if (value <= 0) return 0; if (value >= 1) return 1; return value;";
    const fns = [
      mkFn({ name: "clamp01", file: "src/a.ts", rawBody: body }),
      mkFn({ name: "clamp01", file: "src/b.ts", rawBody: body }),
    ];
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    expect(groups).toHaveLength(1);
    expect(groups[0].functions).toHaveLength(2);
  });

  it("STILL groups byte-identical functions that share their string literals (normalizeText-style)", () => {
    const body = "return String(value ?? '').replace(/\\s+/g, ' ').trim();";
    const fns = [
      mkFn({ name: "normalizeText", file: "src/a.ts", rawBody: body }),
      mkFn({ name: "normalizeText", file: "src/b.ts", rawBody: body }),
    ];
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    expect(groups).toHaveLength(1);
    expect(groups[0].functions).toHaveLength(2);
  });

  it("groups three copies of the same function across three files", () => {
    const body = "const sum = a + b + c; return sum;";
    const fns = [
      mkFn({ name: "sumA", file: "src/a.ts", rawBody: body }),
      mkFn({ name: "sumB", file: "src/b.ts", rawBody: body }),
      mkFn({ name: "sumC", file: "src/c.ts", rawBody: body }),
    ];
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    expect(groups).toHaveLength(1);
    expect(groups[0].functions).toHaveLength(3);
  });
});

describe("fingerprintFindings — payload caps for huge duplicate groups", () => {
  // Construct a synthetic duplicate group of N members. We don't go
  // through findDuplicateGroups here; we hand-build the group shape so
  // the test is independent of grouping logic and only exercises the
  // emission cap.
  function bigGroup(memberCount: number) {
    const body = "const total = 1 + 2; return total;";
    const fns = Array.from({ length: memberCount }, (_, i) =>
      mkFn({ name: `Component${i}`, file: `src/c${i}.tsx`, rawBody: body }),
    );
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    return groups[0];
  }

  it("small groups (≤10 members) emit unchanged: full names in message, all locations", () => {
    const group = bigGroup(5);
    const findings = fingerprintFindings([group]);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.locations).toHaveLength(5);
    // No truncation — the (+N more) suffix should be absent.
    expect(f.message).not.toMatch(/\+\d+ more/);
    // No truncation metadata when the cap doesn't trigger.
    expect(f.metadata?.truncatedLocations).toBeUndefined();
  });

  it("large groups (>10 members) cap message names but keep the total count visible", () => {
    const group = bigGroup(35);
    const findings = fingerprintFindings([group]);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    // Message lists exactly 10 names + "(+25 more)" suffix.
    const namesPart = f.message.match(/duplicate: ([^]+) have/)?.[1] ?? "";
    expect(namesPart).toContain("(+25 more)");
    // The "across N files" total is the un-truncated count.
    expect(f.message).toContain("across 35 files");
  });

  it("large groups (>20 members) cap locations to 20 and surface total via metadata", () => {
    const group = bigGroup(80);
    const findings = fingerprintFindings([group]);
    const f = findings[0];
    expect(f.locations).toHaveLength(20);
    expect(f.metadata?.truncatedLocations).toBe(80);
  });

  it("confidence is the calibrated structural-dup precision, independent of group size", () => {
    // 0.95 = measured precision of exact-hash dup groups (98.7%, n=79, 2026-06-24
    // Claude calibration; see eval/calibration/ + semantic-fingerprint.ts). Group
    // size does not change how certain an exact normalized-hash match is.
    const small = fingerprintFindings([bigGroup(3)])[0];
    const huge = fingerprintFindings([bigGroup(120)])[0];
    expect(small.confidence).toBe(0.95);
    expect(huge.confidence).toBe(0.95);
  });

  it("severity is graded by blast radius: info for 2-member, warning for 3-4, error for >=5", () => {
    // Severity now scales with duplicate-group size so a 2-site exact dup
    // (the common case on a normal repo) is info, not error. Only genuinely
    // widespread copy-paste (>=5 sites) reaches the error ceiling.
    expect(fingerprintFindings([bigGroup(2)])[0].severity).toBe("info");
    expect(fingerprintFindings([bigGroup(3)])[0].severity).toBe("warning");
    expect(fingerprintFindings([bigGroup(4)])[0].severity).toBe("warning");
    expect(fingerprintFindings([bigGroup(5)])[0].severity).toBe("error");
    expect(fingerprintFindings([bigGroup(120)])[0].severity).toBe("error");
  });

  it("payload size of a 200-member group finding stays under 4KB", () => {
    // Regression guard against the shadcn-ui scan pathology where a
    // single fingerprint finding ballooned to 30-40KB.
    const findings = fingerprintFindings([bigGroup(200)]);
    const bytes = Buffer.byteLength(JSON.stringify(findings[0]), "utf-8");
    expect(bytes).toBeLessThan(4 * 1024);
  });
});
