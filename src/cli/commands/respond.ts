/**
 * `vibedrift respond <flag> <accept|park|decline> [--reason ...]` — record YOUR
 * call on a Drift Session flag.
 *
 * Why this exists. A flag could only ever be answered by the agent, through
 * the MCP tool `respond_to_flag`. That left one state with no way out of it:
 * the agent parks a flag *for a person*, the dashboard says "waiting on you",
 * and the person has nowhere to say anything. Not from the dashboard, which
 * reads the ledger and never writes to it, and not from here, because this
 * command did not exist. The loop asked a question it gave you no way to
 * answer.
 *
 * It writes exactly what the agent writes, through the same
 * `recordFlagDecision` path: the same event shape in the same append-only local
 * ledger, secret-masked, and shipped by the next flush like anything else. A
 * human answer and an agent answer are the same kind of fact about a flag, so
 * they are stored the same way rather than in a second place with its own
 * rules.
 *
 * Local only. Nothing here talks to the network.
 */

import chalk from "chalk";
import { resolve } from "node:path";
import { recordFlagDecision, type Decision } from "../../session/decision.js";
import { defaultSessionsDir, repoIdentity } from "../../session/repo.js";

export interface RespondOptions {
  reason?: string;
  json?: boolean;
  /** test seam */
  sessionsDir?: string;
}

export type RespondStatus = "ok" | "bad_decision" | "no_session" | "unknown_finding" | "failed";

const DECISIONS: readonly Decision[] = ["accept", "park", "decline"];

function isDecision(v: string): v is Decision {
  return (DECISIONS as readonly string[]).includes(v);
}

/** What each call means, in the words the dashboard uses for it. */
const MEANING: Record<Decision, string> = {
  accept: "you agree and the code will change",
  park: "leave it for later, on the record",
  decline: "the flag is wrong here",
};

export async function runRespond(
  findingId: string,
  decision: string,
  targetPath = ".",
  options: RespondOptions = {},
): Promise<RespondStatus> {
  const out = (s: string) => {
    if (!options.json) console.log(s);
  };

  if (!isDecision(decision)) {
    if (options.json) console.log(JSON.stringify({ ok: false, code: "bad_decision" }));
    else {
      console.error(chalk.red(`Not a decision: ${decision}`));
      console.error(chalk.dim(`  Use one of: ${DECISIONS.join(", ")}`));
    }
    return "bad_decision";
  }

  const { rootDir } = repoIdentity(resolve(targetPath));
  const result = await recordFlagDecision({
    sessionsDir: options.sessionsDir ?? defaultSessionsDir(),
    rootDir,
    findingId,
    decision,
    // A reason is required of the agent, so it is offered to a person rather
    // than demanded: an empty one records the call honestly instead of
    // blocking it behind a sentence nobody wants to write.
    reason: options.reason ?? "",
  });

  if (result.ok) {
    if (options.json) {
      console.log(JSON.stringify({ ok: true, findingId: result.findingId, decision: result.decision }));
    } else {
      out(`${chalk.green("✓")} ${chalk.bold(result.findingId)} ${decision} — ${MEANING[decision]}`);
      if (!options.reason) out(chalk.dim("  Add --reason \"...\" next time to say why; it stays on this machine unless team sharing is on."));
      out(chalk.dim("  It reaches the dashboard with the next flush."));
    }
    return "ok";
  }

  if (options.json) console.log(JSON.stringify(result));

  if (result.code === "no_active_session") {
    if (!options.json) {
      console.error(chalk.yellow("No Drift Session ledger for this repo."));
      console.error(chalk.dim(`  Nothing has been recorded in ${rootDir} yet.`));
    }
    return "no_session";
  }
  if (result.code === "unknown_finding") {
    if (!options.json) {
      console.error(chalk.yellow(`No flag ${findingId} in this repo's session.`));
      if (result.knownFindings.length > 0) {
        console.error(chalk.dim(`  Raised here: ${result.knownFindings.join(", ")}`));
      }
    }
    return "unknown_finding";
  }
  if (!options.json) console.error(chalk.red("Could not record that call."));
  return "failed";
}
