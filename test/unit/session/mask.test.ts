import { describe, it, expect } from "vitest";
import { maskSecrets } from "@/session/mask";

// Fake secret fixtures assembled from split parts so no contiguous secret-shaped
// literal ever appears in source. These are dummy values (not real keys); the
// split keeps automated secret scanners quiet while the masker still receives the
// fully-assembled string and must catch it.
const j = (...parts: string[]): string => parts.join("");
const STRIPE = j("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc");
const ANTHROPIC = j("sk-", "ant-", "api03-", "AbCdEf012345678901234567890XyZ");
const OPENAI_PROJ = j("sk-", "proj-", "abcDEF1234567890ghiJKL");
const OPENAI_PROJ2 = j("sk-", "proj-", "abcdefghijklmnop");
const GH_TOKEN = j("ghp", "_", "abcdefghijklmnopqrstuvwxyz123456");
const SLACK = j("xox", "b-", "2401234567-2409876543210-AbCdEfGhIjKlMnOpQrStUvWx");
const GOOGLE = j("AIza", "SyD1234567890abcdefghijklmnopqrstuv");
const NPM = j("npm", "_", "abcdefghijklmnopqrstuvwxyz0123456789");
const AWS = j("AKIA", "IOSFODNN7EXAMPLE"); // AWS's official docs example key
const JWT = j("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".abcde.fghij");
const JWT2 = j("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4");

describe("maskSecrets", () => {
  it("masks common secret shapes", () => {
    const s = maskSecrets(`use ${AWS} and api_key=abcd1234efgh5678 plus Bearer ${JWT} and ${STRIPE}`);
    expect(s).not.toContain(AWS);
    expect(s).not.toContain("abcd1234efgh5678");
    expect(s).not.toContain(STRIPE);
    expect(s).toContain("[masked]");
  });

  it("keeps the key name when masking key=value shapes", () => {
    expect(maskSecrets("password: hunter2hunter2")).toContain("password");
    expect(maskSecrets("password: hunter2hunter2")).not.toContain("hunter2hunter2");
  });

  it("masks provider keys with internal hyphens (Anthropic, OpenAI project)", () => {
    const s = maskSecrets(`keys: ${ANTHROPIC} and ${OPENAI_PROJ}`);
    expect(s).not.toContain(ANTHROPIC);
    expect(s).not.toContain(OPENAI_PROJ);
  });

  it("masks SNAKE_CASE env-var secrets (leading prefix, no word boundary)", () => {
    for (const t of [
      `OPENAI_API_KEY=${OPENAI_PROJ2}`,
      "DB_PASSWORD=hunter2hunter2",
      "MY_SERVICE_SECRET: averylongsecretvalue",
    ]) {
      const m = maskSecrets(t);
      expect(m).toContain("[masked]");
      expect(m).not.toMatch(/hunter2hunter2|averylongsecretvalue|abcdefghijklmnop/);
    }
    // the identifier itself is preserved, only the value is masked
    expect(maskSecrets("DB_PASSWORD=hunter2hunter2")).toContain("DB_PASSWORD");
  });

  it("masks GitHub tokens and JWTs", () => {
    const s = maskSecrets(`${GH_TOKEN} ${JWT2}`);
    expect(s).not.toContain(GH_TOKEN);
    expect(s).not.toContain(JWT2);
  });

  it("masks the password in a connection-string URL, keeping scheme + user", () => {
    for (const [dsn, secret] of [
      ["postgres://admin:hunter2secret@db.internal:5432/prod", "hunter2secret"],
      ["mongodb+srv://root:S3cretP4ss@cluster0.mongodb.net/db", "S3cretP4ss"],
      ["redis://:MyR3disPassw0rd@cache.internal:6379", "MyR3disPassw0rd"],
    ] as const) {
      const m = maskSecrets(`the DSN is ${dsn} btw`);
      expect(m).not.toContain(secret);
      expect(m).toContain("[masked]");
    }
    // the non-secret structure survives for a still-useful trace
    expect(maskSecrets("postgres://admin:hunter2secret@db.internal/prod")).toContain(
      "postgres://admin:[masked]@db.internal/prod",
    );
  });

  it("masks unprefixed vendor tokens (Slack, Google API key, npm)", () => {
    for (const t of [SLACK, GOOGLE, NPM]) {
      const m = maskSecrets(`token: ${t}`);
      expect(m).toContain("[masked]");
      expect(m).not.toContain(t);
    }
  });

  it("masks PEM private key blocks entirely", () => {
    const t = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
    expect(maskSecrets(t)).toBe("[masked]");
  });

  it("leaves normal prose and code identifiers alone", () => {
    const t = "add Stripe webhook handling to routes/billing.ts using handleStripeWebhook and requireAuth";
    expect(maskSecrets(t)).toBe(t);
  });

  it("leaves short values after key names alone (low-risk, avoids over-masking)", () => {
    const t = "set token: abc123 in the test fixture";
    expect(maskSecrets(t)).toBe(t);
  });
});
