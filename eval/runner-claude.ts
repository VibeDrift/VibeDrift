import Anthropic from "@anthropic-ai/sdk";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBaseline } from "../src/core/baseline.js";
import { run as runGetIntentHints } from "../src/mcp/tools/get-intent-hints.js";
import { run as runGetDominantPattern, DIMENSIONS } from "../src/mcp/tools/get-dominant-pattern.js";
import { run as runCheckFileDrift } from "../src/mcp/tools/check-file-drift.js";
import { run as runFindSimilarFunction } from "../src/mcp/tools/find-similar-function.js";
import { run as runValidateChange } from "../src/mcp/tools/validate-change.js";
import type { AgentRunner, Artifact, EvalTask, RepoContext, Treatment } from "./types.js";

// Default to the most capable model (claude-api skill default); override via
// EVAL_MODEL to swap models / control cost without changing code.
export const DEFAULT_EVAL_MODEL = process.env.EVAL_MODEL || "claude-opus-4-8";
const MAX_TOKENS = 4000; // one function — far below the streaming threshold
const DEFAULT_SAMPLE_FILES = 3; // existing files shown as raw context (BOTH arms)
const DEFAULT_MAX_TOOL_TURNS = 8; // bound the tool-use loop (cost ceiling per task)

// A response content block — text, or a tool_use request from the model.
interface RespBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

// Minimal surface of the Anthropic client we use — lets tests inject a fake
// without a network call or module mock (DI over vi.mock).
export interface MessagesClient {
  messages: {
    create(params: unknown): Promise<{ content: RespBlock[]; stop_reason?: string }>;
  };
}

/** A tool the agent can call in-loop. rootDir is injected by the harness, not
 *  the model, so the schemas below omit it. */
export type ToolFn = (args: Record<string, unknown>) => Promise<unknown>;
export const DEFAULT_TOOLS: Record<string, ToolFn> = {
  get_intent_hints: runGetIntentHints as ToolFn,
  get_dominant_pattern: runGetDominantPattern as ToolFn,
  check_file_drift: runCheckFileDrift as ToolFn,
  find_similar_function: runFindSimilarFunction as ToolFn,
  validate_change: runValidateChange as ToolFn,
};

/** Anthropic tool schemas mirroring the five MCP tools. rootDir is omitted on
 *  purpose — the harness fills it from ctx.rootDir before dispatch, exactly as
 *  the real MCP server fills it from the agent's working dir. */
export const TOOL_DEFS = [
  {
    name: "get_dominant_pattern",
    description:
      "How does this repo predominantly do X (async style, imports, exports, naming, error handling, data access, logging, auth)? Returns the majority convention and how consistent it is. Call this before writing to match the house style.",
    input_schema: {
      type: "object",
      properties: { dimension: { type: "string", enum: DIMENSIONS } },
      required: ["dimension"],
    },
  },
  {
    name: "find_similar_function",
    description:
      "Before writing a function, check whether the repo already has one that does the same thing, so you reuse or extend it instead of writing a duplicate. Pass the body you are about to write; returns matching functions with file, name, and similarity.",
    input_schema: {
      type: "object",
      properties: { body: { type: "string", description: "The function body you are about to write" } },
      required: ["body"],
    },
  },
  {
    name: "validate_change",
    description:
      "Validate a proposed file/function against the repo's conventions before committing it. Returns conflicts (with fix hints), any near-duplicates, and reference files to imitate.",
    input_schema: {
      type: "object",
      properties: {
        targetPath: { type: "string", description: "Path of the file being written" },
        body: { type: "string", description: "The proposed file contents" },
      },
      required: ["targetPath", "body"],
    },
  },
  {
    name: "check_file_drift",
    description: "Does an existing file deviate from the repo's dominant conventions? Returns per-dimension deviations with fix hints.",
    input_schema: {
      type: "object",
      properties: { filePath: { type: "string", description: "Path of an existing file to check" } },
      required: ["filePath"],
    },
  },
  {
    name: "get_intent_hints",
    description: "Return the conventions the repo explicitly declared in CLAUDE.md / .cursorrules / AGENTS.md, so you honor them.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export class ClaudeAgentRunner implements AgentRunner {
  private client: MessagesClient;
  private model: string;
  private sampleCap: number;
  private tools: Record<string, ToolFn>;
  private maxToolTurns: number;

  constructor(
    opts: {
      client?: MessagesClient;
      model?: string;
      sampleCap?: number;
      tools?: Record<string, ToolFn>;
      maxToolTurns?: number;
    } = {},
  ) {
    this.client = opts.client ?? (new Anthropic() as unknown as MessagesClient);
    this.model = opts.model ?? DEFAULT_EVAL_MODEL;
    // How many existing repo files to show BOTH arms as raw context. Set 0 to
    // strip the raw-file confound so the only difference between arms is
    // VibeDrift's distilled guidance (the discriminating experiment).
    this.sampleCap = opts.sampleCap ?? DEFAULT_SAMPLE_FILES;
    this.tools = opts.tools ?? DEFAULT_TOOLS;
    this.maxToolTurns = opts.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
  }

  async run(ctx: RepoContext, task: EvalTask, treatment: Treatment): Promise<Artifact[]> {
    if (treatment === "tools") return this.runWithTools(ctx, task);

    const sample = await sampleRepoFiles(ctx.rootDir, task.targetPath, this.sampleCap);
    const system = buildSystemPrompt(sample, treatment === "none" ? undefined : ctx.guidance);
    const user = `Task: ${task.prompt}\nCreate the file at: ${task.targetPath}`;

    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    });

    return [{ path: task.targetPath, body: extractCode(textOf(resp.content)) }];
  }

  /**
   * The "tools" arm: the agent gets the SAME raw sample as the other arms, but
   * instead of VibeDrift's distilled guidance pasted in, it gets live in-loop
   * MCP tools it can call (get_dominant_pattern, find_similar_function, …). We
   * run a real tool-use loop, executing each requested tool against the engine
   * with rootDir injected, until the model returns the file or we hit the turn
   * cap (after which one final no-tools call forces the answer).
   */
  private async runWithTools(ctx: RepoContext, task: EvalTask): Promise<Artifact[]> {
    const sample = await sampleRepoFiles(ctx.rootDir, task.targetPath, this.sampleCap);
    const system = buildToolsSystemPrompt(sample);
    const messages: Array<{ role: string; content: unknown }> = [
      { role: "user", content: `Task: ${task.prompt}\nCreate the file at: ${task.targetPath}` },
    ];

    for (let turn = 0; turn < this.maxToolTurns; turn++) {
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system,
        tools: TOOL_DEFS,
        messages,
      });
      messages.push({ role: "assistant", content: resp.content });
      const toolUses = (resp.content ?? []).filter((b) => b.type === "tool_use");
      if (toolUses.length === 0) {
        return [{ path: task.targetPath, body: extractCode(textOf(resp.content)) }];
      }
      const results = [];
      for (const tu of toolUses) {
        const out = await this.execTool(tu.name ?? "", { ...(tu.input ?? {}), rootDir: ctx.rootDir });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
    }

    // Turn budget exhausted — force a final answer with no tools available.
    const final = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [...messages, { role: "user", content: "Now output ONLY the complete file contents in a single fenced code block." }],
    });
    return [{ path: task.targetPath, body: extractCode(textOf(final.content)) }];
  }

  private async execTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const fn = this.tools[name];
    if (!fn) return { error: `unknown tool: ${name}` };
    try {
      return await fn(args);
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) };
    }
  }
}

/** Concatenate the text blocks of a model response. */
function textOf(content: RespBlock[] | undefined): string {
  return (content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** System prompt for the tools arm: same task framing + raw sample as the other
 *  arms, plus an instruction to consult the VibeDrift tools BEFORE writing. No
 *  distilled guidance — the tools are the treatment. */
function buildToolsSystemPrompt(sample: Array<{ path: string; body: string }>): string {
  const lines = [
    "You are adding a new source file to an existing TypeScript repository.",
    "Match the repository's existing conventions and style.",
    "You have VibeDrift tools that read this repository's established conventions.",
    "Before writing, consult them: call get_dominant_pattern for the relevant dimensions,",
    "and call find_similar_function with the body you intend to write to avoid duplicating",
    "an existing function. You may call validate_change on your draft before finalizing.",
    "When done, output ONLY the complete contents of the new file in a single fenced code block (```). No explanation.",
  ];
  if (sample.length) {
    lines.push("", "Existing files in the repo (for reference):", ...sample.map((f) => `\n--- ${f.path} ---\n${f.body}`));
  }
  return lines.join("\n");
}

/** Both arms see a raw sample of the repo (a real agent can read files); the
 *  treatment arm additionally gets VibeDrift's DISTILLED guidance. So the delta
 *  isolates "did the distilled signal help beyond raw file access". */
function buildSystemPrompt(
  sample: Array<{ path: string; body: string }>,
  guidance: RepoContext["guidance"],
): string {
  const lines = [
    "You are adding a new source file to an existing TypeScript repository.",
    "Match the repository's existing conventions and style.",
    "Output ONLY the complete contents of the new file, in a single fenced code block (```). No explanation, no preamble, no reasoning.",
  ];
  if (sample.length) {
    lines.push("", "Existing files in the repo (for reference):", ...sample.map((f) => `\n--- ${f.path} ---\n${f.body}`));
  }
  if (guidance) {
    const pats = Object.entries(guidance.dominantPatterns).map(([k, v]) => `${k}=${v}`).join(", ");
    lines.push(
      "",
      "The repository's established conventions, detected by VibeDrift — follow them exactly:",
      pats ? `- Dominant patterns: ${pats}` : "",
      ...guidance.declaredRules.map((r) => `- ${r}`),
    );
  }
  return lines.filter(Boolean).join("\n");
}

/** First fenced code block, or the trimmed text if the model didn't fence it. */
export function extractCode(text: string): string {
  const m = text.match(/```(?:[a-zA-Z]+)?\n([\s\S]*?)```/);
  return (m ? m[1] : text).trim() + "\n";
}

async function sampleRepoFiles(rootDir: string, exclude: string, cap: number): Promise<Array<{ path: string; body: string }>> {
  if (cap <= 0) return [];
  let names: string[];
  try {
    names = await readdir(rootDir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; body: string }> = [];
  for (const name of names.sort()) {
    if (out.length >= cap) break;
    if (name === exclude || !/\.[tj]sx?$/.test(name)) continue;
    try {
      out.push({ path: name, body: await readFile(join(rootDir, name), "utf8") });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** Derive VibeDrift's guidance for a repo: dominant detector votes + the
 *  declared intent-hint rules. A full scan (3–8s) — memoize per rootDir in the
 *  caller if running many tasks against one repo. */
export async function buildGuidance(rootDir: string): Promise<RepoContext["guidance"]> {
  const baseline = await buildBaseline(rootDir);
  const dominantPatterns: Record<string, string> = {};
  for (const [cat, vote] of Object.entries(baseline.perCategoryVote)) {
    if (vote) dominantPatterns[cat] = vote.dominantPattern;
  }
  const declaredRules = baseline.intentHints
    .map((h) => h.text.replace(/^[-*\s]+/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
  return { dominantPatterns, declaredRules };
}
