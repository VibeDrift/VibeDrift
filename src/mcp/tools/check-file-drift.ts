/**
 * check_file_drift — MCP adapter.
 *
 * Channel-neutral logic (run + fileDriftFromBaseline + types) lives in
 * src/tools-core/tools/check-file-drift.ts and is re-exported here. This file only
 * registers the tool on an MCP server.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, inputSchema } from "../../tools-core/tools/check-file-drift.js";
import { finalizeMcpResult } from "../nudge.js";

export * from "../../tools-core/tools/check-file-drift.js";

export const registerCheckFileDrift = {
  run,
  register(server: McpServer): void {
    server.registerTool(
      "check_file_drift",
      {
        title: "Check a file for drift",
        description:
          "Before editing or after writing a file, check whether it matches this repo's established patterns. Returns fits=true/false plus each deviation (the file's pattern vs the repo's dominant, with a fix hint citing an example file). Local; needs a prior `vibedrift scan`.",
        inputSchema,
      },
      // Write-time tool: may carry the deep-scan nudge.
      async (args) => finalizeMcpResult(await run(args), { nudge: true }),
    );
  },
};
