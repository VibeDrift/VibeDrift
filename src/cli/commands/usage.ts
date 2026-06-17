import chalk from "chalk";
import { resolveToken } from "../../auth/resolver.js";
import { fetchUsage, VibeDriftApiError } from "../../auth/api.js";
import { readConfig } from "../../auth/config.js";

/**
 * `vibedrift usage` — show current-period scan counts and rate limits.
 *
 * Limits are plan-dependent and resolved server-side; deep scans are
 * rate-limited to 60 requests per minute.
 */
export async function runUsage(): Promise<void> {
  const resolved = await resolveToken();
  if (!resolved) {
    console.error(chalk.red("\n  ✗ Not logged in. Run `vibedrift login` first.\n"));
    process.exit(1);
  }

  const config = await readConfig();
  let data;
  try {
    data = await fetchUsage(resolved.token, { apiUrl: config.apiUrl });
  } catch (err) {
    if (err instanceof VibeDriftApiError && err.status === 401) {
      console.error(chalk.red("\n  ✗ Your token is invalid or expired. Run `vibedrift login` to re-authenticate.\n"));
      process.exit(1);
    }
    console.error(chalk.red(`\n  ✗ Could not fetch usage: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }

  console.log("");
  console.log(chalk.bold("  Account"));
  console.log(`    Email:   ${chalk.bold(data.user.email)}`);
  console.log(`    Plan:    ${chalk.bold(data.user.plan)}`);
  console.log("");

  console.log(chalk.bold("  Current period"));
  console.log(`    From:    ${chalk.dim(formatDate(data.current_period.start))}`);
  console.log(`    To:      ${chalk.dim(formatDate(data.current_period.end))}`);
  console.log(`    Scans:   ${chalk.bold(data.current_period.scans.toString())}`);
  console.log(`    Deep:    ${chalk.bold(data.current_period.deep_scans.toString())}`);
  console.log("");

  console.log(chalk.bold("  Limits"));
  const deepLimit = data.limits.deep_scans_per_month;
  console.log(`    Deep:    ${deepLimit === null ? chalk.green("unlimited") : `${deepLimit}/month`}`);
  console.log(`    Rate:    ${data.limits.rate_limit_per_min} requests/minute`);
  console.log("");

  if (data.recent_scans.length > 0) {
    console.log(chalk.bold(`  Recent scans (${data.recent_scans.length})`));
    for (const scan of data.recent_scans.slice(0, 10)) {
      const flag = scan.is_deep ? chalk.cyan("deep") : chalk.dim("std ");
      const score = scan.score === null ? chalk.dim("—") : chalk.bold(String(Math.round(scan.score))).padEnd(3);
      console.log(`    ${flag}  ${score}  ${chalk.dim(formatDateTime(scan.created_at))}  ${chalk.dim(scan.project_hash.slice(0, 12))}`);
    }
    console.log("");
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch { return iso; }
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 16).replace("T", " ");
  } catch { return iso; }
}
