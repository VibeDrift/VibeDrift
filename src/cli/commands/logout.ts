import chalk from "chalk";
import { clearConfig, readConfig } from "../../auth/config.js";
import { revokeToken, VibeDriftApiError } from "../../auth/api.js";

/**
 * Logout: revoke the token server-side and remove the local config file.
 *
 * Local removal happens unconditionally even if the server revoke fails,
 * so users can always recover from a stale/broken token by running
 * `vibedrift logout`. The server revoke is best-effort.
 */
export async function runLogout(): Promise<void> {
  const config = await readConfig();

  if (!config.token) {
    console.log(chalk.dim("  Not logged in. Nothing to do."));
    return;
  }

  // Best-effort server revoke
  try {
    await revokeToken(config.token, { apiUrl: config.apiUrl });
  } catch (err) {
    if (err instanceof VibeDriftApiError && (err.status === 401 || err.status === 404)) {
      // Token was already revoked or unknown — fine, treat as success.
    } else {
      console.warn(
        chalk.yellow(
          `  ⚠ Could not revoke token on the server: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      console.warn(chalk.dim("    Local token will still be removed."));
    }
  }

  await clearConfig();
  console.log(chalk.green("  ✓ Logged out."));
}
