import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentRunner, type MessagesClient } from "../../eval/runner-claude.js";
import type { EvalTask, RepoContext } from "../../eval/types.js";

type Resp = { content: Array<Record<string, unknown>>; stop_reason?: string };

/** Flexible fake: `respond(params, callIndex)` decides each reply; records calls. */
function fakeClient(respond: (params: any, i: number) => Resp): { client: MessagesClient; calls: any[] } {
  const calls: any[] = [];
  let i = 0;
  const client = {
    messages: {
      async create(params: any) {
        calls.push(params);
        return respond(params, i++);
      },
    },
  } as unknown as MessagesClient;
  return { client, calls };
}

const toolUse = (name: string, input: Record<string, unknown>): Resp => ({
  content: [{ type: "tool_use", id: "tu_" + name, name, input }],
  stop_reason: "tool_use",
});
const sayCode = (code: string): Resp => ({
  content: [{ type: "text", text: "```ts\n" + code + "\n```" }],
  stop_reason: "end_turn",
});

const task: EvalTask = { id: "t1", repo: "r", targetPath: "subscriptions.ts", prompt: "add a fetch service" };

describe("ClaudeAgentRunner — tools treatment (in-loop MCP tool use)", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "vd-tools-"));
    writeFileSync(join(repo, "existing.ts"), "export function a(){ return q().then(r=>r); }\n");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const ctx: RepoContext = { rootDir: "" };

  it("runs the loop: executes the requested tool with injected rootDir, feeds the result back, returns final code", async () => {
    const toolCalls: any[] = [];
    const tools = {
      find_similar_function: async (args: any) => {
        toolCalls.push(args);
        return { found: true, matches: [{ name: "getPayment", file: "payments.ts", similarity: 0.9 }] };
      },
    };
    const { client, calls } = fakeClient((_p, i) =>
      i === 0
        ? toolUse("find_similar_function", { body: "function getSubscription(id){}" })
        : sayCode("export function getSubscription(id){ return db.find(id); }"),
    );
    const runner = new ClaudeAgentRunner({ client, model: "test", sampleCap: 0, tools });
    const [artifact] = await runner.run({ ...ctx, rootDir: repo }, task, "tools");

    // tool executed once, with rootDir injected by the harness + model-supplied body
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].rootDir).toBe(repo);
    expect(toolCalls[0].body).toBe("function getSubscription(id){}");
    // second model call carried a tool_result back
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].messages)).toContain("tool_result");
    // tools advertised on the first (tool-enabled) call
    expect(calls[0].tools.map((t: any) => t.name)).toContain("find_similar_function");
    // final code extracted
    expect(artifact.path).toBe("subscriptions.ts");
    expect(artifact.body).toContain("getSubscription");
  });

  it("advertises the five vibedrift tools and hides rootDir from their schema (harness injects it)", async () => {
    const { calls, client } = fakeClient(() => sayCode("export const x = 1;"));
    const runner = new ClaudeAgentRunner({ client, sampleCap: 0 }); // default = real handlers
    await runner.run({ ...ctx, rootDir: repo }, task, "tools");
    const names = calls[0].tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_dominant_pattern",
        "check_file_drift",
        "find_similar_function",
        "validate_change",
        "get_intent_hints",
      ]),
    );
    const fsf = calls[0].tools.find((t: any) => t.name === "find_similar_function");
    expect(Object.keys(fsf.input_schema.properties)).not.toContain("rootDir");
    expect(fsf.input_schema.properties).toHaveProperty("body");
  });

  it("bounds cost: after maxToolTurns it forces a final no-tools call and returns its code", async () => {
    const tools = { get_intent_hints: async () => ({ status: "ok", hints: [] }) };
    // Tool-enabled calls keep asking for a tool; the forced final call (no tools) returns code.
    const { client, calls } = fakeClient((p) =>
      p.tools ? toolUse("get_intent_hints", {}) : sayCode("export const done = 1;"),
    );
    const runner = new ClaudeAgentRunner({ client, sampleCap: 0, tools, maxToolTurns: 3 });
    const [artifact] = await runner.run({ ...ctx, rootDir: repo }, task, "tools");
    // 3 tool-enabled turns + 1 forced final = 4 calls
    expect(calls).toHaveLength(4);
    expect(calls[3].tools).toBeUndefined();
    expect(artifact.body).toContain("done");
  });
});
