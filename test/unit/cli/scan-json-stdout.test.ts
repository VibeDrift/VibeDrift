import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Under --json the CLI's stdout MUST be pure machine-readable JSON. Any
// info/progress/notice line (e.g. the "Result trimmed for upload" notice
// emitted after a successful dashboard log) belongs on stderr, never stdout,
// or it corrupts the JSON a caller pipes into JSON.parse.
//
// The trim notice only fires when (a) the user is authenticated and (b) the
// uploaded result was large enough to be trimmed. We mock the dashboard
// upload path so logScan reports trimmed fields, then drive logAndRender in
// json mode and assert NOTHING with that text reached stdout.

vi.mock("../../../src/ml-client/log-scan.js", () => ({
  logScan: vi.fn(async () => ({
    ok: true,
    scanId: "scan_123",
    initialBytes: 9 * 1024 * 1024,
    finalBytes: 4 * 1024 * 1024,
    trimmedFields: ["functions", "files"],
  })),
}));

vi.mock("../../../src/ml-client/project-name.js", () => ({
  detectProjectIdentity: vi.fn(async () => ({ name: "demo", hash: "abc123" })),
  detectLocalDisplayName: vi.fn(async () => "demo"),
}));

vi.mock("../../../src/ml-client/sanitize-result.js", () => ({
  sanitizeResultForUpload: vi.fn((r: unknown) => ({ ...(r as object) })),
}));

import { logAndRender, isJsonOutput } from "../../../src/cli/commands/scan.js";
import type { ScanResult, ScanOptions } from "../../../src/core/types.js";

function makeResult(): ScanResult {
  return {
    version: "0.0.0-test",
    project: "/tmp/demo",
    findings: [],
    compositeScore: 80,
    maxCompositeScore: 100,
    scanTimeMs: 12,
    scores: {} as any,
    perFileScores: new Map(),
    context: {
      rootDir: "/tmp/demo",
      files: [],
      totalLines: 100,
      dominantLanguage: "typescript",
    } as any,
  } as unknown as ScanResult;
}

describe("isJsonOutput", () => {
  it("is true for --json and for --format json", () => {
    expect(isJsonOutput({ json: true } as ScanOptions)).toBe(true);
    expect(isJsonOutput({ format: "json" } as ScanOptions)).toBe(true);
  });

  it("is false for html/terminal/csv/default", () => {
    expect(isJsonOutput({} as ScanOptions)).toBe(false);
    expect(isJsonOutput({ format: "html" } as ScanOptions)).toBe(false);
    expect(isJsonOutput({ format: "terminal" } as ScanOptions)).toBe(false);
    expect(isJsonOutput({ format: "csv" } as ScanOptions)).toBe(false);
  });

  it("an explicit non-json --format overrides --json", () => {
    // Commander sets format=html when the user passes a real format; json
    // here would only be the bare --json shorthand, which loses.
    expect(isJsonOutput({ json: true, format: "html" } as ScanOptions)).toBe(false);
  });
});

describe("logAndRender: --json keeps stdout pure JSON", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes the 'Result trimmed for upload' notice to stderr, never stdout", async () => {
    const result = makeResult();
    const options: ScanOptions = { json: true } as ScanOptions;

    await logAndRender(
      result,
      options,
      "fake-bearer-token", // authenticated → upload + trim notice path
      "https://api.example.test",
      "/tmp/demo",
      null, // codeDnaResult
      false, // paid
    );

    const stdout = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    const stderr = errSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");

    // The notice must NOT be on stdout (it would corrupt the JSON stream).
    expect(stdout).not.toMatch(/Result trimmed for upload/);
    // It should still be surfaced — on stderr.
    expect(stderr).toMatch(/Result trimmed for upload/);

    // Every stdout line under --json must parse as part of the JSON payload.
    // The only stdout write in this path is the JSON document itself.
    const stdoutLines = logSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((l) => l.trim().length > 0);
    for (const line of stdoutLines) {
      expect(line).not.toMatch(/Result trimmed for upload/);
      expect(line).not.toContain("ⓘ");
    }

    // And the emitted stdout, concatenated, must be valid JSON.
    expect(() => JSON.parse(stdoutLines.join("\n"))).not.toThrow();
  });
});
