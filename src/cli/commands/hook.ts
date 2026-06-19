/**
 * `vibedrift hook` — a git pre-push hook that blocks a push whose Vibe Drift
 * Score is below a threshold. A prevention channel you own end to end: no MCP
 * server, no agent host, just git. Bypass once with `git push --no-verify`.
 *
 * The hook shells out to the regular CLI (`--fail-on-score`), so the gate is the
 * same tested code path CI uses; this command only manages the hook file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { readConfig } from "../../auth/config.js";
import { isPaidPlan } from "../../auth/plan.js";

const exec = promisify(execFile);

export const HOOK_MARKER = "# vibedrift-managed pre-push hook (vibedrift hook install)";
export const DEFAULT_THRESHOLD = 70;

/** Pure: the pre-push hook script for a given score threshold. */
export function buildHookScript(threshold: number): string {
  return `#!/bin/sh
${HOOK_MARKER}
# Blocks a push whose Vibe Drift Score is below ${threshold}.
# Bypass once with:  git push --no-verify
# Remove with:       vibedrift hook uninstall
if ! command -v vibedrift >/dev/null 2>&1; then
  echo "vibedrift not on PATH; skipping drift check (npm i -g @vibedrift/cli)" >&2
  exit 0
fi
exec vibedrift --local-only --format terminal --fail-on-score ${threshold}
`;
}

/** Resolve the repo's hooks directory, or throw a friendly error outside a repo. */
export async function resolveHooksDir(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--git-path", "hooks"], { cwd });
    return resolve(cwd, stdout.trim());
  } catch {
    throw new Error("not a git repository — run this inside one");
  }
}

export interface HookOptions {
  threshold?: number;
  force?: boolean;
}

export async function runHook(action: string, opts: HookOptions = {}, cwd: string = process.cwd()): Promise<void> {
  let hookPath: string;
  try {
    hookPath = join(await resolveHooksDir(cwd), "pre-push");
  } catch (err) {
    console.error(chalk.red(`vibedrift hook: ${(err as Error).message}`));
    process.exit(1);
  }

  if (action === "install") {
    // Installing the score-gating pre-push hook is a Pro/Scale feature (drift
    // enforcement in your own git workflow). uninstall/status stay open so a
    // downgraded user can always remove it. Cached-plan check — works offline.
    if (!isPaidPlan((await readConfig()).plan)) {
      console.error(chalk.red("\nThe VibeDrift pre-push hook is a Pro/Scale feature.\n"));
      console.error(chalk.dim("It blocks a push whose Vibe Drift Score is below your threshold —"));
      console.error(chalk.dim("drift enforcement, in your own git workflow."));
      console.error("");
      console.error(`  ${chalk.yellow("Upgrade:")} ${chalk.bold("vibedrift upgrade")}`);
      console.error("");
      process.exit(1);
    }
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, "utf8");
      if (!existing.includes(HOOK_MARKER) && !opts.force) {
        console.error(chalk.yellow(`A pre-push hook already exists at ${hookPath} and was not created by VibeDrift.`));
        console.error("Re-run with --force to replace it (back it up first).");
        process.exit(1);
      }
    }
    writeFileSync(hookPath, buildHookScript(threshold), "utf8");
    chmodSync(hookPath, 0o755);
    console.log(chalk.green(`Installed the VibeDrift pre-push hook (blocks below ${threshold}).`));
    console.log(`  ${hookPath}`);
    console.log("  Bypass once: git push --no-verify   ·   Remove: vibedrift hook uninstall");
    return;
  }

  if (action === "uninstall") {
    if (!existsSync(hookPath)) {
      console.log("No pre-push hook to remove.");
      return;
    }
    if (!readFileSync(hookPath, "utf8").includes(HOOK_MARKER)) {
      console.error(chalk.yellow(`The pre-push hook at ${hookPath} was not created by VibeDrift; leaving it in place.`));
      process.exit(1);
    }
    rmSync(hookPath);
    console.log("Removed the VibeDrift pre-push hook.");
    return;
  }

  if (action === "status") {
    const installed = existsSync(hookPath) && readFileSync(hookPath, "utf8").includes(HOOK_MARKER);
    console.log(
      installed
        ? `VibeDrift pre-push hook is installed:\n  ${hookPath}`
        : "VibeDrift pre-push hook is not installed. Add it with: vibedrift hook install",
    );
    return;
  }

  console.error(`vibedrift hook: unknown action "${action}". Use: install | uninstall | status`);
  process.exit(1);
}
