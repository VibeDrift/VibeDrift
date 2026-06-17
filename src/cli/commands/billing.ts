import chalk from "chalk";
import { resolveToken } from "../../auth/resolver.js";
import { createPortalSession, VibeDriftApiError } from "../../auth/api.js";
import { readConfig } from "../../auth/config.js";
import { openInBrowser } from "../../auth/browser.js";

/**
 * `vibedrift billing` — open the Stripe Customer Portal.
 *
 * The server creates a one-time portal session URL bound to the
 * authenticated user's stripe_customer_id and returns it. We open
 * the URL (or print it if no browser is available).
 */
export async function runBilling(): Promise<void> {
  const resolved = await resolveToken();
  if (!resolved) {
    console.error(chalk.red("\n  ✗ Not logged in. Run `vibedrift login` first.\n"));
    process.exit(1);
  }

  const config = await readConfig();

  let portal;
  try {
    portal = await createPortalSession(resolved.token, { apiUrl: config.apiUrl });
  } catch (err) {
    if (err instanceof VibeDriftApiError) {
      if (err.status === 401) {
        console.error(chalk.red("\n  ✗ Your token is invalid or expired. Run `vibedrift login`.\n"));
        process.exit(1);
      }
      if (err.status === 402 || err.status === 404) {
        console.error(chalk.yellow("\n  ⚠ No billing account found for this user."));
        console.error(chalk.dim("    Run `vibedrift upgrade` to start a paid plan first.\n"));
        process.exit(1);
      }
    }
    console.error(chalk.red(`\n  ✗ Could not open billing portal: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  }

  console.log("");
  console.log(chalk.bold("  Stripe Customer Portal"));
  console.log("");
  console.log(`    ${chalk.cyan(portal.url)}`);
  console.log("");

  const opened = openInBrowser(portal.url);
  if (opened) {
    console.log(chalk.dim("  Opened in your browser. The link is single-use and expires shortly."));
  } else {
    console.log(chalk.dim("  Open the link above in your browser. It's single-use and expires shortly."));
  }
  console.log("");
}
