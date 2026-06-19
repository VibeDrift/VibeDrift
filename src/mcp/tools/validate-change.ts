/**
 * validate_change — MCP adapter.
 *
 * Channel-neutral logic (run + validateChange + types) lives in
 * src/tools-core/tools/validate-change.ts and is re-exported here. This file only
 * registers the tool on an MCP server.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, inputSchema } from "../../tools-core/tools/validate-change.js";
import { finalizeMcpResult } from "../nudge.js";

export * from "../../tools-core/tools/validate-change.js";

export const registerValidateChange = {
  run,
  register(server: McpServer): void {
    server.registerTool(
      "validate_change",
      {
        title: "Validate a proposed change",
        description:
          "After proposing or writing a function, validate it against the repo's patterns before committing. Returns ok=true/false plus any new drift the change would introduce (with fix hints + reference files) and any existing function it would duplicate. Local; needs a prior `vibedrift scan`.",
        inputSchema,
      },
      // Write-time tool: may carry the deep-scan nudge; a successful deep pass
      // resets the nudge clock.
      async (args) => finalizeMcpResult(await run(args), { nudge: true }),
    );
  },
};
