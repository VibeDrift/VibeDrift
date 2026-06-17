import type { ScanResult } from "../core/types.js";

const TIMEOUT_MS = 30_000;

interface SummaryResponse {
  summary: string;
  highlights: string[];
  processingTimeMs: number;
}

export async function fetchAiSummary(
  result: ScanResult,
  apiUrl: string,
  token?: string,
): Promise<{ summary: string; highlights: string[] } | null> {
  const dna = result.codeDnaResult;
  const mlFindings = result.findings.filter((f) => f.tags?.includes("ml"));

  const body = {
    project: result.context.rootDir.split("/").pop() ?? "project",
    score: result.compositeScore,
    maxScore: result.maxCompositeScore,
    grade: getGrade(result.compositeScore, result.maxCompositeScore),
    fileCount: result.context.files.length,
    totalLines: result.context.totalLines,
    languages: [...result.context.languageBreakdown.entries()]
      .map(([l, s]) => `${l}: ${s.files} files`)
      .join(", "),
    driftFindings: (result.driftFindings ?? []).map((d) => ({
      severity: d.severity,
      finding: d.finding,
      category: d.driftCategory,
      consistency: d.consistencyScore,
      dominant: d.dominantPattern,
      deviatingFiles: d.deviatingFiles.map((f) => f.path).join(", "),
    })),
    codeDnaSummary: dna ? {
      functions: dna.functions?.length ?? 0,
      fingerprints: dna.duplicateGroups?.length ?? 0,
      sequences: dna.sequenceSimilarities?.length ?? 0,
      taintFlows: dna.taintFlows?.length ?? 0,
      deviations: dna.deviationJustifications?.length ?? 0,
    } : null,
    mlSummary: mlFindings.length > 0 ? {
      duplicates: mlFindings.filter((f) => f.analyzerId === "ml-duplicate").length,
      intentMismatches: mlFindings.filter((f) => f.analyzerId === "ml-intent").length,
      anomalies: mlFindings.filter((f) => f.analyzerId === "ml-anomaly").length,
    } : null,
    topIssues: (result.driftFindings ?? [])
      .sort((a, b) => {
        const sev = { error: 3, warning: 2, info: 1 };
        return (sev[b.severity as keyof typeof sev] ?? 0) - (sev[a.severity as keyof typeof sev] ?? 0);
      })
      .slice(0, 5)
      .map((d) => d.recommendation),
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${apiUrl}/v1/summarize`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as SummaryResponse;
    return { summary: data.summary, highlights: data.highlights };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getGrade(score: number, max: number): string {
  const pct = max > 0 ? (score / max) * 100 : 0;
  if (pct >= 90) return "A";
  if (pct >= 75) return "B";
  if (pct >= 50) return "C";
  if (pct >= 25) return "D";
  return "F";
}
