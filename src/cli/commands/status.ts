import chalk from "chalk";
import { readConfig, getConfigPath } from "../../auth/config.js";
import { previewToken, resolveToken, describeSource } from "../../auth/resolver.js";
import { validateToken, fetchCredits, VibeDriftApiError } from "../../auth/api.js";
import { getVersion } from "../../core/version.js";
import { formatTimeSince } from "../../core/time-format.js";

/**
 * `vibedrift status` — show the currently active account, plan, and token preview.
 *
 * Token display rule (security): we show the **prefix**, never the suffix.
 * Suffix-only previews leak the most useful bytes for an attacker.
 */
export async function runStatus(): Promise<void> {
  const version = getVersion();
  const config = await readConfig();
  const resolved = await resolveToken();

  console.log("");
  console.log(chalk.bold(`  VibeDrift CLI v${version}`));
  console.log("");

  if (!resolved) {
    console.log(`  Status:  ${chalk.dim("not logged in")}`);
    console.log(`  Config:  ${chalk.dim(getConfigPath())}`);
    console.log("");
    console.log(chalk.dim("  Run `vibedrift login` to authenticate."));
    console.log("");
    return;
  }

  console.log(`  Status:  ${chalk.green("authenticated")}`);
  console.log(`  Source:  ${chalk.dim(describeSource(resolved.source))}`);
  console.log(`  Token:   ${chalk.dim(previewToken(resolved.token))}`);

  // Local config metadata (only meaningful when source === "config")
  if (resolved.source === "config") {
    if (config.email) console.log(`  Account: ${chalk.bold(config.email)}`);
    if (config.plan) console.log(`  Plan:    ${chalk.bold(config.plan)}`);
    if (config.expiresAt) console.log(`  Expires: ${chalk.dim(config.expiresAt)}`);
    console.log(`  Config:  ${chalk.dim(getConfigPath())}`);
  }

  console.log("");

  // Server-side validation — confirms the token is still live.
  process.stdout.write(chalk.dim("  Validating token with server... "));
  try {
    const result = await validateToken(resolved.token, { apiUrl: config.apiUrl });
    if (result.valid) {
      console.log(chalk.green("ok"));
      if (result.email && result.email !== config.email) {
        console.log(chalk.dim(`  Server account: ${result.email} (config out of sync — run \`vibedrift login\` to refresh)`));
      }
      if (result.plan && result.plan !== config.plan) {
        console.log(chalk.dim(`  Server plan: ${result.plan} (config out of sync — run \`vibedrift login\` to refresh)`));
      }
    } else {
      console.log(chalk.red("invalid"));
      console.log(chalk.dim("  Run `vibedrift login` to re-authenticate."));
    }
  } catch (err) {
    console.log(chalk.yellow("offline"));
    if (err instanceof VibeDriftApiError) {
      console.log(chalk.dim(`  ${err.message}`));
    }
  }

  // Credit summary — surfaces the welcome credit and any purchased ones.
  try {
    const credits = await fetchCredits(resolved.token, { apiUrl: config.apiUrl });
    console.log("");
    if (credits.unlimited) {
      console.log(`  Deep scans: ${chalk.bold.green("unlimited")} (${credits.plan})`);
    } else if (credits.has_free_deep_scan) {
      console.log(`  Deep scans: ${chalk.bold.yellow("1 free")} + ${credits.available_purchased} purchased`);
      console.log(chalk.dim("              Run `vibedrift . --deep` to use your free credit."));
    } else if (credits.available_total > 0) {
      console.log(`  Deep scans: ${chalk.bold(credits.available_total)} credit${credits.available_total === 1 ? "" : "s"} available`);
    } else {
      console.log(`  Deep scans: ${chalk.dim("0 credits")} — run \`vibedrift upgrade\` for more`);
    }
  } catch {
    // Older API or transient error — silently skip the credits line.
  }

  // Last deep scan — drives the "a lot has changed since your last deep scan"
  // intuition (and the in-editor nudge). Absent until the first successful --deep.
  console.log(
    `  Last deep: ${config.lastDeepScanAt ? chalk.dim(formatTimeSince(config.lastDeepScanAt)) : chalk.dim("never")}`,
  );

  console.log("");
}

