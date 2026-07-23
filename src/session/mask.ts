/**
 * Conservative secret masking applied to prompt text before every ledger
 * write. The ledger must never be the easiest place on the machine to steal a
 * key from. Biased toward high-confidence shapes: over-masking prose would
 * degrade the tape, so short/ambiguous values are deliberately left alone.
 *
 * (The analyzer's SECURITY_PATTERNS in src/analyzers/security.ts is
 * file-context-shaped and module-private; this is a dedicated prompt-text set.)
 */

const BLOCK_RULES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Provider API keys: sk-…, sk-ant-api03-…, sk-proj-…, sk_live_…, pk-…, rk_…
  // The key body legitimately contains internal hyphens/underscores (sk-ant-api03-),
  // so the run must allow them, not stop at the first hyphen.
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9](?:[A-Za-z0-9_-]{14,})[A-Za-z0-9]/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  // High-entropy, near-zero-false-positive vendor shapes that carry no key= prefix,
  // so KEYED_RULE never sees them: Slack (xoxb-/xoxp-/xoxa-/xoxr-/xoxs-), Google API
  // keys (AIza…), and granular npm tokens (npm_…).
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36,}/g,
];

// Credentials embedded in a connection string / URL userinfo
// (postgres://user:PASS@host, redis://:PASS@host, mongodb+srv://u:PASS@…). The
// password is not key=value shaped, so KEYED_RULE misses it; mask only the
// password, preserving the scheme + user for a still-useful, non-secret trace.
const URL_CRED_RULE = /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)([^\s/@]+)@/gi;

// key = value / key: value, where the value is >= 8 non-space chars.
// Group 1 captures the FULL identifier including any SNAKE_CASE prefix
// (OPENAI_API_KEY, DB_PASSWORD): `_` is a word character, so a `\b` before the
// bare keyword never matches inside `DB_PASSWORD` — the prefix run fixes that
// and is preserved in the replacement so only the value is masked.
const KEYED_RULE =
  /([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key))(\s*[:=]\s*)["']?[^\s"']{8,}["']?/gi;

export function maskSecrets(text: string): string {
  let out = text;
  for (const re of BLOCK_RULES) {
    out = out.replace(re, "[masked]");
  }
  // Mask only the password in a connection-string userinfo, preserving scheme+user.
  out = out.replace(URL_CRED_RULE, (_m, prefix: string) => `${prefix}[masked]@`);
  out = out.replace(KEYED_RULE, (_m, key: string, sep: string) => `${key}${sep}[masked]`);
  return out;
}
