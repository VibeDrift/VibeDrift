#!/usr/bin/env node
/**
 * @vibedrift/mcp — local stdio MCP server.
 *
 * Exposes VibeDrift's drift / Code-DNA / intent engines as in-loop agent tools
 * so a coding agent can consult the repo's own conventions WHILE it writes,
 * turning drift detection into drift prevention. Local-only and FREE for
 * everyone: the tools run on the user's machine and send zero bytes. (Opt-in
 * `deep: true` checks are metered server-side inside the individual tools.)
 *
 * stdout is the JSON-RPC channel — all logging MUST go to stderr or it
 * corrupts the protocol framing.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetIntentHints } from "./tools/get-intent-hints.js";
import { registerGetDominantPattern } from "./tools/get-dominant-pattern.js";
import { registerCheckFileDrift } from "./tools/check-file-drift.js";
import { registerFindSimilarFunction } from "./tools/find-similar-function.js";
import { registerValidateChange } from "./tools/validate-change.js";

const SERVER_INSTRUCTIONS = `VibeDrift detects drift in AI-generated code — where new code diverges from the patterns the rest of the codebase already follows.

These in-loop tools are LOCAL and FREE — call them while writing code:
- get_dominant_pattern: the codebase's dominant pattern for a category (so new code matches it).
- get_intent_hints: team-declared conventions from CLAUDE.md / AGENTS.md / .cursorrules.
- check_file_drift: whether a file diverges from the dominant patterns.
- find_similar_function: existing near-duplicates of a function you're about to write (avoid re-implementing).
- validate_change: pre-commit drift check on an edit.

For a deeper, AI-validated pass on a CHANGE SET (before committing or opening a PR), have the user run the CLI:
- \`vibedrift --deep --diff\`        deep-scan ONLY the files changed vs HEAD (fast, scoped).
- \`vibedrift --deep --diff main\`   deep-scan everything that differs from a branch (PR review).
- \`vibedrift --deep\`               full-repo deep scan.
The --deep workflows (semantic-duplicate confirmation, intent lie-detection, the coherence audit) are a paid Pro/Scale feature; the local tools above stay free.`;

/**
 * Build the server with the five local tools registered. The local tools are
 * free for everyone; deep checks are metered server-side inside the tools.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "vibedrift", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerGetIntentHints.register(server);
  registerGetDominantPattern.register(server);
  registerCheckFileDrift.register(server);
  registerFindSimilarFunction.register(server);
  registerValidateChange.register(server);
  return server;
}

/** Start the server on stdio. Called by the `vibedrift mcp` subcommand and by
 *  direct `node dist/mcp/server.js` execution (the integration test spawns that). */
export async function runServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // STDERR ONLY — stdout is the JSON-RPC channel.
  console.error("vibedrift-mcp running on stdio (local tools free)");
}

// Direct execution: `node dist/mcp/server.js`
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  runServer().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
