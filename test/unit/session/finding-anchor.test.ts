import { describe, it, expect } from "vitest";
import { signalPresent } from "@/session/finding-anchor";

describe("signalPresent — file-kind redundancy anchors", () => {
  // `if (anchor.kind !== "function") return true;` made a file-anchored
  // redundancy finding report "still present" for every possible file content,
  // including an empty file, so it could never be resolved by any edit.
  const anchor = {
    kind: "file" as const,
    tokenHash: "abc",
    tokens: ["const", "widgetTotal", "=", "compute", "(", ")", ";"],
    observed: "src/other.ts:10",
  };
  const emptyBaseline = {
    key: "k",
    rootDir: "/r",
    ctxFiles: [],
    perCategoryVote: {},
    perDirectoryVote: {},
    intentHints: [],
    minhashIndex: [],
    builtAt: 0,
  } as unknown as Parameters<typeof signalPresent>[4];

  const present = (body: string) => signalPresent("redundancy", anchor, body, "src/a.ts", emptyBaseline);

  it("stays open while the flagged tokens are still there", () => {
    expect(present("const widgetTotal = compute();")).toBe(true);
  });

  it("clears once the flagged construct is gone", () => {
    expect(present("export function unrelated() { return 42; }")).toBe(false);
  });

  it("clears on an empty file", () => {
    expect(present("")).toBe(false);
  });
});
