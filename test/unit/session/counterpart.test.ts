import { describe, it, expect } from "vitest";
import { verifyCounterpart } from "@/session/counterpart";

// The measured case. The agent MOVED `el` out of composer.ts into
// shared/dom.ts. The duplicate match was correct — same function, 42 tokens —
// but by flag time the original was gone, so "prefer importing it" pointed at
// nothing. A move is not a duplication.
const COMPOSER_AFTER_MOVE = `
export interface ComposerOptions {
  onSave(body: string): void;
  onCancel(): void;
}

function toLocalInputValue(ts: number): string {
  const shifted = new Date(ts - 60000);
  return shifted.toISOString().slice(0, 16);
}
`;

const COMPOSER_BEFORE_MOVE = `
function el(tag: string, cls?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  return node;
}

function toLocalInputValue(ts: number): string {
  const shifted = new Date(ts - 60000);
  return shifted.toISOString().slice(0, 16);
}
`;

const args = (over: Record<string, unknown> = {}) => ({
  name: "el",
  relativePath: "src/content/composer.ts",
  line: 2,
  fileContent: COMPOSER_BEFORE_MOVE,
  language: "typescript" as const,
  ...over,
});

describe("verifyCounterpart", () => {
  it("confirms a counterpart still sitting at the indexed line", () => {
    expect(verifyCounterpart(args())).toEqual({ status: "confirmed", line: 2 });
  });

  it("reports gone when the agent moved the function out", () => {
    expect(verifyCounterpart(args({ fileContent: COMPOSER_AFTER_MOVE }))).toEqual({ status: "gone" });
  });

  it("re-resolves the line when the function is still there but shifted", () => {
    const shifted = `// a new leading comment\n// and another\n${COMPOSER_BEFORE_MOVE}`;
    const res = verifyCounterpart(args({ fileContent: shifted }));
    expect(res.status).toBe("moved");
    expect(res).toHaveProperty("line", 4);
  });

  it("fails open to confirmed when the file cannot be read", () => {
    // A read error must not silently disable duplicate detection.
    expect(verifyCounterpart(args({ fileContent: null }))).toEqual({ status: "confirmed", line: 2 });
  });

  it("fails open for a language the extractor does not parse", () => {
    expect(verifyCounterpart(args({ language: null }))).toEqual({ status: "confirmed", line: 2 });
  });
});
