/**
 * Deep-scan-tier rich fix prompt synthesis.
 *
 * Takes the top-N findings by consistency impact, pulls snippets from each
 * finding's dominant-pattern reference files, and sends them in a batched
 * call to the VibeDrift API's /v1/fix-prompts endpoint. The API returns
 * AI-synthesized prose describing how the peers implement the dominant
 * pattern. That prose is attached to `finding.metadata.fixPromptProse` so
 * the HTML + terminal + context-md renderers can pick it up via the shared
 * fix-prompt template.
 *
 * Fails soft: if the endpoint is unavailable or returns an error, findings
 * keep their free-tier prompts. Never throws upstream.
 */

import type { AnalysisContext, Finding } from "../core/types.js";
import { findingKey } from "../output/fix-prompt.js";

const MAX_FINDINGS_PER_BATCH = 10;
const MAX_REF_FILES_PER_FINDING = 3;
const MAX_SNIPPET_LINES = 60;

interface RefFileSnippet {
  path: string;
  snippet: string;
}

interface FixPromptRequestItem {
  finding_id: string;
  category: string;
  message: string;
  file: string;
  dominant_pattern: string;
  reference_files: RefFileSnippet[];
}

interface FixPromptResponse {
  prompts: Record<string, string>;
  processing_time_ms?: number;
}

function extractSnippet(content: string, dominantPattern: string): string {
  const lines = content.split("\n");
  if (lines.length <= MAX_SNIPPET_LINES) {
    return content;
  }
  const needle = dominantPattern.toLowerCase().split(/\s+/)[0];
  if (needle && needle.length > 2) {
    const hit = lines.findIndex((l) => l.toLowerCase().includes(needle));
    if (hit >= 0) {
      const start = Math.max(0, hit - 5);
      const end = Math.min(lines.length, start + MAX_SNIPPET_LINES);
      return lines.slice(start, end).join("\n");
    }
  }
  return lines.slice(0, MAX_SNIPPET_LINES).join("\n");
}

function buildRequestItems(
  findings: Finding[],
  ctx: AnalysisContext,
): FixPromptRequestItem[] {
  const fileByPath = new Map(ctx.files.map((f) => [f.relativePath, f]));
  const items: FixPromptRequestItem[] = [];

  for (const finding of findings) {
    const meta = finding.metadata ?? {};
    const domFiles = meta.dominantFiles ?? [];
    if (domFiles.length === 0) continue;

    const refs: RefFileSnippet[] = [];
    for (const path of domFiles.slice(0, MAX_REF_FILES_PER_FINDING)) {
      const file = fileByPath.get(path);
      if (!file) continue;
      refs.push({
        path,
        snippet: extractSnippet(file.content, meta.dominantPattern ?? ""),
      });
    }
    if (refs.length === 0) continue;

    const firstLoc = finding.locations[0];
    items.push({
      finding_id: findingKey(finding),
      category: finding.analyzerId,
      message: finding.message.replace(/^DRIFT:\s*/, "").slice(0, 400),
      file: firstLoc?.file ?? "",
      dominant_pattern: meta.dominantPattern ?? "",
      reference_files: refs,
    });
  }
  return items;
}

export async function synthesizeFixPrompts(
  findings: Finding[],
  ctx: AnalysisContext,
  options: { token: string; apiUrl?: string; verbose?: boolean },
): Promise<void> {
  const ranked = [...findings]
    .filter((f) => (f.consistencyImpact ?? 0) > 0 && (f.metadata?.dominantFiles?.length ?? 0) > 0)
    .sort((a, b) => (b.consistencyImpact ?? 0) - (a.consistencyImpact ?? 0))
    .slice(0, MAX_FINDINGS_PER_BATCH);

  if (ranked.length === 0) {
    if (options.verbose) console.error("[fix-prompts] no eligible findings — skipping synthesis");
    return;
  }

  const items = buildRequestItems(ranked, ctx);
  if (items.length === 0) {
    if (options.verbose) console.error("[fix-prompts] no reference snippets extracted — skipping");
    return;
  }

  const base = options.apiUrl ?? "https://vibedrift-api.fly.dev";
  const url = `${base}/v1/fix-prompts`;

  try {
    const t0 = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      if (options.verbose) console.error(`[fix-prompts] API returned ${res.status} — skipping rich prose`);
      return;
    }
    const data = (await res.json()) as FixPromptResponse;
    const prompts = data.prompts ?? {};

    // API returns numeric keys ("1", "2", ...) matching the order of
    // items sent. Map back to findings by position.
    let attached = 0;
    for (let i = 0; i < items.length && i < ranked.length; i++) {
      const numericKey = String(i + 1);
      const prose = prompts[numericKey];
      if (prose && prose.trim().length > 0) {
        ranked[i].metadata = ranked[i].metadata ?? {};
        ranked[i].metadata!.fixPromptProse = prose;
        attached++;
      }
    }
    if (options.verbose) {
      console.error(`[fix-prompts] attached prose to ${attached}/${ranked.length} findings in ${Date.now() - t0}ms`);
    }
  } catch (err: any) {
    if (options.verbose) console.error(`[fix-prompts] request failed: ${err.message ?? err}`);
  }
}
