import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ScanResult, ScanOptions } from "../../../src/core/types.js";

// Each test dynamically imports scan.js (a heavy module graph) inside its
// body; under a fully parallel suite run that import alone can exceed the 5s
// default test timeout, so give these tests real headroom.
vi.setConfig({ testTimeout: 20_000 });

// These tests exercise serveHtmlReportOnLocalhost's real net.Server binding
// and logAndRender's exit-code decision — not the report's own HTML/terminal
// rendering (owned elsewhere, and requiring a fully realistic AnalysisContext
// to render without throwing). Stub the renderers so a minimal ScanResult is
// enough to drive the code paths under test.
vi.mock("../../../src/output/terminal.js", () => ({
  renderTerminalOutput: vi.fn(() => "terminal-output"),
  renderConciseSummary: vi.fn(() => "concise-summary"),
  renderJsonOutput: vi.fn(() => "{}"),
  renderStarCta: vi.fn(() => [] as string[]),
  renderDashboardLink: vi.fn(() => "dashboard-link"),
  renderLocalReportLink: vi.fn(() => "local-report-link"),
  DASHBOARD_SPINNER_TEXT: "Generating your dashboard link…",
  DASHBOARD_SPINNER_SUCCESS_SYMBOL: "✓",
}));
vi.mock("../../../src/output/html.js", () => ({
  renderHtmlReport: vi.fn(() => "<html></html>"),
}));

function category(score: number) {
  return { score, maxScore: 20, locked: false, findingCount: 0, applicable: true };
}

function makeResult(compositeScore = 80): ScanResult {
  const scores = {
    architecturalConsistency: category(16),
    redundancy: category(16),
    dependencyHealth: category(16),
    securityPosture: category(16),
    intentClarity: category(16),
  };
  return {
    version: "0.0.0-test",
    project: "/tmp/demo",
    findings: [],
    compositeScore,
    maxCompositeScore: 100,
    scanTimeMs: 12,
    scores,
    hygieneScores: scores,
    hygieneScore: 80,
    maxHygieneScore: 100,
    deepInsights: [],
    teaseMessages: [],
    perFileScores: new Map(),
    context: {
      rootDir: "/tmp/demo",
      files: [],
      totalLines: 100,
      dominantLanguage: "typescript",
    } as any,
  } as unknown as ScanResult;
}

// ────────────────────────────────────────────────────────────────────
// Regression: the local report server used to bind 0.0.0.0 (all
// interfaces), exposing the scan report (file paths + code snippets) to
// anyone on the same LAN. It must bind loopback only.
// ────────────────────────────────────────────────────────────────────
describe("serveHtmlReportOnLocalhost — binds loopback only", () => {
  beforeEach(() => {
    // The server installs a real 10-minute auto-close setTimeout and a
    // process-level SIGINT handler. Fake timers stop that setTimeout from
    // ever becoming a real, unref'd-by-nobody OS timer that could otherwise
    // outlive this test (and, worst case, fire `process.exit` minutes into
    // an unrelated later test run).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.removeAllListeners("SIGINT");
  });

  it("listens on 127.0.0.1, never on all interfaces", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { __test_serveHtmlReportOnLocalhost } = await import("../../../src/cli/commands/scan.js");

    const server = await __test_serveHtmlReportOnLocalhost(
      makeResult(),
      { format: "html" } as ScanOptions,
      false,
      undefined,
      0,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        if (server.listening) return resolve();
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
      const addr = server.address() as { address: string; port: number; family: string } | null;
      expect(addr).not.toBeNull();
      expect(addr!.address).toBe("127.0.0.1");
      expect(addr!.address).not.toBe("0.0.0.0");
      expect(addr!.address).not.toBe("::");
    } finally {
      server.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Regression: --fail-on-score used to call process.exit(1) unconditionally,
// tearing the just-started local report server down before the browser
// could load it. On the local-server path, the server's own lifecycle must
// own process termination; logAndRender should only set process.exitCode.
// ────────────────────────────────────────────────────────────────────
describe("logAndRender — --fail-on-score on the local report server path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.removeAllListeners("SIGINT");
    process.exitCode = undefined;
  });

  it("does not call process.exit and instead sets process.exitCode when the score fails the threshold", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) should not be called on the local-server path`);
    }) as never);

    const { logAndRender } = await import("../../../src/cli/commands/scan.js");

    const result = makeResult(10); // well under the threshold below
    const options: ScanOptions = { format: "html", failOnScore: 90 } as ScanOptions;

    await logAndRender(
      result,
      options,
      null, // unauthenticated → local-server path
      undefined,
      "/tmp/demo",
      undefined,
      false,
    );

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("still calls process.exit(1) immediately for a non-server format (e.g. json)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const { logAndRender } = await import("../../../src/cli/commands/scan.js");

    const result = makeResult(10);
    const options: ScanOptions = { json: true, failOnScore: 90 } as ScanOptions;

    await logAndRender(result, options, null, undefined, "/tmp/demo", undefined, false);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
