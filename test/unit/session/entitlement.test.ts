import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeEntitlement,
  readEntitlementCache,
  writeEntitlementCache,
  isCapturePermitted,
  shouldRefreshEntitlement,
  refreshEntitlementCache,
  ENTITLEMENT_TTL_MS,
  SESSION_TRIAL_LIMIT,
} from "@/session/entitlement";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-ent-")));

describe("computeEntitlement", () => {
  it("Pro/Enterprise are entitled regardless of trial", () => {
    expect(computeEntitlement("pro", 99, 5).reason).toBe("pro");
    expect(computeEntitlement("pro", 99, 5).entitled).toBe(true);
    expect(computeEntitlement("enterprise", 99, 5).entitled).toBe(true);
  });
  it("free with trial remaining is entitled on trial", () => {
    const e = computeEntitlement("free", 2, 5);
    expect(e).toMatchObject({ entitled: true, reason: "trial", trialUsed: 2, trialLimit: 5 });
  });
  it("free with the trial exhausted is locked", () => {
    const e = computeEntitlement("free", 5, 5);
    expect(e).toMatchObject({ entitled: false, reason: "locked" });
    expect(computeEntitlement("free", 6, 5).entitled).toBe(false);
  });
});

describe("entitlement cache", () => {
  it("round-trips and reads back", () => {
    const dir = tmp();
    writeEntitlementCache(dir, computeEntitlement("free", 3, 5));
    const back = readEntitlementCache(dir);
    expect(back).toMatchObject({ entitled: true, reason: "trial", trialUsed: 3 });
  });
  it("returns null when absent (no throw)", () => {
    expect(readEntitlementCache(tmp())).toBeNull();
  });
});

describe("isCapturePermitted (hook gate)", () => {
  it("permits capture when no cache exists yet (watch-session writes it first)", () => {
    expect(isCapturePermitted(tmp())).toBe(true);
  });
  it("permits capture when the cache says entitled", () => {
    const dir = tmp();
    writeEntitlementCache(dir, computeEntitlement("free", 1, 5));
    expect(isCapturePermitted(dir)).toBe(true);
  });
  it("BLOCKS capture when the cache says locked", () => {
    const dir = tmp();
    writeEntitlementCache(dir, computeEntitlement("free", 5, 5));
    expect(isCapturePermitted(dir)).toBe(false);
  });
});

describe("SESSION_TRIAL_LIMIT", () => {
  it("is 5 (decision 8)", () => {
    expect(SESSION_TRIAL_LIMIT).toBe(5);
  });
});

describe("writeEntitlementCache stamps checkedAt", () => {
  it("records when the server was last asked", () => {
    const dir = tmp();
    writeEntitlementCache(dir, computeEntitlement("free", 1, 5), () => 1_700_000_000_000);
    expect(readEntitlementCache(dir)?.checkedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("keeps an explicit checkedAt the caller already set", () => {
    const dir = tmp();
    const at = "2026-01-01T00:00:00.000Z";
    writeEntitlementCache(dir, { ...computeEntitlement("pro", 0, 5), checkedAt: at }, () => 999);
    expect(readEntitlementCache(dir)?.checkedAt).toBe(at);
  });
});

describe("shouldRefreshEntitlement (native-path refresh policy)", () => {
  const NOW = 1_700_000_000_000;

  it("refreshes when there is no cache at all", () => {
    expect(shouldRefreshEntitlement(null, NOW)).toBe(true);
  });

  it("does NOT refresh an entitled cache checked within the TTL", () => {
    const e = { ...computeEntitlement("free", 1, 5), checkedAt: new Date(NOW - 60_000).toISOString() };
    expect(shouldRefreshEntitlement(e, NOW)).toBe(false);
  });

  it("refreshes an entitled cache older than the TTL", () => {
    const stale = new Date(NOW - ENTITLEMENT_TTL_MS - 1).toISOString();
    const e = { ...computeEntitlement("free", 1, 5), checkedAt: stale };
    expect(shouldRefreshEntitlement(e, NOW)).toBe(true);
  });

  it("ALWAYS refreshes a locked cache, so upgrading to Pro unlocks promptly", () => {
    const e = { ...computeEntitlement("free", 5, 5), checkedAt: new Date(NOW).toISOString() };
    expect(e.reason).toBe("locked");
    expect(shouldRefreshEntitlement(e, NOW)).toBe(true);
  });

  it("refreshes a legacy cache that carries no checkedAt", () => {
    expect(shouldRefreshEntitlement(computeEntitlement("pro", 0, 5), NOW)).toBe(true);
  });

  it("refreshes when checkedAt is unparseable", () => {
    const e = { ...computeEntitlement("pro", 0, 5), checkedAt: "not-a-date" };
    expect(shouldRefreshEntitlement(e, NOW)).toBe(true);
  });

  it("refreshes when checkedAt is in the future (clock skew must not pin the cache)", () => {
    const e = { ...computeEntitlement("pro", 0, 5), checkedAt: new Date(NOW + 86_400_000).toISOString() };
    expect(shouldRefreshEntitlement(e, NOW)).toBe(true);
  });
});

describe("refreshEntitlementCache (the native path's cache owner)", () => {
  const NOW = 1_700_000_000_000;
  const server = (plan: "free" | "pro", used: number, limit = 5) => async () => ({
    plan,
    trial_used: used,
    trial_limit: limit,
  });

  it("asks the server and writes the cache when nothing is cached yet", async () => {
    const dir = tmp();
    let calls = 0;
    const e = await refreshEntitlementCache({
      baseDir: dir,
      now: () => NOW,
      fetch: async () => { calls++; return { plan: "free", trial_used: 2, trial_limit: 5 }; },
    });
    expect(calls).toBe(1);
    expect(e).toMatchObject({ entitled: true, reason: "trial", trialUsed: 2 });
    expect(readEntitlementCache(dir)).toMatchObject({ trialUsed: 2, checkedAt: new Date(NOW).toISOString() });
  });

  it("makes NO network call when a fresh entitled cache is present", async () => {
    const dir = tmp();
    writeEntitlementCache(dir, computeEntitlement("free", 1, 5), () => NOW);
    let calls = 0;
    const e = await refreshEntitlementCache({
      baseDir: dir,
      now: () => NOW + 60_000,
      fetch: async () => { calls++; return { plan: "free", trial_used: 4, trial_limit: 5 }; },
    });
    expect(calls).toBe(0);
    expect(e?.trialUsed).toBe(1);
  });

  it("re-asks once the cache goes stale", async () => {
    const dir = tmp();
    writeEntitlementCache(dir, computeEntitlement("free", 1, 5), () => NOW);
    const e = await refreshEntitlementCache({
      baseDir: dir,
      now: () => NOW + ENTITLEMENT_TTL_MS + 1,
      fetch: server("free", 4),
    });
    expect(e?.trialUsed).toBe(4);
  });

  it("locks the cache once the server reports the trial spent", async () => {
    const dir = tmp();
    const e = await refreshEntitlementCache({ baseDir: dir, now: () => NOW, fetch: server("free", 5) });
    expect(e).toMatchObject({ entitled: false, reason: "locked" });
    expect(isCapturePermitted(dir)).toBe(false);
  });

  it("unlocks a locked cache as soon as the account is Pro", async () => {
    const dir = tmp();
    writeEntitlementCache(dir, computeEntitlement("free", 5, 5), () => NOW);
    expect(isCapturePermitted(dir)).toBe(false);
    const e = await refreshEntitlementCache({ baseDir: dir, now: () => NOW, fetch: server("pro", 5) });
    expect(e).toMatchObject({ entitled: true, reason: "pro" });
    expect(isCapturePermitted(dir)).toBe(true);
  });

  it("keeps the existing cache when the server is unreachable (fail open, never lock on a network blip)", async () => {
    const dir = tmp();
    writeEntitlementCache(dir, computeEntitlement("free", 1, 5), () => NOW - ENTITLEMENT_TTL_MS - 1);
    const e = await refreshEntitlementCache({
      baseDir: dir,
      now: () => NOW,
      fetch: async () => { throw new Error("offline"); },
    });
    expect(e).toMatchObject({ entitled: true, trialUsed: 1 });
    expect(isCapturePermitted(dir)).toBe(true);
  });

  it("writes nothing when the server is unreachable and no cache exists", async () => {
    const dir = tmp();
    const e = await refreshEntitlementCache({
      baseDir: dir,
      now: () => NOW,
      fetch: async () => { throw new Error("offline"); },
    });
    expect(e).toBeNull();
    expect(readEntitlementCache(dir)).toBeNull();
    expect(isCapturePermitted(dir)).toBe(true); // still fails open
  });

  it("force re-asks even when the cache is fresh (the 402 path)", async () => {
    const dir = tmp();
    writeEntitlementCache(dir, computeEntitlement("free", 1, 5), () => NOW);
    const e = await refreshEntitlementCache({
      baseDir: dir,
      now: () => NOW,
      force: true,
      fetch: server("free", 5),
    });
    expect(e).toMatchObject({ entitled: false, reason: "locked" });
  });

  it("ignores a malformed server answer rather than corrupting the cache", async () => {
    const dir = tmp();
    writeEntitlementCache(dir, computeEntitlement("free", 1, 5), () => NOW);
    const e = await refreshEntitlementCache({
      baseDir: dir,
      now: () => NOW,
      force: true,
      fetch: async () => ({ plan: "free", trial_used: "lots", trial_limit: null } as unknown as {
        plan: "free"; trial_used: number; trial_limit: number;
      }),
    });
    expect(e).toMatchObject({ entitled: true, trialUsed: 1 });
    expect(readEntitlementCache(dir)?.trialUsed).toBe(1);
  });
});
