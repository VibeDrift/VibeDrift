#!/usr/bin/env node
/**
 * @vibedrift/mcp — local stdio MCP server.
 *
 * Exposes VibeDrift's drift / Code-DNA / intent engines as in-loop agent tools
 * so a coding agent can consult the repo's own conventions WHILE it writes,
 * surfacing drift in the loop, while it is cheap to fix, instead of at review
 * time. Local-only and FREE for everyone: the tools run on the user's machine
 * and send zero bytes. (Opt-in `deep: true` checks are metered server-side
 * inside the individual tools.)
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
import { registerRespondToFlag } from "./tools/respond-to-flag.js";
import { registerInit } from "./tools/init.js";

const SERVER_INSTRUCTIONS = `VibeDrift detects drift in AI-generated code — where new code diverges from the patterns the rest of the codebase already follows.

These in-loop tools are LOCAL and FREE — call them while writing code:
- init: one-time setup — write .vibedrift/config.json + .vibedriftignore so scans skip fixtures/generated code (call once on a fresh repo).
- get_dominant_pattern: the codebase's dominant pattern for a category (so new code matches it).
- get_intent_hints: team-declared conventions from CLAUDE.md / AGENTS.md / .cursorrules.
- check_file_drift: whether a file diverges from the dominant patterns.
- find_similar_function: existing near-duplicates of a function you're about to write (avoid re-implementing).
- validate_change: pre-commit drift check on an edit.
- respond_to_flag: when a VibeDrift hook advisory flags your change (it carries a DF-<n> id), record your call on it — accept (you'll fix it), park (defer to a human reviewer), or decline (you judge the flag wrong/unneeded) — with a one-line reason.

For a deeper, AI-validated pass on a CHANGE SET (before committing or opening a PR), have the user run the CLI:
- \`vibedrift --deep --diff\`        deep-scan ONLY the files changed vs HEAD (fast, scoped).
- \`vibedrift --deep --diff main\`   deep-scan everything that differs from a branch (PR review).
- \`vibedrift --deep\`               full-repo deep scan.
The --deep workflows (semantic-duplicate confirmation, intent lie-detection, the coherence audit) are a paid Pro feature; the local tools above stay free.`;

/**
 * Build the server with the seven local tools registered. The local tools are
 * free for everyone; deep checks are metered server-side inside the tools.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "vibedrift", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerInit.register(server);
  registerGetIntentHints.register(server);
  registerGetDominantPattern.register(server);
  registerCheckFileDrift.register(server);
  registerFindSimilarFunction.register(server);
  registerValidateChange.register(server);
  registerRespondToFlag.register(server);
  return server;
}

/** Start the server on stdio. Called by the `vibedrift mcp` subcommand and by
 *  direct `node dist/mcp/server.js` execution (the integration test spawns that).
 *  Note: respond_to_flag WRITES to the local session ledger; every other tool is
 *  read-only. Still zero network — "local + free" holds. */
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
