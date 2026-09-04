import { readConfig, getConfigPath } from "./config.js";

/**
 * Token resolution.
 *
 * Priority order (highest first):
 *   1. Explicit CLI flag (--token / --ml-key, kept temporarily for back-compat)
 *   2. VIBEDRIFT_TOKEN environment variable
 *   3. ~/.vibedrift/config.json `token` field
 *
 * Returns null if no token is configured anywhere. Callers decide whether
 * to error, fall back to anonymous mode, or print an actionable message.
 */

export interface TokenResolutionInput {
  explicitToken?: string;
}

export interface ResolvedToken {
  token: string;
  source: "flag" | "env" | "config";
}

export async function resolveToken(input: TokenResolutionInput = {}): Promise<ResolvedToken | null> {
  if (input.explicitToken && input.explicitToken.trim().length > 0) {
    return { token: input.explicitToken.trim(), source: "flag" };
  }

  const fromEnv = process.env.VIBEDRIFT_TOKEN;
  if (fromEnv && fromEnv.trim().length > 0) {
    return { token: fromEnv.trim(), source: "env" };
  }

  const config = await readConfig();
  if (config.token && config.token.trim().length > 0) {
    return { token: config.token.trim(), source: "config" };
  }

  return null;
}

const DEFAULT_API_URL = "https://vibedrift-api.fly.dev";
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Guard against sending the Bearer token to a plaintext endpoint. An
 * `apiUrl` override can come from a CLI flag, an env var, or the on-disk
 * config — any of which could be attacker- or mistake-controlled (a bad
 * copy-paste, a compromised dotfile, a malicious wrapper script) — and every
 * `resolveToken`-derived Bearer token gets sent to whatever URL this
 * resolves to. `http://` to anything but localhost ships the token in the
 * clear over the network, so it's refused outright rather than silently
 * downgraded. Throws `TypeError` (via `new URL`) for a genuinely malformed
 * URL, which callers already need to handle.
 */
function assertSafeApiUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") return url;
  if (parsed.protocol === "http:" && LOCALHOST_HOSTNAMES.has(parsed.hostname)) return url;
  throw new Error(
    `vibedrift: refusing to send credentials to insecure API URL "${url}" — ` +
      `use https:// (or http://localhost / http://127.0.0.1 for local development).`,
  );
}

/**
 * API base URL resolution.
 *
 *   1. Explicit CLI flag (--api-url)
 *   2. VIBEDRIFT_API_URL environment variable
 *   3. ~/.vibedrift/config.json `apiUrl` field
 *   4. Built-in default (production)
 *
 * Any override (flags 1-3) is validated by `assertSafeApiUrl` and warned
 * about loudly — the Bearer token is sent to this URL on every API call, so
 * a non-default endpoint is a meaningful trust boundary the user should
 * notice, not a silent redirect.
 */
export async function resolveApiUrl(explicitUrl?: string): Promise<string> {
  if (explicitUrl && explicitUrl.trim().length > 0) {
    const url = assertSafeApiUrl(explicitUrl.trim());
    warnNonDefaultApiUrl(url, "--api-url flag");
    return url;
  }
  if (process.env.VIBEDRIFT_API_URL && process.env.VIBEDRIFT_API_URL.trim().length > 0) {
    const url = assertSafeApiUrl(process.env.VIBEDRIFT_API_URL.trim());
    warnNonDefaultApiUrl(url, "VIBEDRIFT_API_URL");
    return url;
  }
  const config = await readConfig();
  if (config.apiUrl && config.apiUrl.trim().length > 0) {
    const url = assertSafeApiUrl(config.apiUrl.trim());
    warnNonDefaultApiUrl(url, getConfigPath());
    return url;
  }
  return DEFAULT_API_URL;
}

/** Mirrors the existing config.ts warn-loudly-to-stderr pattern. */
function warnNonDefaultApiUrl(url: string, source: string): void {
  if (url === DEFAULT_API_URL) return;
  process.stderr.write(
    `vibedrift: warning — using non-default API URL "${url}" (from ${source}). ` +
      `The auth token is sent to this endpoint.\n`,
  );
}

/**
 * Display-friendly token preview ("vd_live_a3x...").
 * Shows the **prefix** (not the suffix) so users can tell which key they're
 * using without leaking enough entropy to be useful to an attacker.
 */
export function previewToken(token: string): string {
  if (!token) return "(none)";
  if (token.length <= 12) return token.slice(0, 4) + "…";
  return token.slice(0, 12) + "…";
}

/** Human-readable label for the token source. Shared by status + doctor. */
export function describeSource(source: "flag" | "env" | "config"): string {
  switch (source) {
    case "flag":   return "command-line flag";
    case "env":    return "VIBEDRIFT_TOKEN environment variable";
    case "config": return getConfigPath();
  }
}
