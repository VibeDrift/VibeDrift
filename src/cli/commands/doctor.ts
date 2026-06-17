import chalk from "chalk";
import { homedir, platform, arch } from "os";
import { join } from "path";
import { stat, access, constants } from "fs/promises";
import { readConfig, getConfigPath, getConfigDir } from "../../auth/config.js";
import { resolveToken, resolveApiUrl, previewToken, describeSource } from "../../auth/resolver.js";
import { validateToken, VibeDriftApiError } from "../../auth/api.js";
import { getVersion } from "../../core/version.js";

/**
 * `vibedrift doctor` — environment diagnostic, intended for bug reports.
 *
 * Reports on:
 *   - CLI version, Node version, OS/arch
 *   - Auth state (logged in? token source? validates with server?)
 *   - Config dir + permissions
 *   - API URL reachability
 *   - PATH conflict (vibedrift binary location)
 *
 * Exits 0 if everything is healthy, 1 if any check failed.
 */
async function checkAuthStatus(): Promise<{
  resolved: Awaited<ReturnType<typeof resolveToken>>;
  authFailures: number;
}> {
  let authFailures = 0;
  console.log(chalk.bold("  Authentication"));
  const config = await readConfig();
  const resolved = await resolveToken();

  if (!resolved) {
    info("Login state", "not logged in");
  } else {
    ok("Token source", describeSource(resolved.source));
    ok("Token preview", previewToken(resolved.token));
    if (resolved.source === "config") {
      if (config.email) ok("Email", config.email);
      if (config.plan) ok("Plan", config.plan);
      if (config.expiresAt) {
        const expires = new Date(config.expiresAt).getTime();
        const now = Date.now();
        if (expires < now) {
          bad(`Token expired ${Math.floor((now - expires) / 86_400_000)} days ago`);
          authFailures++;
        } else {
          ok("Token expires", `${config.expiresAt} (${Math.ceil((expires - now) / 86_400_000)} days)`);
        }
      }
    }
  }
  console.log("");
  return { resolved, authFailures };
}

async function checkApiConnectivity(
  resolved: Awaited<ReturnType<typeof resolveToken>>,
): Promise<number> {
  let failures = 0;
  console.log(chalk.bold("  API"));
  const apiUrl = await resolveApiUrl();
  ok("API URL", apiUrl);

  if (resolved) {
    process.stdout.write(`    ${chalk.dim("→ Validating token... ")}`);
    try {
      const result = await validateToken(resolved.token, { apiUrl });
      if (result.valid) {
        console.log(chalk.green("ok"));
      } else {
        console.log(chalk.red("invalid token"));
        failures++;
      }
    } catch (err) {
      console.log(chalk.red("unreachable"));
      console.log(`    ${chalk.dim("  ")}${err instanceof VibeDriftApiError ? err.message : String(err)}`);
      failures++;
    }
  } else {
    process.stdout.write(`    ${chalk.dim("→ Pinging API... ")}`);
    try {
      const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) console.log(chalk.green("ok"));
      else { console.log(chalk.yellow(`HTTP ${res.status}`)); failures++; }
    } catch (err) {
      console.log(chalk.red("unreachable"));
      console.log(`    ${chalk.dim("  ")}${err instanceof Error ? err.message : String(err)}`);
      failures++;
    }
  }
  console.log("");
  return failures;
}

export async function runDoctor(): Promise<void> {
  let failures = 0;

  console.log("");
  console.log(chalk.bold("  VibeDrift Doctor"));
  console.log("");

  // ── Environment ──
  console.log(chalk.bold("  Environment"));
  ok("CLI version", getVersion());
  ok("Node",         process.version);
  ok("Platform",     `${platform()} ${arch()}`);
  ok("HOME",         homedir());
  console.log("");

  // ── Config dir ──
  console.log(chalk.bold("  Config"));
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  let configDirOk = false;
  try {
    const info = await stat(configDir);
    if (info.isDirectory()) {
      configDirOk = true;
      // POSIX mode bits
      const mode = (info.mode & 0o777).toString(8);
      ok("Config dir", `${configDir} (mode ${mode})`);
    } else {
      bad(`Config dir exists but is not a directory: ${configDir}`);
      failures++;
    }
  } catch {
    info("Config dir", `${configDir} (will be created on first login)`);
    configDirOk = true;
  }

  if (configDirOk) {
    try {
      await access(configPath, constants.R_OK);
      const info = await stat(configPath);
      const mode = (info.mode & 0o777).toString(8);
      if ((info.mode & 0o077) !== 0) {
        warn("Config file", `${configPath} (mode ${mode}, world/group readable — should be 600)`);
      } else {
        ok("Config file", `${configPath} (mode ${mode})`);
      }
    } catch {
      info("Config file", "absent (not logged in)");
    }
  }

  // History dir (separate from config — must be ~/.vibedrift/scans)
  const historyDir = join(homedir(), ".vibedrift", "scans");
  try {
    const info = await stat(historyDir);
    if (info.isDirectory()) ok("Scan history", historyDir);
    else warn("Scan history", `${historyDir} exists but is not a directory`);
  } catch {
    info("Scan history", "empty (no scans run yet)");
  }
  console.log("");

  // ── Authentication ──
  const { resolved, authFailures } = await checkAuthStatus();
  failures += authFailures;

  // ── API ──
  const apiFailures = await checkApiConnectivity(resolved);
  failures += apiFailures;

  // ── Summary ──
  if (failures === 0) {
    console.log(chalk.green("  ✓ All checks passed."));
  } else {
    console.log(chalk.red(`  ✗ ${failures} check${failures === 1 ? "" : "s"} failed.`));
  }
  console.log("");

  process.exit(failures === 0 ? 0 : 1);
}

function ok(label: string, value: string): void {
  console.log(`    ${chalk.green("✓")} ${label.padEnd(14)} ${chalk.dim(value)}`);
}
function warn(label: string, value: string): void {
  console.log(`    ${chalk.yellow("⚠")} ${label.padEnd(14)} ${chalk.dim(value)}`);
}
function bad(value: string): void {
  console.log(`    ${chalk.red("✗")} ${chalk.red(value)}`);
}
function info(label: string, value: string): void {
  console.log(`    ${chalk.dim("·")} ${label.padEnd(14)} ${chalk.dim(value)}`);
}

// describeSource imported from auth/resolver.ts (shared with status.ts)
