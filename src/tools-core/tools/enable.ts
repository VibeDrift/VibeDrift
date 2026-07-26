/**
 * enable — the in-loop activation answer for native Drift Sessions.
 *
 * Channel-neutral core (no MCP import). The agent calls this after the user
 * answers the SessionStart nudge:
 *   - yes  → `{ rootDir, confirm: "<the user's literal affirmative>" }`
 *   - no   → `{ rootDir, decline: true }`
 *
 * Consent model (O18): the MCP adapter marks this tool
 * `_meta["anthropic/requiresUserInteraction"]:true`, so Claude Code shows its
 * native Allow/Deny prompt on every call — that click is the HARD consent. The
 * `confirm` string is a second, in-band affirmative: an enable with no `confirm`
 * is refused (`needs_confirmation`) so the tool can never activate a repo the
 * user did not explicitly agree to. Declining needs no `confirm`.
 *
 * On enable: records `active` in the machine-global activation store, appends a
 * local consent receipt, and installs the agent hooks when a supported agent is
 * present. The drift baseline stays LAZY — the first scan / first edit-check
 * builds it; enable does not block on it.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { repoIdentity, defaultSessionsDir } from "../../session/repo.js";
import {
  installHooks,
  hooksStatus,
  resolveHookCommand,
  detectClaudeCode,
} from "../../session/install.js";
import { recordAnswer } from "../../session/activation.js";
import { appendConsentReceipt } from "../../session/consent.js";
import type { StructuredBase } from "../result.js";

// zod raw shape (matches the other tools-core tools).
import { z } from "zod";

export const inputSchema = {
  rootDir: z.string().describe("Absolute path to the repository root to activate"),
  confirm: z
    .string()
    .optional()
    .describe(
      "The user's literal affirmative (e.g. their 'yes, enable it'). REQUIRED to enable — omit only when declining.",
    ),
  decline: z
    .boolean()
    .optional()
    .describe("Set true to record the user's 'no / not now' so this repo is never asked again."),
};

export interface EnableArgs {
  rootDir: string;
  confirm?: string;
  decline?: boolean;
}

export interface EnableResult extends StructuredBase {
  action: "enabled" | "declined" | "needs_confirmation";
  projectHash: string;
  rootDir: string;
  hooksInstalled?: boolean;
}

export async function run(args: EnableArgs): Promise<EnableResult> {
  const { rootDir, projectHash } = repoIdentity(resolve(args.rootDir));
  const sessionsDir = defaultSessionsDir();
  const ledgerDir = join(sessionsDir, projectHash);
  const at = new Date().toISOString();

  if (args.decline === true) {
    recordAnswer(projectHash, "declined", "mcp-decline", undefined);
    appendConsentReceipt(ledgerDir, { v: 1, at, action: "decline", surface: "mcp-decline", projectHash, rootDir });
    return {
      status: "ok",
      action: "declined",
      projectHash,
      rootDir,
      message: "Drift Sessions declined for this repo — it won't be asked again. Reverse anytime by calling enable with a confirmation.",
    };
  }

  // Enable requires the in-band affirmative (the forced Allow/Deny prompt is the
  // other half of consent). No confirmation → do not activate.
  if (!args.confirm || args.confirm.trim().length === 0) {
    return {
      status: "partial",
      action: "needs_confirmation",
      projectHash,
      rootDir,
      message:
        "Enable needs the user's explicit confirmation. Ask them, then call enable again with `confirm` set to their affirmative (or pass decline:true if they say no).",
    };
  }

  recordAnswer(projectHash, "active", "mcp-enable", undefined);
  appendConsentReceipt(ledgerDir, { v: 1, at, action: "enable", surface: "mcp-enable", projectHash, rootDir });

  let hooksInstalled = false;
  if (detectClaudeCode(rootDir, homedir())) {
    const existing = await hooksStatus(rootDir);
    if (existing.installed) {
      hooksInstalled = true;
    } else {
      const res = await installHooks(rootDir, {
        hookCommand: resolveHookCommand(),
        sessionsDir,
        projectHash,
      });
      hooksInstalled = res.status === "installed" || res.status === "already";
    }
  }

  return {
    status: "ok",
    action: "enabled",
    projectHash,
    rootDir,
    hooksInstalled,
    message: hooksInstalled
      ? "Drift Sessions active for this repo. Capture begins on the next edit; the drift baseline builds on the first scan or edit-check."
      : "Drift Sessions active for this repo (answer recorded). No supported agent hook detected yet, so capture starts once Claude Code hooks are installed.",
  };
}
