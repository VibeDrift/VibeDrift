/**
 * get_dominant_pattern — MCP adapter.
 *
 * Channel-neutral logic (run + dominantPatternFor + types) lives in
 * src/tools-core/tools/get-dominant-pattern.ts and is re-exported here. This file
 * only registers the tool on an MCP server.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, inputSchema } from "../../tools-core/tools/get-dominant-pattern.js";
import { toToolResult } from "../envelope.js";

export * from "../../tools-core/tools/get-dominant-pattern.js";

export const registerGetDominantPattern = {
  run,
  register(server: McpServer): void {
    server.registerTool(
      "get_dominant_pattern",
      {
        title: "Get the repo's dominant pattern",
        description:
          "Ask what THIS repo's convention is for a dimension (error_handling, imports, exports, async, naming, data_access, logging, auth) before writing new code. Returns the majority pattern, how consistent the repo is, and up to 3 example files to copy. Local; needs a prior `vibedrift scan` to build the baseline.",
        inputSchema,
      },
      async (args) => toToolResult(await run(args)),
    );
  },
};
