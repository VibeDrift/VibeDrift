import { describe, it, expect } from "vitest";
import {
  extractFunctionsFromFile,
  extractAllFunctions,
} from "../../../src/codedna/function-extractor.js";
import {
  computeSemanticFingerprints,
  findDuplicateGroups,
} from "../../../src/codedna/semantic-fingerprint.js";
import type { SourceFile, SupportedLanguage } from "../../../src/core/types.js";

function mkFile(
  content: string,
  language: SupportedLanguage = "typescript",
  relativePath = "src/x.ts",
): SourceFile {
  return {
    path: `/abs/${relativePath}`,
    relativePath,
    language,
    content,
    lineCount: content.split("\n").length,
  };
}

/**
 * Regression suite for the body-extraction bug behind Anishek Kamal's
 * 0.14.0 complaint on bandcamp-player-extension.
 *
 * Root cause: the TS `function` regex encoded the return type as
 * `(?::\s*[^{]*)?` before the body brace. `[^{]*` cannot span a return type
 * that itself contains `{` — e.g. `: { value: string; source: string }` —
 * so the FIRST `{` the regex matched as "the body brace" was actually the
 * return-type object's brace. extractBody then captured the return-type
 * annotation (~8 tokens) instead of the real ~50-line body. Every function
 * sharing a `{ value; source }` return shape collapsed to an identical
 * truncated body → identical hash → a false "exact semantic duplicate".
 */
describe("extractFunctionsFromFile — return types containing braces (Bug A)", () => {
  it("captures the real body, not the inline-object return-type annotation", () => {
    const src = `
export function readMutationCrumb(el: HTMLElement): { value: string; source: string } {
  const raw = el.getAttribute("data-crumb");
  if (!raw) {
    return { value: "", source: "missing" };
  }
  const decoded = decodeURIComponent(raw);
  const parsed = JSON.parse(decoded);
  return { value: parsed.crumb, source: "attribute" };
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find(
      (f) => f.name === "readMutationCrumb",
    );
    expect(fn).toBeDefined();
    // The body must contain the implementation, not the type annotation.
    expect(fn!.rawBody).toContain("getAttribute");
    expect(fn!.rawBody).toContain("decodeURIComponent");
    expect(fn!.rawBody).toContain("JSON.parse");
    // The return-type annotation alone is ~8 tokens; the real body is far more.
    expect(fn!.bodyTokenCount).toBeGreaterThan(20);
  });

  it("two functions sharing a return shape but with different bodies get different hashes", () => {
    // This is THE false-positive: before the fix both captured the identical
    // `{ value: string; source: string }` annotation → identical bodyHash →
    // reported as an exact duplicate that does not exist.
    const src = `
export function readMutationCrumb(el: HTMLElement): { value: string; source: string } {
  const raw = el.getAttribute("data-crumb");
  return { value: decodeURIComponent(raw ?? ""), source: "attribute" };
}
export function readTitleFromTrackRecord(rec: TrackRecord): { value: string; source: string } {
  const title = rec.current && rec.current.title;
  return { value: title ?? "", source: "trackRecord" };
}
`;
    const fns = extractFunctionsFromFile(mkFile(src));
    const a = fns.find((f) => f.name === "readMutationCrumb");
    const b = fns.find((f) => f.name === "readTitleFromTrackRecord");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.bodyHash).not.toBe(b!.bodyHash);
  });

  it("handles a Promise<{...}> return type", () => {
    const src = `
export async function readRootCrumb(doc: Document): Promise<{ value: string; source: string }> {
  const resp = await fetch("/api/crumb");
  const json = await resp.json();
  return { value: json.crumb, source: "fetch" };
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find(
      (f) => f.name === "readRootCrumb",
    );
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("fetch");
    expect(fn!.rawBody).toContain("resp.json");
  });

  it("handles a union return type with an inline object member", () => {
    const src = `
function classify(x: number): string | { tag: string } {
  logIt(x);
  return String(x);
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find(
      (f) => f.name === "classify",
    );
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("logIt");
    expect(fn!.rawBody).toContain("String");
  });

  it("handles a generic function with type parameters", () => {
    const src = `
function identity<T>(value: T): T {
  const copy = value;
  return copy;
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find(
      (f) => f.name === "identity",
    );
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("copy");
  });

  it("handles an arrow function with an inline-object return type", () => {
    const src = `
const buildPair = (k: string): { value: string; source: string } => {
  const v = lookup(k);
  return { value: v, source: "arrow" };
};
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find(
      (f) => f.name === "buildPair",
    );
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("lookup");
  });

  // ── Regression guards: the common cases must keep working ──

  it("still extracts a simple primitive return type", () => {
    const src = `
function add(a: number, b: number): number {
  const sum = a + b;
  return sum;
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find((f) => f.name === "add");
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("sum");
  });

  it("still extracts a function with no return type", () => {
    const src = `
function greet(name: string) {
  const msg = "hello " + name;
  return msg;
}
`;
    const fn = extractFunctionsFromFile(mkFile(src)).find((f) => f.name === "greet");
    expect(fn).toBeDefined();
    expect(fn!.rawBody).toContain("msg");
  });

  it("does not mis-extract overload signatures as tiny bodies", () => {
    const src = `
function parse(x: string): number;
function parse(x: number): string;
function parse(x: any): any {
  const result = transform(x);
  return result;
}
`;
    const parses = extractFunctionsFromFile(mkFile(src)).filter(
      (f) => f.name === "parse",
    );
    expect(parses.length).toBe(1);
    expect(parses[0].rawBody).toContain("transform");
  });
});

describe("extractor × fingerprint (regression: shared return shape ≠ duplicate)", () => {
  it("does not group two functions that only share a return-type annotation", () => {
    const fileA = mkFile(
      `
export function readMutationCrumb(el: HTMLElement): { value: string; source: string } {
  const raw = el.getAttribute("data-crumb");
  const decoded = decodeURIComponent(raw ?? "");
  return { value: decoded, source: "attribute" };
}
`,
      "typescript",
      "src/mutations.ts",
    );
    const fileB = mkFile(
      `
export function readTitleFromTrackRecord(rec: any): { value: string; source: string } {
  const title = rec && rec.current && rec.current.title;
  const trimmed = (title ?? "").trim();
  return { value: trimmed, source: "trackRecord" };
}
`,
      "typescript",
      "src/track-index.ts",
    );
    const fns = extractAllFunctions([fileA, fileB]);
    const fps = computeSemanticFingerprints(fns);
    const groups = findDuplicateGroups(fps, fns);
    // Different bodies → no exact-duplicate group. Before the fix both bodies
    // collapsed to `{ value: string; source: string }` → one false group.
    expect(groups.length).toBe(0);
  });
});
