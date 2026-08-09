import { describe, it, expect } from "vitest";
import { buildDeepScanLines } from "../../../src/cli/commands/status.js";
import { buildLoginCreditsLines } from "../../../src/cli/commands/login.js";
import { hasUnspentMonthlyFreeScan } from "../../../src/auth/api.js";

/** Chalk styling is irrelevant to these assertions; strip it so the tests
 *  hold regardless of color level in the environment. (The escape byte is
 *  composed at runtime to keep control characters out of a regex literal.) */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function plain(lines: string[] | null): string {
  return (lines ?? []).join("\n").replace(ANSI, "");
}

/** The shape the deployed GET /account/credits actually returns
 *  (api/routes/account.py CreditsResponse), captured live 2026-08-08. */
const livePro = {
  plan: "pro",
  unlimited: false,
  deep_scans_this_month: 1,
  deep_scans_limit: 12,
  deep_scans_remaining: 197,
  has_free_deep_scan: true,
};

const liveFreeFresh = {
  plan: "free",
  unlimited: false,
  deep_scans_this_month: 0,
  deep_scans_limit: 1,
  deep_scans_remaining: 1,
  has_free_deep_scan: true,
};

const liveExhausted = {
  plan: "pro",
  unlimited: false,
  deep_scans_this_month: 12,
  deep_scans_limit: 12,
  deep_scans_remaining: 0,
  has_free_deep_scan: false,
};

const liveUnlimited = {
  plan: "enterprise",
  unlimited: true,
  deep_scans_this_month: 0,
  deep_scans_limit: -1,
  deep_scans_remaining: -1,
  has_free_deep_scan: true,
};

/** The OLD schema the CLI was written against; the deployed API no longer
 *  sends it. Rendering must skip rather than interpolate missing fields. */
const legacyShape = {
  plan: "pro",
  unlimited: false,
  available_total: 3,
  available_welcome: 1,
  available_purchased: 2,
  available_manual: 0,
  welcome_granted: true,
  welcome_consumed: false,
  has_free_deep_scan: true,
};

describe("status: buildDeepScanLines", () => {
  it("renders remaining/used/limit from the live API schema with no 'undefined'", () => {
    const out = plain(buildDeepScanLines(livePro));
    expect(out).toContain("197");
    expect(out).toContain("remaining");
    expect(out).toContain("1/12 used this period");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("free +");
  });

  it("skips entirely on the legacy schema instead of printing 'undefined'", () => {
    expect(buildDeepScanLines(legacyShape)).toEqual([]);
  });

  it("skips on malformed field types", () => {
    expect(buildDeepScanLines({ ...livePro, deep_scans_remaining: "197" })).toEqual([]);
    expect(buildDeepScanLines(null)).toEqual([]);
    expect(buildDeepScanLines("nope")).toEqual([]);
  });

  it("renders unlimited plans without numbers", () => {
    const out = plain(buildDeepScanLines(liveUnlimited));
    expect(out).toContain("unlimited");
    expect(out).not.toContain("-1");
  });

  it("nudges the free deep scan only on the free plan", () => {
    const free = plain(buildDeepScanLines(liveFreeFresh));
    expect(free).toContain("1 remaining");
    expect(free).toContain("0/1 used this period");
    expect(free).toContain("--deep");
    const pro = plain(buildDeepScanLines(livePro));
    expect(pro).not.toContain("free deep scan");
  });

  it("does not call top-up credits a free deep scan once the monthly one is spent", () => {
    const toppedUp = {
      plan: "free",
      unlimited: false,
      deep_scans_this_month: 1,
      deep_scans_limit: 1,
      deep_scans_remaining: 5,
      has_free_deep_scan: true,
    };
    const status = plain(buildDeepScanLines(toppedUp));
    expect(status).toContain("5 remaining");
    expect(status).not.toContain("free deep scan");
    const login = plain(buildLoginCreditsLines(toppedUp));
    expect(login).not.toContain("FREE deep scan every month");
    expect(login).toContain("5 deep scans remaining");
  });

  it("renders exhausted allowances with an upsell and no 'undefined'", () => {
    const out = plain(buildDeepScanLines(liveExhausted));
    expect(out).toContain("0 remaining");
    expect(out).toContain("vibedrift upgrade");
    expect(out).not.toContain("undefined");
  });
});

describe("login: buildLoginCreditsLines", () => {
  it("shows the remaining count for a Pro account, not the free-tier banner", () => {
    const out = plain(buildLoginCreditsLines(livePro));
    expect(out).toContain("197");
    expect(out).not.toContain("FREE deep scan every month");
    expect(out).not.toContain("undefined");
  });

  it("keeps the free-monthly banner for free accounts that can still deep scan", () => {
    const out = plain(buildLoginCreditsLines(liveFreeFresh));
    expect(out).toContain("FREE deep scan every month");
  });

  it("returns null on the legacy or malformed schema so the caller can fall back", () => {
    expect(buildLoginCreditsLines(legacyShape)).toBeNull();
    expect(buildLoginCreditsLines({ plan: "pro" })).toBeNull();
  });

  it("points exhausted accounts at upgrade with no 'undefined'", () => {
    const out = plain(buildLoginCreditsLines(liveExhausted));
    expect(out).toContain("vibedrift upgrade");
    expect(out).not.toContain("undefined");
  });
});

describe("hasUnspentMonthlyFreeScan (gates the scan-time 🎁 banner)", () => {
  it("is true only for a free plan whose monthly scan is unspent", () => {
    expect(hasUnspentMonthlyFreeScan(liveFreeFresh)).toBe(true);
  });

  it("is false for Pro — has_free_deep_scan means 'can scan now', not 'free-tier credit'", () => {
    expect(hasUnspentMonthlyFreeScan(livePro)).toBe(false);
  });

  it("is false for unlimited, spent-free, legacy, and malformed shapes", () => {
    expect(hasUnspentMonthlyFreeScan(liveUnlimited)).toBe(false);
    expect(
      hasUnspentMonthlyFreeScan({
        plan: "free",
        unlimited: false,
        deep_scans_this_month: 1,
        deep_scans_limit: 1,
        deep_scans_remaining: 5,
        has_free_deep_scan: true,
      }),
    ).toBe(false);
    expect(hasUnspentMonthlyFreeScan(legacyShape)).toBe(false);
    expect(hasUnspentMonthlyFreeScan(null)).toBe(false);
  });
});
