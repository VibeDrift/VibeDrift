import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Deterministic telemetry-enabled state for the network-call tests below:
// isTelemetryEnabled() reads the real user config otherwise, which would make
// "does it call fetch" tests depend on whatever is on the machine running
// them.
vi.mock("../../../src/auth/config.js", async (orig) => {
  const actual = await orig<typeof import("../../../src/auth/config.js")>();
  return { ...actual, readConfig: vi.fn(async () => ({ telemetryEnabled: true })) };
});

import { buildScanBeaconPayload, sendScanBeacon } from "../../../src/telemetry/beacon.js";

const payload = {
  language: null,
  file_count: 0,
  loc: 0,
  scan_time_ms: 0,
  cli_version: "9.9.9",
  is_deep: false,
  has_git: false,
  has_intent_hints: false,
  finding_count: 0,
  score: 0,
  authed: false,
};

describe("buildScanBeaconPayload", () => {
  const baseResult = {
    context: {
      dominantLanguage: "typescript",
      files: [{}, {}, {}],
      totalLines: 4200,
      hasGitMetadata: true,
      intentHints: [{ confidence: 0.7 }],
    },
    scanTimeMs: 1234,
    findings: [{}, {}],
    compositeScore: 81,
  };

  it("carries lines-of-code from context.totalLines as `loc`", () => {
    const p = buildScanBeaconPayload(baseResult as any, { cliVersion: "9.9.9", isDeep: false, authed: false });
    expect(p.loc).toBe(4200);
  });

  it("preserves the existing beacon fields", () => {
    const p = buildScanBeaconPayload(baseResult as any, { cliVersion: "9.9.9", isDeep: true, authed: true });
    expect(p.file_count).toBe(3);
    expect(p.language).toBe("typescript");
    expect(p.is_deep).toBe(true);
    expect(p.has_git).toBe(true);
    expect(p.has_intent_hints).toBe(true);
    expect(p.finding_count).toBe(2);
    expect(p.score).toBe(81);
    expect(p.cli_version).toBe("9.9.9");
    expect(p.authed).toBe(true);
  });

  it("marks signed-out scans with authed=false (anonymous, no identifier)", () => {
    const p = buildScanBeaconPayload(baseResult as any, { cliVersion: "9.9.9", isDeep: false, authed: false });
    expect(p.authed).toBe(false);
  });

  it("reports loc 0 for an empty scan", () => {
    const p = buildScanBeaconPayload(
      { context: { dominantLanguage: null, files: [], totalLines: 0 }, scanTimeMs: 5, findings: [], compositeScore: 100 } as any,
      { cliVersion: "9.9.9", isDeep: false, authed: false },
    );
    expect(p.loc).toBe(0);
  });
});

describe("sendScanBeacon: no timer leak on a rejected fetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.VIBEDRIFT_TELEMETRY_DISABLED;
  });

  // The bug: clearTimeout only ran on the success path, so a rejected fetch
  // (offline, DNS failure, connection refused) left the ref'd abort timer
  // pending for up to BEACON_TIMEOUT_MS — keeping the event loop alive and
  // hanging `vibedrift scan` when run offline, since scan.ts calls this
  // unawaited with no process.exit on the success path.
  it("sendScanBeacon clears the abort timer even when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
    await sendScanBeacon(payload, "http://127.0.0.1:1/never");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sendScanBeacon also clears the timer on the success path (no regression)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));
    await sendScanBeacon(payload, "http://127.0.0.1:1/never");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("sendScanBeacon: never rejects (P1)", () => {
  const prevApiUrl = process.env.VIBEDRIFT_API_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevApiUrl === undefined) delete process.env.VIBEDRIFT_API_URL;
    else process.env.VIBEDRIFT_API_URL = prevApiUrl;
  });

  // The bug: resolveApiUrl() throws on a non-https or malformed override, and
  // it was awaited OUTSIDE the try/catch. scan.ts fires the beacon as
  // `void sendScanBeacon(...)`, so the throw became an unhandled promise
  // rejection that killed every scan — free, signed-out, local ones included —
  // for anyone with a stale VIBEDRIFT_API_URL or config apiUrl.
  it("resolves (and skips fetch) when VIBEDRIFT_API_URL is non-https", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    process.env.VIBEDRIFT_API_URL = "http://evil.example";
    await expect(sendScanBeacon(payload)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves (and skips fetch) when VIBEDRIFT_API_URL is not a URL at all", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    process.env.VIBEDRIFT_API_URL = "not a url";
    await expect(sendScanBeacon(payload)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves when the telemetry-enabled check itself throws", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const { readConfig } = await import("../../../src/auth/config.js");
    vi.mocked(readConfig).mockRejectedValueOnce(new Error("EACCES: config unreadable"));
    await expect(sendScanBeacon(payload, "https://127.0.0.1:1/never")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
