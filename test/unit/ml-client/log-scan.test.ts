import { describe, it, expect, afterEach } from "vitest";
import { logScan, type ScanLogPayload } from "../../../src/ml-client/log-scan.js";

/**
 * compactPayload/estimateBytes are internal (unexported) helpers inside
 * src/ml-client/log-scan.ts. We can't export them without touching src/,
 * so these tests drive the trimming logic entirely through the public
 * `logScan` surface — mocking `fetch` (the true external boundary) and
 * inspecting the JSON body it actually sends, plus the returned
 * initialBytes/finalBytes/trimmedFields observables.
 */

const basePayload = (
  over: Partial<ScanLogPayload> = {},
): ScanLogPayload => ({
  language: "typescript",
  file_count: 10,
  function_count: 20,
  finding_count: 1,
  duplicates_found: 0,
  intent_mismatches: 0,
  anomalies_found: 0,
  is_deep: false,
  processing_time_ms: 100,
  ...over,
});

const TRIM_TARGET_BYTES = 9 * 1024 * 1024;
const MAX_HTML_BYTES = 1_500_000;

let origFetch: typeof globalThis.fetch;
let capturedBody: any = null;

function mockFetch() {
  origFetch = globalThis.fetch;
  capturedBody = null;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({ scan_id: "scan1", project_id: "proj1", bytes_stored: 1 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("logScan payload trimming", () => {
  it("leaves an under-limit payload untouched", async () => {
    mockFetch();
    const payload = basePayload({
      result_json: {
        codeDnaResult: { functions: [{ name: "f1" }], duplicateGroups: [] },
        findings: [{ id: "F1", locations: [{ file: "a.ts", line: 1, snippet: "const x = 1;" }] }],
      },
      report_html: "<html>tiny report</html>",
    });

    const result = await logScan({ payload, token: "tok" });

    expect(result.ok).toBe(true);
    expect(result.trimmedFields).toEqual([]);
    expect(result.initialBytes).toBe(result.finalBytes);

    // nothing stripped from the actual outgoing body
    expect(capturedBody.report_html).toBe("<html>tiny report</html>");
    expect(capturedBody.result_json.codeDnaResult.functions).toEqual([{ name: "f1" }]);
    expect(capturedBody.result_json.findings[0].locations[0].snippet).toBe("const x = 1;");
  });

  it("progressively trims an oversized result_json, cheapest field first, and stops once under target", async () => {
    mockFetch();
    // Sized so removing codeDnaResult.functions ALONE still leaves the
    // payload over TRIM_TARGET_BYTES, forcing a second trim stage
    // (findings[].locations[].snippet) before it fits.
    const payload = basePayload({
      result_json: {
        codeDnaResult: {
          functions: [{ name: "f1", body: "x".repeat(6_000_000) }],
          duplicateGroups: [{ kept: true }],
        },
        findings: [
          {
            id: "F1",
            locations: [{ file: "a.ts", line: 1, snippet: "y".repeat(14_000_000) }],
          },
        ],
      },
    });

    const result = await logScan({ payload, token: "tok" });

    expect(result.ok).toBe(true);
    expect(result.initialBytes).toBeGreaterThan(TRIM_TARGET_BYTES);
    expect(result.finalBytes).toBeLessThanOrEqual(TRIM_TARGET_BYTES);
    expect(result.trimmedFields).toEqual([
      "codeDnaResult.functions",
      "findings[].locations[].snippet",
    ]);

    // the actual outgoing body reflects both trims
    expect(capturedBody.result_json.codeDnaResult.functions).toBeUndefined();
    expect(capturedBody.result_json.findings[0].locations[0].snippet).toBeUndefined();
    // but untouched siblings survive
    expect(capturedBody.result_json.codeDnaResult.duplicateGroups).toEqual([{ kept: true }]);
    expect(capturedBody.result_json.findings[0].id).toBe("F1");
  });

  it("drops an oversized report_html entirely without touching result_json", async () => {
    mockFetch();
    const payload = basePayload({
      report_html: "z".repeat(MAX_HTML_BYTES + 500_000),
      result_json: { codeDnaResult: { functions: [{ name: "f1" }] } },
    });

    const result = await logScan({ payload, token: "tok" });

    expect(result.ok).toBe(true);
    expect(capturedBody.report_html).toBeUndefined();
    // result_json is small and stays intact — report_html drop is a
    // separate mechanism from compactPayload's trimmedFields list.
    expect(capturedBody.result_json.codeDnaResult.functions).toEqual([{ name: "f1" }]);
  });
});
