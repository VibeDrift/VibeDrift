/**
 * Upload a rendered HTML report to the VibeDrift dashboard.
 *
 *   PUT /v1/scans/{scanId}/report
 *   Authorization: Bearer <token>
 *   Content-Type: application/json
 *   Body: { "report_html": "<!DOCTYPE html>..." }
 *
 * The dashboard renders this exact HTML inside an iframe so users
 * see the same report in their browser that the CLI saved to disk.
 *
 * Silent on failure — the scan already succeeded locally; a failed
 * upload shouldn't surface an error to the user.
 */

const DEFAULT_API_URL = "https://vibedrift-api.fly.dev";
const UPLOAD_TIMEOUT_MS = 15_000;
const MAX_REPORT_BYTES = 1_000_000; // matches server cap

export async function uploadReportHtml(opts: {
  scanId: string;
  html: string;
  token: string;
  apiUrl?: string;
  verbose?: boolean;
}): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  const { scanId, html, token, apiUrl, verbose } = opts;
  const base = apiUrl ?? DEFAULT_API_URL;
  const sizeBytes = Buffer.byteLength(html, "utf-8");

  if (sizeBytes === 0) {
    return { ok: false, error: "empty html" };
  }
  if (sizeBytes > MAX_REPORT_BYTES) {
    return {
      ok: false,
      error: `report too large (${Math.round(sizeBytes / 1024)}KB > ${MAX_REPORT_BYTES / 1024}KB)`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/v1/scans/${encodeURIComponent(scanId)}/report`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ report_html: html }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (verbose) {
        console.error(
          `[report-upload] HTTP ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      return { ok: false, error: `HTTP ${res.status}` };
    }

    if (verbose) {
      console.error(
        `[report-upload] Uploaded ${Math.round(sizeBytes / 1024)}KB for scan ${scanId.slice(0, 8)}`,
      );
    }
    return { ok: true, bytes: sizeBytes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (verbose) console.error(`[report-upload] Failed: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
