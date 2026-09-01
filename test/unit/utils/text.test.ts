import { describe, it, expect } from "vitest";
import { getLineNumber, densityPer1K } from "../../../src/utils/text.js";

// Reference implementation matching the original naive behavior:
// content.slice(0, index).split("\n").length. Used to cross-check the
// memoized/binary-search implementation stays byte-identical.
function naiveGetLineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

describe("getLineNumber", () => {
  it("returns 1 for index 0", () => {
    expect(getLineNumber("hello\nworld", 0)).toBe(1);
  });

  it("counts newlines before the index", () => {
    const content = "line1\nline2\nline3\nline4";
    // index of "line3" start
    const idx = content.indexOf("line3");
    expect(getLineNumber(content, idx)).toBe(3);
  });

  it("matches the naive slice+split implementation across many indices (regression: O(n^2) memoization correctness)", () => {
    const content = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`).join("\n");
    for (let i = 0; i < content.length; i += 37) {
      expect(getLineNumber(content, i)).toBe(naiveGetLineNumber(content, i));
    }
    // End-of-content edge case.
    expect(getLineNumber(content, content.length)).toBe(naiveGetLineNumber(content, content.length));
  });

  it("handles repeated calls against the SAME content object (the common per-file call pattern)", () => {
    const content = "a\nb\nc\nd\ne\n";
    // Simulate what analyzers do: many getLineNumber calls against the same
    // file.content string as a regex scans through it.
    expect(getLineNumber(content, 0)).toBe(1);
    expect(getLineNumber(content, 2)).toBe(2);
    expect(getLineNumber(content, 4)).toBe(3);
    expect(getLineNumber(content, 6)).toBe(4);
    expect(getLineNumber(content, 8)).toBe(5);
  });

  it("handles repeated calls against DIFFERENT content strings without leaking stale offsets", () => {
    const a = "a\nb\nc";
    const b = "x\ny\nz\nw";
    expect(getLineNumber(a, 2)).toBe(2);
    expect(getLineNumber(b, 4)).toBe(3);
    // Back to `a` — must not reuse `b`'s cached offsets.
    expect(getLineNumber(a, 2)).toBe(2);
    expect(getLineNumber(a, 4)).toBe(3);
  });

  it("handles empty content", () => {
    expect(getLineNumber("", 0)).toBe(1);
  });
});

describe("densityPer1K", () => {
  it("returns 0 for zero total lines", () => {
    expect(densityPer1K(5, 0)).toBe(0);
  });

  it("computes density scaled per 1000 lines", () => {
    expect(densityPer1K(10, 1000)).toBe(10);
    expect(densityPer1K(1, 100)).toBe(10);
  });
});
