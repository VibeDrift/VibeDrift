/**
 * Log a completed scan to the dashboard via /v1/scans/log.
 *
 * Called by the CLI for EVERY scan, free or deep, after the local
 * pipeline + scoring + HTML rendering has finished. This is the single
 * source of truth for what shows up in the user's dashboard — the
 * values sent here are what the user sees in the dashboard's metadata
 * strip and timeline.
 *
 * Silent on failure (network down, server 500, etc.) — the scan
 * already succeeded locally so a failed log shouldn't surface an error.
 */

const DEFAULT_API_URL = "https://vibedrift-api.fly.dev";
// 60s upload timeout. Was 20s, but legit 5–10MB uploads on slower
// connections (or against a cold Fly machine) can spend that just on
// the round trip + Supabase row insert. Picked 60s to cover the
// p99 of real-world cases without making genuine network failures
// hang for ages.
const TIMEOUT_MS = 60_000;
const MAX_HTML_BYTES = 1_500_000;
// Server caps /v1/scans/log at 25MB. Stay 1MB under to leave headroom for
// HTTP framing, gzip negotiation, and the eventual server-side trim pass.
const MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;
// Below this we never bother trimming. Above it we progressively strip
// the heaviest fields until we fit. Picked at 9MB so that older API
// instances (still on the 10MB cap) keep working until they're upgraded.
const TRIM_TARGET_BYTES = 9 * 1024 * 1024;

export interface ScanLogPayload {
  project_hash?: string;
  project_name?: string;
  language: string;
  file_count: number;
  /** Total lines of code scanned. Denormalized for admin/dashboard
   *  repo-size analytics; sourced from ScanResult.context.totalLines. */
  total_lines?: number;
  function_count: number;
  finding_count: number;
  score?: number | null;
  grade?: string | null;
  duplicates_found: number;
  intent_mismatches: number;
  anomalies_found: number;
  is_deep: boolean;
  processing_time_ms: number;
  /** Full self-contained HTML report. Truncated server-side if too large. */
  report_html?: string;
  /**
   * Sanitized full ScanResult — the canonical source of truth for the
   * dashboard. Both the metadata strip and the embedded HTML report
   * are derived from this object, so they're guaranteed consistent.
   * Absolute paths are stripped before sending.
   */
  result_json?: Record<string, unknown>;
}

export interface ScanLogResult {
  ok: boolean;
  scanId?: string;
  projectId?: string;
  bytesStored?: number;
  error?: string;
  /** HTTP status when the server rejected the upload. */
  status?: number;
  /** Initial size of the JSON-serialized payload, in bytes. */
  initialBytes?: number;
  /** Final size after any client-side trimming, in bytes. */
  finalBytes?: number;
  /** Names of fields that were stripped to fit under the limit. Empty if none. */
  trimmedFields?: string[];
}

/**
 * Progressively strip the heaviest fields from `result_json` until the
 * total payload fits under TRIM_TARGET_BYTES. The dashboard renders
 * fine without per-function fingerprints or per-finding code snippets,
 * so we drop those first. As a last resort we drop the raw `files[]`
 * list (the dashboard only needs `fileCount`).
 *
 * Returns the (possibly modified) payload + a list of names of fields
 * that were trimmed, in the order they were dropped.
 */
function compactPayload(payload: ScanLogPayload): {
  payload: ScanLogPayload;
  trimmed: string[];
  bytesBefore: number;
  bytesAfter: number;
} {
  const trimmed: string[] = [];
  const bytesBefore = estimateBytes(payload);
  const p: ScanLogPayload = { ...payload };

  if (bytesBefore <= TRIM_TARGET_BYTES) {
    return { payload: p, trimmed, bytesBefore, bytesAfter: bytesBefore };
  }

  const cloneResult = (): Record<string, unknown> => ({
    ...((p.result_json ?? {}) as Record<string, unknown>),
  });

  // 1. Drop codeDnaResult.functions — by far the heaviest field on big
  //    repos. Per-function fingerprints + op sequences are not rendered
  //    by the dashboard; only `duplicateGroups` is. Keep the rest of
  //    `codeDnaResult` (group counts, etc.).
  if (p.result_json) {
    const cdr = (p.result_json as Record<string, unknown>).codeDnaResult as
      | Record<string, unknown>
      | undefined;
    if (cdr && Array.isArray(cdr.functions) && cdr.functions.length > 0) {
      const newCdr = { ...cdr };
      delete newCdr.functions;
      p.result_json = { ...cloneResult(), codeDnaResult: newCdr };
      trimmed.push("codeDnaResult.functions");
      if (estimateBytes(p) <= TRIM_TARGET_BYTES) {
        return { payload: p, trimmed, bytesBefore, bytesAfter: estimateBytes(p) };
      }
    }
  }

  // 2. Drop snippet text from finding locations. The dashboard's report
  //    renderer falls back to file:line when there's no snippet, which
  //    is fine for the metadata strip + headline cards.
  if (p.result_json) {
    const findings = (p.result_json as Record<string, unknown>).findings as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(findings) && findings.length > 0) {
      const stripped = findings.map((f) => {
        const locs = f.locations as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(locs)) return f;
        return {
          ...f,
          locations: locs.map((l) => {
            const next: Record<string, unknown> = { ...l };
            delete next.snippet;
            return next;
          }),
        };
      });
      p.result_json = { ...cloneResult(), findings: stripped };
      trimmed.push("findings[].locations[].snippet");
      if (estimateBytes(p) <= TRIM_TARGET_BYTES) {
        return { payload: p, trimmed, bytesBefore, bytesAfter: estimateBytes(p) };
      }
    }
  }

  // 3. Cap deviatingFiles per drift finding to 10. Some detectors
  //    surface every deviator on a large monorepo (hundreds of paths);
  //    the first 10 are enough for the report's "see deviators" link.
  if (p.result_json) {
    const drifts = (p.result_json as Record<string, unknown>).driftFindings as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(drifts) && drifts.length > 0) {
      const capped = drifts.map((d) => {
        const dev = d.deviatingFiles as unknown[] | undefined;
        if (!Array.isArray(dev) || dev.length <= 10) return d;
        return { ...d, deviatingFiles: dev.slice(0, 10), _truncated: dev.length };
      });
      p.result_json = { ...cloneResult(), driftFindings: capped };
      trimmed.push("driftFindings[].deviatingFiles capped at 10");
      if (estimateBytes(p) <= TRIM_TARGET_BYTES) {
        return { payload: p, trimmed, bytesBefore, bytesAfter: estimateBytes(p) };
      }
    }
  }

  // 4. Keep only perFileScores entries that actually have findings.
  //    Handles both the old shape (full `findings: Finding[]`) and the
  //    new summary shape (`findingCount: number`). On a 3500-file repo
  //    this drops most of the map (most files have no findings), and
  //    the dashboard's File Health bar only displays files with
  //    findings anyway.
  if (p.result_json) {
    const pfs = (p.result_json as Record<string, unknown>).perFileScores as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (pfs) {
      const kept: Record<string, Record<string, unknown>> = {};
      for (const [k, v] of Object.entries(pfs)) {
        if (!v) continue;
        const findings = v.findings as unknown[] | undefined;
        const findingCount = v.findingCount as number | undefined;
        const hasFindings =
          (Array.isArray(findings) && findings.length > 0) ||
          (typeof findingCount === "number" && findingCount > 0);
        if (hasFindings) kept[k] = v;
      }
      // Only count this as a "trim" if we actually shrank the map.
      const before = Object.keys(pfs).length;
      const after = Object.keys(kept).length;
      if (after < before) {
        p.result_json = { ...cloneResult(), perFileScores: kept };
        trimmed.push(`perFileScores: kept ${after}/${before} files with findings`);
        if (estimateBytes(p) <= TRIM_TARGET_BYTES) {
          return { payload: p, trimmed, bytesBefore, bytesAfter: estimateBytes(p) };
        }
      }
    }
  }

  // 5. Drop the raw files[] list. The dashboard only needs fileCount.
  if (p.result_json && Array.isArray((p.result_json as Record<string, unknown>).files)) {
    const newJson = cloneResult();
    delete newJson.files;
    p.result_json = newJson;
    trimmed.push("files[] (raw file metadata)");
    if (estimateBytes(p) <= TRIM_TARGET_BYTES) {
      return { payload: p, trimmed, bytesBefore, bytesAfter: estimateBytes(p) };
    }
  }

  // 6. Last resort: drop codeDnaResult entirely.
  if (p.result_json && (p.result_json as Record<string, unknown>).codeDnaResult) {
    const newJson = cloneResult();
    delete newJson.codeDnaResult;
    p.result_json = newJson;
    trimmed.push("codeDnaResult (entirely)");
  }

  return { payload: p, trimmed, bytesBefore, bytesAfter: estimateBytes(p) };
}

function estimateBytes(p: ScanLogPayload): number {
  return Buffer.byteLength(JSON.stringify(p), "utf-8");
}

export async function logScan(opts: {
  payload: ScanLogPayload;
  token: string;
  apiUrl?: string;
  verbose?: boolean;
}): Promise<ScanLogResult> {
  const { payload, token, apiUrl, verbose } = opts;
  const base = apiUrl ?? DEFAULT_API_URL;

  // Trim HTML if it exceeds the cap so we still log the metadata
  let working = { ...payload };
  if (working.report_html) {
    const size = Buffer.byteLength(working.report_html, "utf-8");
    if (size > MAX_HTML_BYTES) {
      if (verbose) {
        console.error(
          `[scan-log] HTML too large (${Math.round(size / 1024)}KB), dropping the blob`,
        );
      }
      delete working.report_html;
    }
  }

  // Compact result_json by stripping the heaviest fields if needed.
  // On most repos this is a no-op (initial size already under target).
  const { payload: compacted, trimmed: trimmedFields, bytesBefore, bytesAfter } =
    compactPayload(working);
  working = compacted;

  // Hard guard. If even after compaction the payload is over the
  // server's hard limit, give up rather than getting a 413. The
  // caller will surface a "couldn't upload" warning to the user.
  if (bytesAfter > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: `payload too large (${Math.round(bytesAfter / 1024 / 1024)}MB) even after trimming`,
      initialBytes: bytesBefore,
      finalBytes: bytesAfter,
      trimmedFields,
    };
  }

  if (verbose && trimmedFields.length > 0) {
    console.error(
      `[scan-log] Trimmed ${Math.round(bytesBefore / 1024 / 1024)}MB → ` +
        `${Math.round(bytesAfter / 1024 / 1024)}MB (${trimmedFields.join(", ")})`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/v1/scans/log`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(working),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (verbose) {
        console.error(`[scan-log] HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}: ${text.slice(0, 160)}`,
        initialBytes: bytesBefore,
        finalBytes: bytesAfter,
        trimmedFields,
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      scan_id?: string;
      project_id?: string;
      bytes_stored?: number;
    };

    if (verbose) {
      console.error(
        `[scan-log] Logged scan ${data.scan_id?.slice(0, 8) ?? "?"} ` +
          `(project ${data.project_id?.slice(0, 8) ?? "?"}, ` +
          `${data.bytes_stored ?? 0} HTML bytes)`,
      );
    }

    return {
      ok: true,
      scanId: data.scan_id,
      projectId: data.project_id,
      bytesStored: data.bytes_stored,
      initialBytes: bytesBefore,
      finalBytes: bytesAfter,
      trimmedFields,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (verbose) console.error(`[scan-log] Failed: ${msg}`);
    return {
      ok: false,
      error: msg,
      initialBytes: bytesBefore,
      finalBytes: bytesAfter,
      trimmedFields,
    };
  } finally {
    clearTimeout(timer);
  }
}
