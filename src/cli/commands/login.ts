import chalk from "chalk";
import {
  startDeviceAuth,
  pollDeviceAuth,
  fetchCredits,
  VibeDriftApiError,
} from "../../auth/api.js";
import { patchConfig, readConfig } from "../../auth/config.js";
import { openInBrowser } from "../../auth/browser.js";
import { previewToken } from "../../auth/resolver.js";

export interface LoginOptions {
  apiUrl?: string;
  noBrowser?: boolean;
}

/**
 * Device-authorization login flow (RFC 8628 inspired, GitHub CLI style).
 *
 *   1. POST /auth/device → server returns user_code, verification_uri, device_code
 *   2. Print user_code, open verification_uri in the browser
 *   3. Poll /auth/poll until status === "authorized"
 *   4. Save the resulting access_token to ~/.vibedrift/config.json
 *
 * No password ever touches the CLI. The browser handles the auth and the
 * server hands the CLI back an opaque bearer token.
 */
export async function runLogin(options: LoginOptions = {}): Promise<void> {
  // Warn if a token already exists so we don't silently clobber it.
  const existing = await readConfig();
  if (existing.token) {
    console.log(
      chalk.yellow(
        `\n  You're already logged in as ${chalk.bold(existing.email ?? "unknown")} (${existing.plan ?? "free"}).`,
      ),
    );
    console.log(chalk.dim(`  Token: ${previewToken(existing.token)}`));
    console.log(chalk.dim("  Continuing will replace this token.\n"));
  }

  let device;
  try {
    device = await startDeviceAuth({ apiUrl: options.apiUrl });
  } catch (err) {
    fail("Could not start the login flow", err);
    return;
  }

  console.log("");
  console.log(chalk.bold("  First, copy your one-time code:"));
  console.log("");
  console.log(`    ${chalk.bgYellow.black.bold(`  ${device.user_code}  `)}`);
  console.log("");
  console.log(chalk.dim(`  This code expires in ${formatDuration(device.expires_in)}.`));
  console.log("");

  const opened = !options.noBrowser && openInBrowser(device.verification_uri_complete);
  if (opened) {
    console.log(chalk.bold("  Opened your browser to:"));
  } else {
    console.log(chalk.bold("  Open this URL in your browser:"));
  }
  console.log(`    ${chalk.cyan(device.verification_uri_complete)}`);
  console.log("");
  console.log(chalk.dim("  Waiting for you to authorize the CLI..."));
  console.log("");

  // Poll loop. Use the server-suggested interval; double on slow_down errors.
  let interval = Math.max(1, device.interval);
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    let result;
    try {
      result = await pollDeviceAuth(device.device_code, { apiUrl: options.apiUrl });
    } catch (err) {
      if (err instanceof VibeDriftApiError && err.status === 429) {
        interval = Math.min(interval * 2, 30);
        continue;
      }
      fail("Polling for authorization failed", err);
      return;
    }

    if (result.status === "pending") continue;

    if (result.status === "authorized") {
      await handleLoginSuccess(result, options);
      return;
    }

    if (result.status === "denied") {
      console.error(chalk.red("\n  ✗ Authorization was denied in the browser."));
      console.error(chalk.dim("    Run `vibedrift login` again to retry.\n"));
      process.exit(1);
    }

    if (result.status === "expired") {
      console.error(chalk.red("\n  ✗ The login code expired before you authorized it."));
      console.error(chalk.dim("    Run `vibedrift login` again to retry.\n"));
      process.exit(1);
    }
  }

  console.error(chalk.red("\n  ✗ Login timed out before authorization completed."));
  console.error(chalk.dim("    Run `vibedrift login` again to retry.\n"));
  process.exit(1);
}

async function handleLoginSuccess(
  result: { access_token: string; email: string; plan: "free" | "pro" | "enterprise"; expires_at: string },
  options: LoginOptions,
): Promise<void> {
  await patchConfig({
    token: result.access_token,
    email: result.email,
    plan: result.plan,
    expiresAt: result.expires_at,
    loggedInAt: new Date().toISOString(),
    apiUrl: options.apiUrl,
  });
  console.log(chalk.green("  ✓ Logged in successfully."));
  console.log("");
  console.log(`  Account: ${chalk.bold(result.email)}`);
  console.log(`  Plan:    ${chalk.bold(result.plan)}`);
  console.log("");

  // Fetch + announce the one-time welcome credit. Non-fatal if the
  // call fails — older API builds simply won't have this endpoint.
  try {
    const credits = await fetchCredits(result.access_token, {
      apiUrl: options.apiUrl,
    });
    if (credits.has_free_deep_scan && !credits.unlimited) {
      console.log(
        chalk.bgYellow.black.bold("  🎁 1 FREE deep scan every month with your account  "),
      );
      console.log("");
      console.log(
        chalk.yellow("  Try the full pipeline (Claude analysis, security review,"),
      );
      console.log(
        chalk.yellow("  AI-powered drift detection) on any project — no card needed."),
      );
      console.log("");
      console.log(`    ${chalk.cyan("vibedrift . --deep")}`);
      console.log("");
    } else if (credits.unlimited) {
      console.log(chalk.dim("  Run `vibedrift . --deep` to use AI-powered analysis."));
      console.log("");
    } else if (credits.available_total > 0) {
      console.log(
        chalk.dim(`  You have ${credits.available_total} deep scan credit${credits.available_total === 1 ? "" : "s"} available.`),
      );
      console.log(chalk.dim("  Run `vibedrift . --deep` to use one."));
      console.log("");
    } else {
      console.log(chalk.dim("  Run `vibedrift upgrade` to enable deep AI scans."));
      console.log("");
    }
  } catch {
    // Endpoint missing or transient error — fall back to legacy hint.
    if (result.plan === "free") {
      console.log(chalk.dim("  Run `vibedrift upgrade` to enable deep AI scans."));
    } else {
      console.log(chalk.dim("  Run `vibedrift . --deep` to use AI-powered analysis."));
    }
    console.log("");
  }
}

function fail(intro: string, err: unknown): never {
  const msg = err instanceof VibeDriftApiError
    ? `${err.status ? `HTTP ${err.status}: ` : ""}${err.message}`
    : err instanceof Error
      ? err.message
      : String(err);
  console.error(chalk.red(`\n  ✗ ${intro}: ${msg}\n`));
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}
