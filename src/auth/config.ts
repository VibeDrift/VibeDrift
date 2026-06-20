import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, chmod, unlink, stat } from "fs/promises";

/**
 * VibeDrift CLI configuration storage.
 *
 * Stored at $HOME/.vibedrift/config.json with mode 0600 (user read/write only).
 * Holds the device-auth bearer token plus the plan/email/expiry that
 * vibedrift-api returned alongside it.
 *
 * NOTE: scan history (per-project deltas) lives at $HOME/.vibedrift/scans/
 * — see core/history.ts. The CLI should never write inside the user's
 * project directory.
 */

export interface VibeDriftConfig {
  /** Bearer token returned by /auth/poll. Opaque, server-generated. */
  token?: string;

  /** Email of the authenticated user (display only). */
  email?: string;

  /** "free" | "pro" | "enterprise" — last known plan, refreshed on each login. */
  plan?: "free" | "pro" | "enterprise";

  /** ISO-8601 timestamp the token expires (server-side enforcement is authoritative). */
  expiresAt?: string;

  /** ISO-8601 timestamp the user authenticated. */
  loggedInAt?: string;

  /** Override the API base URL (developers / staging only). Set via env or login --api. */
  apiUrl?: string;

  /** Stripe customer ID (display only — server is the source of truth). */
  stripeCustomerId?: string;

  /**
   * When true, the CLI sends a lightweight anonymous scan beacon on
   * every run (language, file_count, scan_time_ms, cli_version — no
   * code, no file paths, no PII). Set to false via `vibedrift
   * telemetry disable`. Default is true (opt-out model, same as
   * Next.js / Homebrew / VS Code).
   */
  telemetryEnabled?: boolean;

  /** Set to true after the first-run telemetry notice has been shown
   *  so the user doesn't see it on every scan. */
  telemetryNoticeShown?: boolean;

  /**
   * The scoring methodology version the user last acknowledged. When the
   * CLI's current SCORING_VERSION differs, a one-time "scoring refined"
   * notice is shown (linking release notes) and this is updated. Keeps the
   * user agnostic of internal versions — no per-scan banner. See
   * src/core/scoring-notice.ts.
   */
  lastSeenScoringVersion?: string;

  /**
   * ISO-8601 timestamp of the most recent SUCCESSFUL deep scan (the API
   * actually returned results). Written by `vibedrift . --deep`. Surfaced by
   * `vibedrift status` ("last deep scan: 5 days ago") and used by the
   * deep-scan nudge to phrase how long it has been. Absent = never deep-scanned.
   */
  lastDeepScanAt?: string;

  /**
   * ISO-8601 timestamp of the last time the MCP server surfaced a deep-scan
   * nudge. The nudge has a cooldown (it must not nag), so it reads this to stay
   * quiet for a day after firing. See src/mcp/nudge.ts.
   */
  lastNudgedAt?: string;
}

const DEFAULT_DIR = join(homedir(), ".vibedrift");
const DEFAULT_FILE = join(DEFAULT_DIR, "config.json");

export function getConfigDir(): string {
  return DEFAULT_DIR;
}

export function getConfigPath(): string {
  return DEFAULT_FILE;
}

export async function ensureConfigDir(): Promise<void> {
  await mkdir(DEFAULT_DIR, { recursive: true, mode: 0o700 });
}

export async function readConfig(): Promise<VibeDriftConfig> {
  try {
    const raw = await readFile(DEFAULT_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as VibeDriftConfig;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    // Corrupt config: don't crash, but warn loudly
    process.stderr.write(`vibedrift: warning — config at ${DEFAULT_FILE} is unreadable (${err?.message ?? err}). Treating as empty.\n`);
    return {};
  }
}

export async function writeConfig(config: VibeDriftConfig): Promise<void> {
  await ensureConfigDir();
  const json = JSON.stringify(config, null, 2);
  await writeFile(DEFAULT_FILE, json, { mode: 0o600 });
  // Belt and braces — ensure mode in case the file already existed with wrong perms.
  try {
    await chmod(DEFAULT_FILE, 0o600);
  } catch {
    // Best-effort only (e.g. on Windows)
  }
}

export async function clearConfig(): Promise<void> {
  try {
    await unlink(DEFAULT_FILE);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

export async function configExists(): Promise<boolean> {
  try {
    await stat(DEFAULT_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Update specific fields without clobbering the rest of the config.
 * Reads, merges, writes.
 */
export async function patchConfig(patch: Partial<VibeDriftConfig>): Promise<VibeDriftConfig> {
  const current = await readConfig();
  const next: VibeDriftConfig = { ...current, ...patch };
  await writeConfig(next);
  return next;
}
