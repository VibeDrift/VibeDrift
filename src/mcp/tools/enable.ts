/**
 * enable — MCP adapter.
 *
 * Channel-neutral logic (run + types) lives in
 * src/tools-core/tools/enable.ts. This adapter registers it on an MCP server
 * and, per O18, marks it `_meta["anthropic/requiresUserInteraction"]:true` so
 * Claude Code raises its native Allow/Deny prompt on EVERY call — the hard
 * consent gate for turning on capture in a repo.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, inputSchema } from "../../tools-core/tools/enable.js";
import { toToolResult } from "../envelope.js";

export * from "../../tools-core/tools/enable.js";

export const registerEnable = {
  run,
  register(server: McpServer): void {
    server.registerTool(
      "enable",
      {
        title: "Enable VibeDrift Drift Sessions for this repo",
        description:
          "Answer the VibeDrift activation nudge. To turn it ON, pass the user's explicit affirmative in `confirm` (this call raises an Allow/Deny prompt — the user must also approve it). To turn it OFF for this repo, pass decline:true. Records the answer in the machine-global activation store + a local consent receipt, and installs the Claude Code hooks on enable. Local; no network.",
        inputSchema,
        _meta: { "anthropic/requiresUserInteraction": true },
      },
      async (args) => toToolResult(await run(args)),
    );
  },
};
