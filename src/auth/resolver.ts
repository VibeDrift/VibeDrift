import { readConfig } from "./config.js";

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

/**
 * API base URL resolution.
 *
 *   1. Explicit CLI flag (--api-url)
 *   2. VIBEDRIFT_API_URL environment variable
 *   3. ~/.vibedrift/config.json `apiUrl` field
 *   4. Built-in default (production)
 */
export async function resolveApiUrl(explicitUrl?: string): Promise<string> {
  if (explicitUrl && explicitUrl.trim().length > 0) return explicitUrl.trim();
  if (process.env.VIBEDRIFT_API_URL && process.env.VIBEDRIFT_API_URL.trim().length > 0) {
    return process.env.VIBEDRIFT_API_URL.trim();
  }
  const config = await readConfig();
  if (config.apiUrl && config.apiUrl.trim().length > 0) return config.apiUrl.trim();
  return "https://vibedrift-api.fly.dev";
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
    case "config": return "~/.vibedrift/config.json";
  }
}
