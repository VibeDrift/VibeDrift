/**
 * get_intent_hints — MCP adapter.
 *
 * Channel-neutral logic (run + types) lives in
 * src/tools-core/tools/get-intent-hints.ts and is re-exported here for
 * back-compat. This file only registers the tool on an MCP server.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, inputSchema } from "../../tools-core/tools/get-intent-hints.js";
import { toToolResult } from "../envelope.js";

export * from "../../tools-core/tools/get-intent-hints.js";

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
