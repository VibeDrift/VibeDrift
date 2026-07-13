/**
 * Client for /v1/coherence — the deep-scan tier's hero report.
 *
 * Sends the scan's drift findings, the repo's dominant patterns, and the
 * Claude-confirmed deep findings (semantic duplicates + name-lies) to the API,
 * which synthesizes a ranked coherence audit graded against the codebase's OWN
 * patterns. PAID-ONLY: the route is require_paid, so free/anonymous callers get
 * a non-2xx and this returns null (the caller renders nothing). The CLI also
 * pre-gates on plan, so this is the network backstop.
 *
 * buildCoherencePayload is pure + exported so the extraction (which fields of
 * ScanResult map to the request) is unit-testable without a network call.
 */
import type { ScanResult, CoherenceReport } from "../core/types.js";

const TIMEOUT_MS = 40_000; // synthesis is one Claude call; allow for cold start

interface CoherencePayload {
  project: string;
  language: string;
  file_count: number;
  total_lines: number;
  score: number;
  max_score: number;
  grade: string;
  dominant_patterns: {
    category: string;
    dominant_pattern: string;
    dominant_count: number;
    total_files: number;
    consistency: number;
  }[];
  drift_findings: {
    category: string;
    message: string;
    file: string;
    severity: string;
    consistency_impact: number;
  }[];
  duplicates: { detail: string; confidence: number }[];
  intent_lies: { name: string; explanation: string }[];
}

export function grade(score: number, max: number): string {
  const pct = max > 0 ? (score / max) * 100 : 0;
  if (pct >= 90) return "A";
  if (pct >= 75) return "B";
  if (pct >= 50) return "C";
  if (pct >= 25) return "D";
  return "F";
}

export function buildCoherencePayload(result: ScanResult): CoherencePayload {
  const drift = result.driftFindings ?? [];

  // One dominant-pattern row per drift category (the category's first finding
  // carries the repo-wide dominant pattern + consistency).
  const seenCat = new Set<string>();
  const dominant_patterns = [] as CoherencePayload["dominant_patterns"];
  for (const d of drift) {
    if (seenCat.has(d.driftCategory) || !d.dominantPattern) continue;
    seenCat.add(d.driftCategory);
    dominant_patterns.push({
      category: d.driftCategory,
      dominant_pattern: d.dominantPattern,
      dominant_count: d.dominantCount ?? 0,
      total_files: d.totalRelevantFiles ?? 0,
      consistency: d.consistencyScore ?? 0,
    });
  }

  const drift_findings = drift.map((d) => ({
    category: d.driftCategory,
    message: d.finding,
    file: d.deviatingFiles?.[0]?.path ?? "",
    severity: d.severity,
    // DriftFindingReport has no per-finding consistency-impact; recoverable
    // points are tracked on the static findings, so 0 here is the honest default.
    consistency_impact: 0,
  }));

  const mlFindings = result.findings.filter((f) => f.tags?.includes("ml") || f.analyzerId?.startsWith("ml-"));
  const duplicates = mlFindings
    .filter((f) => f.analyzerId === "ml-duplicate")
    .map((f) => ({ detail: f.message, confidence: f.confidence ?? 0 }));
  const intent_lies = mlFindings
    .filter((f) => f.analyzerId === "ml-intent")
    .map((f) => {
      // ml-intent message: "Function name mismatch: NAME() — ..."
      const m = f.message.match(/mismatch:\s*([^\s(]+)\s*\(\)/);
      return { name: m?.[1] ?? (f.locations?.[0]?.file ?? "function"), explanation: f.message };
    });

  return {
    project: result.context.rootDir.split("/").pop() || "this codebase",
    language: result.context.dominantLanguage ?? "unknown",
    file_count: result.context.files.length,
    total_lines: result.context.totalLines,
    score: result.compositeScore,
    max_score: result.maxCompositeScore,
    grade: grade(result.compositeScore, result.maxCompositeScore),
    dominant_patterns,
    drift_findings,
    duplicates,
    intent_lies,
  };
}

interface CoherenceApiResponse {
  coherence_grade?: string;
  coherence_score?: number;
  verdict?: string;
  ranked_issues?: {
    rank?: number;
    title?: string;
    severity?: string;
    pattern?: string;
    locations?: string[];
    why?: string;
    fix?: string;
  }[];
  strengths?: string[];
}

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

export async function fetchCoherenceReport(
  result: ScanResult,
  apiUrl: string,
  token?: string,
): Promise<CoherenceReport | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${apiUrl}/v1/coherence`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildCoherencePayload(result)),
      signal: controller.signal,
    });
    if (!response.ok) return null; // 402 free / 401 anon / 5xx → render nothing

    const data = (await response.json()) as CoherenceApiResponse;
    return {
      coherenceGrade: String(data.coherence_grade ?? ""),
      coherenceScore: Math.max(0, Math.min(100, Number(data.coherence_score ?? 0))),
      verdict: String(data.verdict ?? ""),
      rankedIssues: (data.ranked_issues ?? [])
        .filter((i) => i.title)
        .map((i, idx) => {
          const sev = String(i.severity ?? "medium").toLowerCase();
          return {
            rank: Number(i.rank ?? idx + 1),
            title: String(i.title),
            severity: (SEVERITIES.has(sev) ? sev : "medium") as CoherenceReport["rankedIssues"][number]["severity"],
            pattern: String(i.pattern ?? ""),
            locations: Array.isArray(i.locations) ? i.locations.map(String) : [],
            why: String(i.why ?? ""),
            fix: String(i.fix ?? ""),
          };
        })
        .sort((a, b) => a.rank - b.rank),
      strengths: Array.isArray(data.strengths) ? data.strengths.map(String) : [],
    };
  } catch {
    return null; // offline / timeout → degrade silently
  } finally {
    clearTimeout(timeout);
  }
}
