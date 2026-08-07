/**
 * `vibedrift enable` / `vibedrift decline` — the activation answers for
 * native Drift Sessions.
 *
 * O18 posture: TYPING `vibedrift enable` in a terminal IS the consent — no
 * second prompt. The command still prints exactly what it activated (informed
 * consent means the disclosure ships with the answer). `--dir` is broader and
 * therefore ALWAYS typed-confirms after showing the canonicalized path, and
 * hard-refuses `$HOME` and filesystem roots (O19).
 *
 * `vibedrift decline` records a permanent no for the repo: the nudge never
 * fires again and capture stays off (the hook gate reads the same store).
 * Reversible any time by running `vibedrift enable`.
 *
 * Both answers append a local consent receipt. Hooks install here only when a
 * supported agent is detected; the baseline stays lazy (first scan builds it).
 */

import { askConfirm } from "../prompt.js";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { repoIdentity, defaultSessionsDir } from "../../session/repo.js";
import {
  installHooks,
  hooksStatus,
  resolveHookCommand,
  detectClaudeCode,
} from "../../session/install.js";
import {
  recordAnswer,
  addDirGrant,
  resolveGrantPath,
  DirGrantRefusedError,
} from "../../session/activation.js";
import { appendConsentReceipt } from "../../session/consent.js";
import { vibedriftHome } from "../../core/vibedrift-home.js";

export interface EnableOptions {
  /** Grant a directory scope instead of a single repo (always typed-confirms). */
  dir?: string;
  /** Test/advanced seams; default to the real locations. */
  sessionsDir?: string;
  activationHome?: string;
  homeDir?: string;
  hookCommand?: string;
  confirm?: (question: string) => Promise<boolean>;
}

export type EnableStatus =
  | "enabled"
  | "enabled_no_agent"
  | "dir_granted"
  | "dir_refused"
  | "dir_declined"
  | "aborted_unparseable";

export type DeclineStatus = "declined";

function printDisclosure(ledgerDir: string): void {
  console.log(
    chalk.dim(
      [
        "  What this records: your prompts (secrets masked) and edit metadata,",
        `  to a LOCAL ledger under ${ledgerDir} — nothing leaves this machine`,
        "  unless you separately turn on hosted sync. Hooks fail open: an error",
        "  or timeout never interrupts your agent.",
        "  Change your mind anytime: vibedrift decline",
      ].join("\n"),
    ),
  );
}

export async function runEnable(targetPath: string, options: EnableOptions = {}): Promise<EnableStatus> {
  const activationHome = options.activationHome ?? vibedriftHome();
  const sessionsDir = options.sessionsDir ?? defaultSessionsDir();
  const at = new Date().toISOString();

  // ---- directory scope (O19) ----
  if (options.dir !== undefined) {
    let granted: string;
    try {
      granted = resolveGrantPath(options.dir);
    } catch (err) {
      if (err instanceof DirGrantRefusedError) {
        console.error(`${chalk.red("✗")} ${err.message}`);
      } else {
        console.error(`${chalk.red("✗")} cannot grant ${options.dir}: not an accessible directory`);
      }
      process.exitCode = 1;
      return "dir_refused";
    }
    const confirm = options.confirm ?? askConfirm;
    const ok = await confirm(
      [
        `This grants Drift Sessions for EVERY repo under:`,
        `  ${chalk.bold(granted)}`,
        "New repos there activate without being asked again (an explicit",
        "`vibedrift decline` in a repo still wins).",
        "Grant this directory? [y/N] ",
      ].join("\n"),
    );
    if (!ok) {
      console.log("Nothing granted.");
      return "dir_declined";
    }
    addDirGrant(granted, activationHome);
    appendConsentReceipt(activationHome, { v: 1, at, action: "dir-grant", surface: "dir-grant", grantPath: granted });
    console.log(`${chalk.green("✓")} Drift Sessions active for repos under ${granted}.`);
    return "dir_granted";
  }

  // ---- single repo: the typed command is the consent ----
  const { rootDir, projectHash } = repoIdentity(resolve(targetPath));
  const ledgerDir = join(sessionsDir, projectHash);
  recordAnswer(projectHash, "active", "cli-enable", activationHome);
  const receiptOk = appendConsentReceipt(ledgerDir, {
    v: 1,
    at,
    action: "enable",
    surface: "cli-enable",
    projectHash,
    rootDir,
  });

  const home = options.homeDir ?? homedir();
  if (!detectClaudeCode(rootDir, home)) {
    console.log(`${chalk.green("✓")} Drift Sessions enabled for this repo.`);
    console.log(
      chalk.dim(
        "  No supported agent detected yet (Claude Code is the first). Capture starts\n  once its hooks are installed — re-run `vibedrift enable` after setting it up.",
      ),
    );
    printDisclosure(ledgerDir);
    return "enabled_no_agent";
  }

  const already = await hooksStatus(rootDir);
  if (!already.installed) {
    const res = await installHooks(rootDir, {
      hookCommand: options.hookCommand ?? resolveHookCommand(),
      sessionsDir,
      projectHash,
    });
    if (res.status === "aborted_unparseable") {
      console.error(
        `Could not parse ${res.file}; refusing to modify it. Your answer was recorded — fix the JSON and re-run \`vibedrift enable\`.`,
      );
      process.exitCode = 1;
      return "aborted_unparseable";
    }
    console.log(`${chalk.green("✓")} Drift Sessions enabled — hooks installed for this repo (${res.file}).`);
  } else {
    console.log(`${chalk.green("✓")} Drift Sessions enabled — hooks were already installed (${already.file}).`);
  }
  if (!receiptOk) console.log(chalk.yellow("  note: could not write the local consent receipt (answer still recorded)."));
  printDisclosure(ledgerDir);
  console.log(chalk.dim("  follow live: vibedrift watch-session"));
  return "enabled";
}

export async function runDecline(
  targetPath: string,
  options: Pick<EnableOptions, "sessionsDir" | "activationHome"> = {},
): Promise<DeclineStatus> {
  const activationHome = options.activationHome ?? vibedriftHome();
  const sessionsDir = options.sessionsDir ?? defaultSessionsDir();
  const { rootDir, projectHash } = repoIdentity(resolve(targetPath));
  recordAnswer(projectHash, "declined", "cli-decline", activationHome);
  appendConsentReceipt(join(sessionsDir, projectHash), {
    v: 1,
    at: new Date().toISOString(),
    action: "decline",
    surface: "cli-decline",
    projectHash,
    rootDir,
  });
  console.log(`${chalk.green("✓")} Drift Sessions declined for this repo — you won't be asked again and capture stays off here.`);
  console.log(chalk.dim("  hooks (if any) stay inert; remove them entirely: vibedrift watch-session --uninstall"));
  console.log(chalk.dim("  changed your mind? vibedrift enable"));
  return "declined";
}
