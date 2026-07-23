/**
 * CLI entry point — wires Commander.js commands to their handlers.
 *
 * "scan" is the default command (runs when no subcommand is given). Account
 * commands (login, logout, status, usage, upgrade, billing) manage auth and
 * Stripe integration. Maintenance commands (update, doctor, feedback) handle
 * self-update, diagnostics, and user feedback.
 */

import { resolve } from "path";
import { Command, Option } from "commander";
import { runScan } from "./commands/scan.js";
import { runInit } from "./commands/init.js";
import { runIgnore } from "./commands/ignore.js";
import { runUpdate } from "./commands/update.js";
import { runLogin } from "./commands/login.js";
import { runLogout } from "./commands/logout.js";
import { runStatus } from "./commands/status.js";
import { runUsage } from "./commands/usage.js";
import { runUpgrade } from "./commands/upgrade.js";
import { runBilling } from "./commands/billing.js";
import { runDoctor } from "./commands/doctor.js";
import { runFeedback } from "./commands/feedback.js";
import { runWatch } from "./commands/watch.js";
import { runWatchSession } from "./commands/watch-session.js";
import { runHook } from "./commands/hook.js";
import { getVersion } from "../core/version.js";

const VERSION = getVersion();

function parseScoreThreshold(value: string): number {
  const n = parseFloat(value);
  if (Number.isNaN(n) || n < 0 || n > 100) {
    console.error(
      `Error: --fail-on-score must be a number between 0 and 100, got "${value}"`,
    );
    process.exit(1);
  }
  return n;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const program = new Command();

program
  .name("vibedrift")
  .description(
    "Detect drift, contradictions, and security gaps in AI-generated codebases.",
  )
  .version(VERSION, "-V, --version", "show the installed version")
  .helpOption("-h, --help", "show this help");

// ──── Default subcommand: scan ────
program
  .command("scan", { isDefault: true })
  .description("Scan a project for vibe drift (default command)")
  .argument("[path]", "path to project directory", ".")
  // Output
  .option(
    "--format <type>",
    "output format: html, terminal, json, csv, docx",
    "html",
  )
  .option("--output <path>", "write report to a file")
  .option("--json", "shorthand for --format json")
  .option(
    "--fail-on-score <n>",
    "exit with code 1 if composite score is below this threshold",
    parseScoreThreshold,
  )
  // Analysis toggles
  .option("--no-codedna", "skip Code DNA semantic analysis")
  .option("--no-cache", "disable the per-analyzer findings cache")
  .option(
    "--deep",
    "enable AI-powered deep analysis (requires `vibedrift login`)",
  )
  .option(
    "--project-name <name>",
    "override the auto-detected project name shown in the dashboard",
  )
  .option(
    "--private",
    "anonymize the project name (uses privXXXXXXXXXXXX instead of the real name)",
  )
  .option(
    "--write-context",
    "write .vibedrift/context.md, fix-plan.md, fix-prompts.md, patterns.json into the project (safe to commit)",
  )
  .option(
    "--inject-context",
    "inject the context summary into CLAUDE.md inside a managed block (idempotent; pairs with --write-context)",
  )
  // File filtering
  .option(
    "--include <pattern>",
    "only scan files matching this glob (repeatable)",
    collect,
    [],
  )
  .option(
    "--exclude <pattern>",
    "exclude files matching this glob (repeatable)",
    collect,
    [],
  )
  .option(
    "--diff [ref]",
    "scope the scan to files changed in git (default: uncommitted vs HEAD; pass a ref like `main` to scan a whole branch). Pair with --deep to deep-scan only what you changed (Pro).",
  )
  // Maintenance
  .option(
    "--update",
    "update the VibeDrift CLI to the latest version (alias for `vibedrift update`)",
  )
  .option(
    "--feedback [message...]",
    "send feedback to the maintainer (alias for `vibedrift feedback`)",
  )
  .option("--verbose", "show timing breakdown and analyzer details")
  .option(
    "--local-only",
    "skip all network calls (no scan log, no beacon, no deep analysis, no fix-prompt synthesis)",
  )
  // Scan-over-scan diff
  .option(
    "--compare",
    "diff this scan against the most recent previous scan for this project (default when history exists)",
  )
  .option(
    "--no-compare",
    "disable the scan-over-scan diff banner",
  )
  .option(
    "--since <scanId>",
    "diff against a specific saved scan (e.g. scan-1712345678.json). Overrides --compare.",
  )
  // Hidden / advanced
  .addOption(
    new Option("--api-url <url>", "override the VibeDrift API base URL")
      .hideHelp(),
  )
  .action(async (path: string, options, command) => {
    if (options.update) {
      await runUpdate(VERSION);
      return;
    }
    if (options.feedback) {
      // --feedback can be a bare flag (`true`) or carry inline words
      // (`["the", "install", "is", "broken"]`); normalize both into a string
      const inline = Array.isArray(options.feedback)
        ? options.feedback.join(" ").trim()
        : "";
      await runFeedback({
        message: inline || undefined,
        apiUrl: options.apiUrl,
      });
      return;
    }

    // Project config (.vibedrift/config.json) supplies defaults for `format`
    // and `failOnScore`; an explicit CLI flag always wins. getOptionValueSource
    // distinguishes a real `--format` from the option's built-in default.
    const { loadProjectConfig } = await import("../core/project-config.js");
    const projectConfig = await loadProjectConfig(resolve(path));
    const formatFromCli = command.getOptionValueSource("format") === "cli";
    const resolvedFormat = options.json
      ? "json"
      : formatFromCli
        ? options.format
        : (projectConfig?.format ?? options.format);
    const resolvedFailOnScore =
      options.failOnScore ?? projectConfig?.failOnScore;

    await runScan(path, {
      json: options.json,
      format: resolvedFormat,
      output: options.output,
      failOnScore: resolvedFailOnScore,
      projectConfig: projectConfig ?? undefined,
      codedna: options.codedna,
      cache: options.cache,
      deep: options.localOnly ? false : options.deep,
      apiUrl: options.apiUrl,
      include: options.include,
      exclude: options.exclude,
      verbose: options.verbose,
      projectName: options.projectName,
      writeContext: options.writeContext,
      injectContext: options.injectContext,
      localOnly: options.localOnly,
      // Commander sets `compare: true` when --compare is passed and
      // `compare: false` for --no-compare. We default to undefined so
      // ScanOptions.compare can encode three states: explicit on, off,
      // or "use the default behavior" (diff when history exists).
      compare: options.compare,
      since: options.since,
      // --diff with no value → true (uncommitted vs HEAD); --diff main → "main".
      diff: options.diff,
    });
  });

// ──── Init subcommand — guided one-time project setup ────
program
  .command("init")
  .description("Set up VibeDrift for this project (.vibedriftignore + .vibedrift/config.json)")
  .argument("[path]", "path to project directory", ".")
  .option("-y, --yes", "accept detected defaults without prompting (non-interactive)")
  .action(async (path: string, options) => {
    await runInit({ rootDir: path, yes: options.yes });
  });

// ──── Ignore subcommand — quick append to .vibedriftignore ────
program
  .command("ignore")
  .description("Add path glob(s) to .vibedriftignore so scans skip them")
  .argument("<patterns...>", 'glob(s) to exclude, e.g. "**/fixtures/**"')
  .action(async (patterns: string[]) => {
    await runIgnore(patterns);
  });

// ──── Watch subcommand — rerun scan + refresh .vibedrift/ on file changes ────
program
  .command("watch")
  .description("Watch the project and refresh .vibedrift/ outputs on every change (local-only, no network)")
  .argument("[path]", "path to project directory", ".")
  .option(
    "--interval <seconds>",
    "debounce interval in seconds (minimum between scans)",
    (v) => {
      const n = parseInt(v, 10);
      if (Number.isNaN(n)) {
        console.error(`Error: --interval must be a number, got "${v}"`);
        process.exit(1);
      }
      return n;
    },
    10,
  )
  .option("--verbose", "print each file-change event")
  .option("--include <pattern>", "only scan files matching this glob (repeatable)", collect, [])
  .option("--exclude <pattern>", "exclude files matching this glob (repeatable)", collect, [])
  .action(async (path: string, options) => {
    await runWatch(path, {
      intervalSeconds: options.interval,
      verbose: options.verbose,
      include: options.include,
      exclude: options.exclude,
    });
  });

// ──── Drift Sessions (preview) subcommand ────
program
  .command("watch-session")
  .description(
    "Drift Sessions (preview): record an agent session's prompts and edits to a local ledger via Claude Code hooks (local-only, consent-gated)",
  )
  .argument("[path]", "path to project directory", ".")
  .option("--uninstall", "remove the hooks this command installed")
  .option("--status", "report whether hooks are installed")
  .option("--yes", "skip the consent prompt (you have read what it records)")
  .option("--no-watch", "install only; do not follow the live event tape")
  .option("--sync <state>", "hosted sync (Pro): 'on' opts into derived-only upload, 'off' disables it")
  .option("--local-only", "force hosted sync off for this run")
  .action(async (path: string, options) => {
    const sync = options.sync === "on" ? "on" : options.sync === "off" ? "off" : undefined;
    await runWatchSession(path, {
      uninstall: options.uninstall,
      status: options.status,
      yes: options.yes,
      sync,
      localOnly: options.localOnly === true,
      watch: options.watch !== false && !options.uninstall && !options.status && !sync,
    });
  });

// ──── Telemetry subcommand ────
program
  .command("telemetry")
  .description("Manage anonymous scan telemetry")
  .argument("<action>", "'enable' or 'disable'")
  .action(async (action: string) => {
    const { patchConfig, readConfig } = await import("../auth/config.js");
    if (action === "disable") {
      await patchConfig({ telemetryEnabled: false });
      console.log("\n  Telemetry disabled. VibeDrift will no longer send anonymous scan statistics.");
      console.log("  You can re-enable anytime with: vibedrift telemetry enable\n");
    } else if (action === "enable") {
      await patchConfig({ telemetryEnabled: true });
      console.log("\n  Telemetry enabled. VibeDrift sends anonymous scan statistics");
      console.log("  (language, file count, scan time — no code, no file paths).");
      console.log("  Learn more: https://vibedrift.ai/privacy\n");
    } else {
      const config = await readConfig();
      const status = config.telemetryEnabled === false ? "disabled" : "enabled";
      console.log(`\n  Telemetry is currently ${status}.`);
      console.log("  Usage: vibedrift telemetry <enable|disable>\n");
    }
  });

// ──── Account / auth subcommands ────
program
  .command("login")
  .description("Log in to your VibeDrift account")
  .option("--no-browser", "don't open the browser automatically")
  .addOption(
    new Option("--api-url <url>", "override the API base URL")
      .hideHelp(),
  )
  .action(async (options) => {
    await runLogin({
      apiUrl: options.apiUrl,
      noBrowser: options.browser === false,
    });
  });

program
  .command("logout")
  .description("Log out and revoke the current token")
  .action(async () => {
    await runLogout();
  });

program
  .command("status")
  .description("Show the current account, plan, and token")
  .action(async () => {
    await runStatus();
  });

program
  .command("usage")
  .description("Show your current billing period's scan usage")
  .action(async () => {
    await runUsage();
  });

program
  .command("upgrade")
  .description("Open the VibeDrift pricing page")
  .action(async () => {
    await runUpgrade();
  });

program
  .command("billing")
  .description("Open the Stripe Customer Portal to manage your subscription")
  .action(async () => {
    await runBilling();
  });

program
  .command("doctor")
  .description("Diagnose CLI installation, auth, and API connectivity")
  .action(async () => {
    await runDoctor();
  });

program
  .command("update")
  .description("Update the VibeDrift CLI to the latest version")
  .action(async () => {
    await runUpdate(VERSION);
  });

program
  .command("feedback")
  .description("Send feedback, bug reports, or feature requests directly to the maintainer")
  .argument(
    "[message...]",
    "feedback text (omit to be prompted interactively)",
  )
  .addOption(
    new Option("--api-url <url>", "override the API base URL").hideHelp(),
  )
  .action(async (messageWords: string[], options) => {
    const message = (messageWords ?? []).join(" ").trim() || undefined;
    await runFeedback({ message, apiUrl: options.apiUrl });
  });

program
  .command("hook")
  .description("Manage a git pre-push hook that blocks pushes below a drift-score threshold")
  .argument("<action>", "install | uninstall | status")
  .option(
    "--threshold <n>",
    "Vibe Drift Score below which a push is blocked (default 70)",
    parseScoreThreshold,
  )
  .option("--force", "replace an existing pre-push hook that VibeDrift did not create")
  .action(async (action: string, options) => {
    await runHook(action, { threshold: options.threshold, force: options.force });
  });

program
  .command("mcp")
  .description("Run the MCP server (stdio) — lets AI agents query drift in-loop")
  .action(async () => {
    // Long-lived stdio server. Logs to stderr only — stdout is the JSON-RPC
    // channel. Dynamically imported so the MCP SDK isn't loaded for normal scans.
    const { runServer } = await import("../mcp/server.js");
    await runServer();
  });

program.addHelpText(
  "after",
  `
Examples:
  $ vibedrift                          scan the current directory
  $ vibedrift ./my-project             scan a specific project
  $ vibedrift init                     guided setup (.vibedriftignore + config)
  $ vibedrift ignore "**/fixtures/**"  skip a path glob in every scan
  $ vibedrift --format terminal        print results to the terminal
  $ vibedrift --json > report.json     pipe JSON output to a file
  $ vibedrift --fail-on-score 70       fail CI if score drops below 70
  $ vibedrift --include "src/**"       only scan files under src/
  $ vibedrift --exclude "**/*.spec.*"  skip test files
  $ vibedrift --deep                   run premium AI-powered deep analysis
  $ vibedrift --local-only             scan with zero network calls
  $ vibedrift --write-context          write .vibedrift/context.md + AI prompts
  $ vibedrift --write-context --inject-context   refresh .vibedrift + inject into CLAUDE.md
  $ vibedrift login                    sign in to enable --deep
  $ vibedrift status                   check current auth state
  $ vibedrift usage                    view this month's scan usage
  $ vibedrift upgrade                  open the pricing page
  $ vibedrift billing                  manage your Stripe subscription
  $ vibedrift update                   update to the latest CLI version
  $ vibedrift telemetry disable        opt out of anonymous scan telemetry
  $ vibedrift telemetry enable         re-enable anonymous scan telemetry
  $ vibedrift feedback                 open an interactive feedback prompt
  $ vibedrift feedback "..."           send inline feedback in one shot
  $ vibedrift mcp                      run the MCP server (for Claude Code / Cursor)
  $ vibedrift hook install             block pushes below the drift-score threshold

Environment:
  VIBEDRIFT_TOKEN     bearer token (overrides ~/.vibedrift/config.json)
  VIBEDRIFT_API_URL   override the API base URL
  VIBEDRIFT_NO_BROWSER if "1", never auto-open the browser

Telemetry:
  Your code never leaves your machine. After each scan VibeDrift sends a
  small anonymous usage beacon (language, file count, lines of code, scan
  time, CLI version, finding count, and score; no code, no file paths, no
  identifiers), on by default for everyone whether signed in or not. Turn
  it off anytime, or run --local-only for a fully offline scan:
  $ vibedrift telemetry disable   (or set VIBEDRIFT_TELEMETRY_DISABLED=1)

Learn more: https://vibedrift.ai`,
);

// Top-level catch ensures unhandled rejections from any command
// produce a clean error message instead of a stack trace
program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
