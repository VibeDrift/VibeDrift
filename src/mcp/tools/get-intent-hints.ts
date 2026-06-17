/**
 * get_intent_hints — the team's explicitly declared conventions.
 *
 * Standalone (no baseline needed): parses CLAUDE.md / AGENTS.md / .cursorrules
 * via the existing intent parser and projects each hint into an agent-friendly
 * shape. Confidence is dropped (the agent shouldn't threshold) and each hint is
 * marked `binding: true` — declarations are the team's ground truth and
 * override inferred patterns.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseIntentFiles } from "../../intent/parser.js";
import { toToolResult } from "../envelope.js";

const inputSchema = {
  rootDir: z.string().describe("Absolute path to the repository root"),
};

export interface IntentHintOut {
  dimension: string; // IntentHint.category (a drift dimension)
  pattern: string;
  label: string;
  source: string;
  line: number;
  text: string;
  binding: true;
}

export async function run({ rootDir }: { rootDir: string }): Promise<{
  status: "ok";
  hints: IntentHintOut[];
}> {
  const result = await parseIntentFiles(rootDir);
  const hints: IntentHintOut[] = result.hints.map((h) => ({
    dimension: h.category,
    pattern: h.pattern,
    label: h.label,
    source: h.source,
    line: h.line,
    text: h.text,
    binding: true,
  }));
  return { status: "ok", hints };
}

export const registerGetIntentHints = {
  run,
  register(server: McpServer): void {
    server.registerTool(
      "get_intent_hints",
      {
        title: "Get declared intent hints",
        description:
          "Read the team's explicitly declared conventions from CLAUDE.md, AGENTS.md, and .cursorrules for this repo. Returns each declared rule with its source file and line. Call this at the start of a task — these declarations are the team's ground truth and override inferred patterns. Reads local files only; no network.",
        inputSchema,
      },
      async (args) => toToolResult(await run(args)),
    );
  },
};
