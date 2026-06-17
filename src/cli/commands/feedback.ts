import os from "os";
import readline from "readline";
import chalk from "chalk";
import { resolveToken, resolveApiUrl } from "../../auth/resolver.js";
import { sendFeedback, VibeDriftApiError } from "../../auth/api.js";
import { getVersion } from "../../core/version.js";

export interface FeedbackOptions {
  message?: string;
  apiUrl?: string;
}

const MAX_MESSAGE_BYTES = 4096;

/**
 * `vibedrift feedback` — send free-form feedback directly from the CLI.
 *
 * Two modes:
 *   1. Inline:       `vibedrift feedback "the install hint is too verbose"`
 *   2. Interactive:  `vibedrift feedback`  (prompts on stdin until EOF)
 *
 * Auth is optional. We *try* to attach the user's token so triage can
 * follow up directly, but anonymous feedback works too — the API
 * accepts unauthenticated submissions for exactly this case.
 *
 * Always attaches CLI version, Node version, and OS as metadata so we
 * can correlate complaints with environments without asking the user.
 */
export async function runFeedback(opts: FeedbackOptions = {}): Promise<void> {
  console.log("");
  console.log(chalk.bold("  VibeDrift feedback"));
  console.log(
    chalk.dim("  Tell us what's broken, what's confusing, or what you wish existed."),
  );
  console.log(
    chalk.dim("  Goes straight to the maintainer — anonymous unless you're logged in."),
  );
  console.log("");

  // ── Collect the message ──
  let message = (opts.message ?? "").trim();
  if (!message) {
    message = await promptForMultilineMessage();
  }

  if (!message) {
    console.error(chalk.red("  ✗ No feedback provided. Aborting."));
    process.exit(1);
  }

  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    console.error(
      chalk.red(
        `  ✗ Message too long (max ${MAX_MESSAGE_BYTES} bytes). ` +
          `Please trim it or open an issue on GitHub for longer reports.`,
      ),
    );
    process.exit(1);
  }

  // ── Try (best-effort) to attach the user's token ──
  let token: string | null = null;
  try {
    const resolved = await resolveToken();
    if (resolved) token = resolved.token;
  } catch {
    // Anonymous fallback is fine
  }

  // ── Build metadata: CLI version + Node + OS ──
  const metadata: Record<string, unknown> = {
    cli_version: getVersion(),
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    locale: process.env.LANG ?? null,
    tty: process.stdin.isTTY === true,
  };

  // ── Send it ──
  process.stdout.write(chalk.dim("  Sending... "));
  try {
    const result = await sendFeedback({
      source: "cli",
      message,
      token: token ?? undefined,
      metadata,
      apiUrl: await resolveApiUrl(opts.apiUrl),
    });
    console.log(chalk.green("ok"));
    console.log("");
    console.log(`  ${chalk.dim("Reference:")} ${chalk.dim(result.id)}`);
    if (token) {
      console.log(
        chalk.dim(
          "  Submitted under your account — we'll reply to your email if needed.",
        ),
      );
    } else {
      console.log(
        chalk.dim(
          "  Submitted anonymously. If you'd like a reply, run `vibedrift login` first.",
        ),
      );
    }
    console.log("");
    console.log(chalk.green("  ✓ Thanks for helping us improve VibeDrift."));
    console.log("");
  } catch (err) {
    console.log(chalk.red("failed"));
    console.log("");
    if (err instanceof VibeDriftApiError) {
      console.error(chalk.red(`  ✗ ${err.message}`));
    } else {
      console.error(
        chalk.red(`  ✗ ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    console.error(
      chalk.dim(
        "    You can also email sami.ahmadkhan12@gmail.com directly.",
      ),
    );
    console.log("");
    process.exit(1);
  }
}

/**
 * Multi-line prompt: read until the user submits a line containing only
 * `EOF` or hits Ctrl-D. Falls back to single-line `readline.question` if
 * stdin isn't a TTY (so a piped `echo "..."` still works).
 */
function promptForMultilineMessage(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Piped input — read everything until EOF
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buf += chunk;
      });
      process.stdin.on("end", () => resolve(buf.trim()));
      return;
    }

    console.log(
      chalk.dim(
        "  Type your feedback below. Submit with a single line containing 'EOF',",
      ),
    );
    console.log(chalk.dim("  or press Ctrl-D when done. Press Ctrl-C to abort."));
    console.log("");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.yellow("  > "),
    });

    const lines: string[] = [];
    rl.prompt();
    rl.on("line", (line) => {
      if (line.trim() === "EOF") {
        rl.close();
        return;
      }
      lines.push(line);
      rl.prompt();
    });
    rl.on("close", () => {
      console.log("");
      resolve(lines.join("\n").trim());
    });
    rl.on("SIGINT", () => {
      console.log(chalk.red("\n  ✗ Aborted."));
      process.exit(1);
    });
  });
}
