import chalk from "chalk";
import { readConfig, getConfigPath } from "../../auth/config.js";
import { previewToken, resolveToken, describeSource } from "../../auth/resolver.js";
import { validateToken, fetchCredits, VibeDriftApiError, type CreditsResponse } from "../../auth/api.js";
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

  // Credit summary — period allowance plus top-up credits, same accounting
  // as `vibedrift usage` and the /v1/analyze gate.
  try {
    const credits = await fetchCredits(resolved.token, { apiUrl: config.apiUrl });
    const lines = buildDeepScanLines(credits);
    if (lines.length > 0) {
      console.log("");
      for (const line of lines) console.log(line);
    }
  } catch {
    // Transient error — silently skip the credits line.
  }

  // Last deep scan — drives the "a lot has changed since your last deep scan"
  // intuition (and the in-editor nudge). Absent until the first successful --deep.
  console.log(
    `  Last deep: ${config.lastDeepScanAt ? chalk.dim(formatTimeSince(config.lastDeepScanAt)) : chalk.dim("never")}`,
  );

  console.log("");
}

/** Pure renderer for the `Deep scans:` block. Input arrives validated —
 *  fetchCredits throws on any unknown shape (the schema drifted once
 *  already and interpolating a missing field printed literal "undefined"),
 *  and the caller's catch skips the block. */
export function buildDeepScanLines(credits: CreditsResponse): string[] {
  if (credits.unlimited) {
    return [`  Deep scans: ${chalk.bold.green("unlimited")} (${credits.plan})`];
  }
  const remaining = credits.deep_scans_remaining;
  const used = `${credits.deep_scans_this_month}/${credits.deep_scans_limit} used this period`;
  if (remaining > 0) {
    const lines = [`  Deep scans: ${chalk.bold(remaining)} remaining (${used})`];
    // "free deep scan" copy only while the monthly free scan is actually
    // unspent — remaining > 0 after it is used means top-up credits.
    if (credits.plan === "free" && credits.deep_scans_this_month === 0) {
      lines.push(chalk.dim("              Run `vibedrift . --deep` to use your free deep scan."));
    }
    return lines;
  }
  return [`  Deep scans: ${chalk.dim("0 remaining")} (${used}) — run \`vibedrift upgrade\` for more`];
}

