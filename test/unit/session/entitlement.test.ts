import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeEntitlement,
  readEntitlementCache,
  writeEntitlementCache,
  isCapturePermitted,
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
