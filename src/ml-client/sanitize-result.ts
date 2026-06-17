import type { ScanResult } from "../core/types.js";

/**
 * Convert a ScanResult into a JSON-safe object suitable for upload to the
 * dashboard. The on-the-wire shape becomes the single source of truth: both
 * the dashboard metadata strip AND the embedded HTML report are derived
 * from this object, so they're guaranteed consistent.
 *
 * What we strip:
 *   - `context.rootDir` (absolute path on the user's machine — privacy)
 *   - Any absolute path that starts with `rootDir` is rewritten relative
 *
 * What we keep:
 *   - All findings (metadata only — no file contents)
 *   - All drift findings + per-category scores
 *   - codeDnaResult summary (function names, hashes, deviation verdicts)
 *   - Composite scores, grade, language breakdown
 *   - Per-file scores (with relative paths)
 *
 * What we drop entirely (large + not needed for the dashboard):
 *   - Raw file contents from `context.files`
 *   - tree-sitter AST nodes
 *   - Map / Set instances (converted to plain object/array)
 */
type StripPathFn = (p: string | undefined | null) => string | null;
type SanitizeNodeFn = (node: unknown) => unknown;

function createStripPath(rootDir: string): StripPathFn {
  return (p: string | undefined | null): string | null => {
    if (!p) return null;
    if (rootDir && p.startsWith(rootDir)) {
      const rel = p.slice(rootDir.length).replace(/^\/+/, "");
      return rel || ".";
    }
    return p;
  };
}

function createSanitizeNode(stripPath: StripPathFn): SanitizeNodeFn {
  const sanitizeNode = (node: unknown): unknown => {
    if (typeof node === "string") return stripPath(node) ?? node;
    if (Array.isArray(node)) return node.map(sanitizeNode);
    if (node instanceof Map) {
      return sanitizeMapNode(node, stripPath, sanitizeNode);
    }
    if (node instanceof Set) {
      return [...node].map(sanitizeNode);
    }
    if (node && typeof node === "object") {
      return sanitizeObjectNode(node as Record<string, unknown>, stripPath, sanitizeNode);
    }
    return node;
  };
  return sanitizeNode;
}

function sanitizeObjectNode(
  node: Record<string, unknown>,
  stripPath: StripPathFn,
  sanitizeNode: SanitizeNodeFn,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "rootDir") continue;
    if (k === "files" && Array.isArray(v)) {
      out[k] = sanitizeFilesList(v as Array<Record<string, unknown>>, stripPath);
      continue;
    }
    if (k === "ast" || k === "treeSitterNode") continue;
    out[k] = sanitizeNode(v);
  }
  return out;
}

function sanitizeFilesList(
  files: Array<Record<string, unknown>>,
  stripPath: StripPathFn,
): Array<Record<string, unknown>> {
  return files.map((f) => ({
    relativePath: stripPath(f.relativePath as string) ?? f.relativePath,
    lineCount: f.lineCount,
    language: f.language,
  }));
}

function sanitizeMapNode(
  node: Map<unknown, unknown>,
  stripPath: StripPathFn,
  sanitizeNode: SanitizeNodeFn,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of node.entries()) {
    const safeKey = typeof k === "string" ? stripPath(k) ?? k : String(k);
    obj[safeKey] = sanitizeNode(v);
  }
  return obj;
}

/**
 * Summarize perFileScores for upload. The local in-memory PerFileScore
 * holds the full Finding[] for each file (used by HTML / terminal /
 * CSV / DOCX renderers). Uploading that struct as-is fans every finding
 * out across all the files it touches, exploding the payload (a single
 * codedna-fingerprint finding spanning 60 files would be stored 60+1
 * times — once per file plus once in `findings`).
 *
 * The dashboard only needs aggregate per-file stats: count, weight,
 * severity histogram. Anything more detailed it can join against the
 * top-level `findings` array using the file path. Producing summaries
 * here cuts the upload by 50%+ on registry-style codebases (every
 * shadcn/MUI/etc. theme variant scenario).
 *
 * Scoring is unaffected — perFileScores is built BY the scoring engine
 * for display, never read back by it.
 */
function summarizePerFileScores(
  perFileScores: unknown,
  stripPath: StripPathFn,
): Record<string, Record<string, unknown>> {
  if (!perFileScores) return {};

  const entries: Array<[unknown, Record<string, unknown>]> =
    perFileScores instanceof Map
      ? [...perFileScores.entries()] as Array<[unknown, Record<string, unknown>]>
      : (Object.entries(perFileScores as Record<string, Record<string, unknown>>) as Array<
          [unknown, Record<string, unknown>]
        >);

  const out: Record<string, Record<string, unknown>> = {};
  for (const [pathRaw, data] of entries) {
    if (!data || typeof data !== "object") continue;
    const findings = (data.findings as Array<Record<string, unknown>> | undefined) ?? [];
    const severities = { error: 0, warning: 0, info: 0 };
    let weight = 0;
    for (const f of findings) {
      const sev = (f.severity as "error" | "warning" | "info") ?? "info";
      severities[sev] = (severities[sev] ?? 0) + 1;
      const s = sev === "error" ? 3 : sev === "warning" ? 1.5 : 0.5;
      weight += s * ((f.confidence as number | undefined) ?? 1.0);
    }
    const safePath =
      typeof pathRaw === "string" ? stripPath(pathRaw) ?? pathRaw : String(pathRaw);
    const fileVal = data.file as string | undefined;
    const safeFile = fileVal ? stripPath(fileVal) ?? fileVal : safePath;
    out[safePath] = {
      file: safeFile,
      score: data.score,
      maxScore: data.maxScore,
      findingCount: findings.length,
      weight,
      severities,
    };
  }
  return out;
}

export function sanitizeResultForUpload(result: ScanResult): Record<string, unknown> {
  const ctx = result.context;
  const rootDir = ctx?.rootDir ?? "";

  const stripPath = createStripPath(rootDir);
  const sanitizeNode = createSanitizeNode(stripPath);

  return {
    schema: "vibedrift-scan-result/v1",
    project: {},
    language: {
      dominant: ctx?.dominantLanguage ?? null,
      breakdown: sanitizeNode(ctx?.languageBreakdown),
      totalLines: ctx?.totalLines ?? 0,
    },
    fileCount: (ctx?.files ?? []).length,
    files: sanitizeNode(ctx?.files),
    score: {
      composite: result.compositeScore,
      max: result.maxCompositeScore,
      categories: sanitizeNode(result.scores),
    },
    hygiene: {
      composite: result.hygieneScore,
      max: result.maxHygieneScore,
      categories: sanitizeNode(result.hygieneScores),
    },
    findings: sanitizeNode(result.findings),
    driftFindings: sanitizeNode(result.driftFindings),
    driftScores: sanitizeNode(result.driftScores),
    codeDnaResult: sanitizeNode(result.codeDnaResult),
    perFileScores: summarizePerFileScores(result.perFileScores, stripPath),
    teaseMessages: result.teaseMessages,
    aiSummary: result.aiSummary ?? null,
    scanTimeMs: result.scanTimeMs,
    // Persist the scoring methodology version so the cloud can backfill /
    // normalize stored scores by version (silent migration). Previously this
    // was computed but stripped before upload — the dashboard had to sniff
    // `score.max === 80` to guess the version. null when not set.
    scoringVersion: result.scoringVersion ?? null,
  };
}
