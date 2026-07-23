/**
 * respond_to_flag — MCP adapter.
 *
 * Lets the agent record its own call on a VibeDrift flag (accept / park /
 * decline) with a one-line reason. Local + free: it writes only to the local
 * session ledger and sends zero bytes. Advisory — it never blocks the edit, and
 * recording is best-effort (fail-open). The decision is a stated intent, not a
 * verified resolution: accepting a flag does NOT mark it resolved; only a later
 * re-edit that clears the signal does.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toToolResult, type ToolResult } from "../envelope.js";
import type { StructuredBase } from "../../tools-core/result.js";
import { defaultSessionsDir } from "../../session/repo.js";
import { recordFlagDecision, DECISIONS, type Decision } from "../../session/decision.js";

export const inputSchema = {
  rootDir: z.string().describe("Absolute path to the repository root"),
  findingId: z
    .string()
    .describe("The flag's id from the VibeDrift hook advisory, e.g. \"DF-3\"."),
  decision: z
    .enum(DECISIONS)
    .describe(
      "accept = you agree and will fix it; park = defer it to a human reviewer; decline = you judge the flag wrong or not needed for this codebase.",
    ),
  reason: z
    .string()
    .describe("One line on why you made this call. Recorded secret-masked and capped (~2000 chars)."),
};

export interface RespondToFlagOut extends StructuredBase {
  recorded: boolean;
  findingId?: string;
  decision?: Decision;
  knownFindings?: string[];
}

export async function run(args: {
  rootDir: string;
  findingId: string;
  decision: Decision;
  reason: string;
}): Promise<RespondToFlagOut> {
  // Whole body guarded: even resolving the sessions dir (homedir) must never
  // surface as an MCP tool error — recording a decision is strictly advisory.
  try {
    const res = await recordFlagDecision({
      sessionsDir: defaultSessionsDir(),
      rootDir: args.rootDir,
      findingId: args.findingId,
      decision: args.decision,
      reason: args.reason,
    });

    if (res.ok) {
      return {
        status: "ok",
        recorded: true,
        findingId: res.findingId,
        decision: res.decision,
        message: `Recorded ${res.decision} on ${res.findingId}.`,
      };
    }
    if (res.code === "unknown_finding") {
      const known = res.knownFindings.length ? res.knownFindings.join(", ") : "none";
      return {
        status: "ok",
        recorded: false,
        knownFindings: res.knownFindings,
        message: `No flag ${args.findingId} in an active session for this repo. Open flags: ${known}.`,
      };
    }
    if (res.code === "no_active_session") {
      return {
        status: "ok",
        recorded: false,
        message: "No active VibeDrift session for this repo, so nothing was recorded.",
      };
    }
    if (res.code === "record_failed") {
      return {
        status: "ok",
        recorded: false,
        message: "Couldn't record the decision (an internal error). Nothing was saved.",
      };
    }
    return {
      status: "ok",
      recorded: false,
      message: `Not a valid decision. Use one of: ${DECISIONS.join(", ")}.`,
    };
  } catch {
    return {
      status: "ok",
      recorded: false,
      message: "Couldn't record the decision. Nothing was saved.",
    };
  }
}

export const registerRespondToFlag = {
  run,
  register(server: McpServer): void {
    server.registerTool(
      "respond_to_flag",
      {
        title: "Respond to a VibeDrift flag",
        description:
          "When a VibeDrift hook advisory flags one of your changes (the message carries a DF-<n> id), record your call on it: accept (you'll fix it), park (defer to a human reviewer), or decline (you judge the flag wrong or unnecessary here), with a one-line reason. Local, free, advisory — it records your decision to the session log and never blocks your edit. Accepting does not by itself resolve the flag; a later edit that clears the signal does.",
        inputSchema,
      },
      async (args): Promise<ToolResult> => toToolResult(await run(args)),
    );
  },
};
