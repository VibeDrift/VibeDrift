import chalk from "chalk";
import { openInBrowser } from "../../auth/browser.js";

/**
 * `vibedrift upgrade` — open the pricing page in the browser.
 *
 * Distinct from `vibedrift --update` which upgrades the CLI binary.
 * "upgrade" is for the *plan*; "update" is for the *binary*.
 */
const PRICING_URL = "https://vibedrift.ai/pricing";

export async function runUpgrade(): Promise<void> {
  console.log("");
  console.log(chalk.bold("  Upgrade your VibeDrift plan"));
  console.log("");
  console.log(`    ${chalk.cyan(PRICING_URL)}`);
  console.log("");

  const opened = openInBrowser(PRICING_URL);
  if (opened) {
    console.log(chalk.dim("  Opened in your browser."));
  } else {
    console.log(chalk.dim("  Open the link above in your browser."));
  }
  console.log("");
  console.log(chalk.dim("  After upgrading, run `vibedrift login` to refresh your plan locally."));
  console.log("");
}
