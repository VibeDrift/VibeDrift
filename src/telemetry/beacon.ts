/**
 * Lightweight anonymous scan beacon.
 *
 * Fires a single POST on every scan with minimal, non-identifying metadata.
 * No code, no file paths, no PII. Opt-out via `vibedrift telemetry disable`.
 *
 * Payload: { language, file_count, loc, scan_time_ms, cli_version,
 *            is_deep, has_git, has_intent_hints, finding_count, score }
 *
 * The beacon is best-effort — failures are silently ignored. It should
 * never delay or affect the scan result. All network calls respect the
 * `--local-only` flag (skip when set).
 */

import { getVersion } from "../core/version.js";
import { readConfig, patchConfig } from "../auth/config.js";
import { resolveApiUrl } from "../auth/resolver.js";

const BEACON_TIMEOUT_MS = 3000;

export interface ScanBeaconPayload {
  language: string | null;
  file_count: number;
  /** Total lines of code scanned (sum of per-file line counts). Repo-size
   *  signal for KPIs and the public benchmark — no code, no paths. */
  loc: number;
  scan_time_ms: number;
  cli_version: string;
  is_deep: boolean;
  has_git: boolean;
  has_intent_hints: boolean;
  finding_count: number;
  score: number;
}

/**
 * Build the anonymous scan beacon payload from a finished scan. Pure +
 * exported so the field mapping (notably `loc` from `context.totalLines`,
 * already computed during discovery) is unit-testable without firing a
 * network call.
 */
export function buildScanBeaconPayload(
  result: {
    context: {
      dominantLanguage: string | null;
      files: unknown[];
      totalLines: number;
      hasGitMetadata?: boolean;
      intentHints?: unknown[];
    };
    scanTimeMs: number;
    findings: unknown[];
    compositeScore: number;
  },
  opts: { cliVersion: string; isDeep: boolean },
): ScanBeaconPayload {
  return {
    language: result.context.dominantLanguage,
    file_count: result.context.files.length,
    loc: result.context.totalLines,
    scan_time_ms: result.scanTimeMs,
    cli_version: opts.cliVersion,
    is_deep: opts.isDeep,
    has_git: result.context.hasGitMetadata ?? false,
    has_intent_hints: (result.context.intentHints?.length ?? 0) > 0,
    finding_count: result.findings.length,
    score: result.compositeScore,
  };
}

export async function isTelemetryEnabled(): Promise<boolean> {
  const config = await readConfig();
  return config.telemetryEnabled !== false;
}

export async function showFirstRunNoticeIfNeeded(): Promise<void> {
  const config = await readConfig();
  if (config.telemetryNoticeShown) return;

  process.stderr.write(
    "\n" +
    "  \x1b[33mVibeDrift collects anonymous scan statistics\x1b[0m (language, file count,\n" +
    "  scan time — no code, no file paths). This helps us improve the tool.\n" +
    "  Run \x1b[1mvibedrift telemetry disable\x1b[0m to opt out.\n" +
    "  Learn more: https://vibedrift.ai/privacy\n\n",
  );

  await patchConfig({ telemetryNoticeShown: true });
}

export async function sendScanBeacon(
  payload: ScanBeaconPayload,
  apiUrl?: string,
): Promise<void> {
  const enabled = await isTelemetryEnabled();
  if (!enabled) return;

  const base = apiUrl ?? (await resolveApiUrl()) ?? "https://vibedrift-api.fly.dev";
  const url = `${base}/v1/beacon/scan`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BEACON_TIMEOUT_MS);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {
    // Best-effort — never block or error the scan
  }
}

/**
 * Report-open beacon. Fires from the HTML report when a logged-in user
 * opens it in a browser. Called by the embedded <script> block. Only
 * fires if the report carries a scan_id (logged-in scans).
 */
export async function sendReportOpenBeacon(
  scanId: string,
  bearerToken: string,
  apiUrl?: string,
): Promise<void> {
  const base = apiUrl ?? "https://vibedrift-api.fly.dev";
  const url = `${base}/v1/beacon/report-open`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BEACON_TIMEOUT_MS);
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ scan_id: scanId, opened_at: new Date().toISOString() }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {
    // Best-effort
  }
}
