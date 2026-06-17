import { describe, it, expect } from "vitest";
import { StubRunner } from "../../eval/runner-stub.js";
import type { EvalTask, RepoContext } from "../../eval/types.js";

const ctx: RepoContext = { rootDir: "/tmp/x" };
const task: EvalTask = { id: "t1", repo: "async-await-repo", targetPath: "thing.ts", prompt: "add a thing" };

describe("StubRunner", () => {
  const runner = new StubRunner();

  it("produces DRIFTING code under treatment 'none' (a .then() chain)", async () => {
    const [a] = await runner.run(ctx, task, "none");
    expect(a.path).toBe("thing.ts");
    expect(a.body).toContain(".then(");
    expect(a.body).not.toContain("await ");
  });

  it("produces CONFORMING code under treatment 'context' (async/await)", async () => {
    const [a] = await runner.run(ctx, task, "context");
    expect(a.path).toBe("thing.ts");
    expect(a.body).toContain("await ");
    expect(a.body).not.toContain(".then(");
  });

  it("is deterministic — same inputs, same output", async () => {
    const a = await runner.run(ctx, task, "none");
    const b = await runner.run(ctx, task, "none");
    expect(a).toEqual(b);
  });
});
