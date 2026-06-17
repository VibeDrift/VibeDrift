import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentRunner, extractCode, type MessagesClient } from "../../eval/runner-claude.js";
import type { EvalTask, RepoContext } from "../../eval/types.js";

/** Fake Anthropic client: records the params it was called with, returns canned code. */
function fakeClient(replyCode: string): { client: MessagesClient; calls: any[] } {
  const calls: any[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params: any) {
        calls.push(params);
        return { content: [{ type: "text", text: "Here you go:\n```ts\n" + replyCode + "\n```" }] };
      },
    },
  };
  return { client, calls };
}

const task: EvalTask = { id: "t1", repo: "r", targetPath: "thing.ts", prompt: "add a thing" };

describe("ClaudeAgentRunner", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "vd-runner-"));
    writeFileSync(join(repo, "existing.ts"), "export async function a(){ return await x(); }\n");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const ctx: RepoContext = {
    rootDir: "", // set per test
    guidance: { dominantPatterns: { async_patterns: "async/await" }, declaredRules: ["Async: use async/await throughout"] },
  };

  it("'context' injects VibeDrift guidance into the system prompt", async () => {
    const { client, calls } = fakeClient("export async function f(){}");
    const runner = new ClaudeAgentRunner({ client, model: "test-model" });
    await runner.run({ ...ctx, rootDir: repo }, task, "context");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("test-model");
    expect(calls[0].system).toMatch(/detected by VibeDrift/);
    expect(calls[0].system).toMatch(/async\/await/);
  });

  it("'none' does NOT inject guidance (but still sees the raw repo sample)", async () => {
    const { client, calls } = fakeClient("export async function f(){}");
    const runner = new ClaudeAgentRunner({ client });
    await runner.run({ ...ctx, rootDir: repo }, task, "none");
    expect(calls[0].system).not.toMatch(/detected by VibeDrift/);
    expect(calls[0].system).toMatch(/existing\.ts/); // raw file sample present in both arms
  });

  it("sampleCap:0 strips the raw file sample (only guidance differs between arms)", async () => {
    const { client, calls } = fakeClient("export function f(){}");
    const runner = new ClaudeAgentRunner({ client, sampleCap: 0 });
    await runner.run({ ...ctx, rootDir: repo }, task, "none");
    expect(calls[0].system).not.toMatch(/existing\.ts/);
    expect(calls[0].system).not.toMatch(/Existing files/);
  });

  it("parses the fenced code block out of the response", async () => {
    const { client } = fakeClient("export const x = 1;");
    const runner = new ClaudeAgentRunner({ client });
    const [artifact] = await runner.run({ ...ctx, rootDir: repo }, task, "none");
    expect(artifact.path).toBe("thing.ts");
    expect(artifact.body.trim()).toBe("export const x = 1;");
    expect(artifact.body).not.toMatch(/Here you go/); // preamble stripped
  });
});

describe("extractCode", () => {
  it("pulls the first fenced block", () => {
    expect(extractCode("blah\n```ts\nconst a=1;\n```\ntrailing")).toBe("const a=1;\n");
  });
  it("falls back to trimmed text when unfenced", () => {
    expect(extractCode("  const a=1;  ")).toBe("const a=1;\n");
  });
});
