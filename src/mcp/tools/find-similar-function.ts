/**
 * find_similar_function — MCP adapter.
 *
 * Channel-neutral logic (run + types) lives in
 * src/tools-core/tools/find-similar-function.ts and is re-exported here. This file
 * only registers the tool on an MCP server.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, inputSchema } from "../../tools-core/tools/find-similar-function.js";
import { finalizeMcpResult } from "../nudge.js";
import { teeFindSimilar } from "../session-tee.js";

export * from "../../tools-core/tools/find-similar-function.js";

export const registerFindSimilarFunction = {
  run,
  register(server: McpServer): void {
    server.registerTool(
      "find_similar_function",
      {
        title: "Find a similar existing function",
        description:
          "Before writing a new function, check whether this repo already has one that does the same thing — so you extend or reuse it instead of writing a duplicate. Returns matching functions with their file, name, line, and similarity. Local; needs a prior `vibedrift scan`.",
        inputSchema,
      },
      // A successful deep pass resets the nudge clock; the nudge itself rides on
      // the write-time tools (validate_change / check_file_drift).
      async (args) => {
        const out = await run(args);
        void teeFindSimilar(args, out); // fire-and-forget; never slows the tool
        return finalizeMcpResult(out, { nudge: false });
      },
    );
  },
};
