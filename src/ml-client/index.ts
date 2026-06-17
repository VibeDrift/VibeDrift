import type { AnalysisContext, Finding, DriftFindingReport } from "../core/types.js";
import type { CodeDnaResult } from "../codedna/types.js";
import type { FilteredMlResults, MlDeviationPayload, MlLlmValidationPayload } from "./types.js";
import { sampleFunctionsForMl } from "./sampler.js";
import { callMlApi } from "./client.js";
import { filterByConfidence } from "./confidence.js";

export interface MlAnalysisOptions {
  /** Bearer token from `vibedrift login` (~/.vibedrift/config.json or VIBEDRIFT_TOKEN). */
  token?: string;
  /** Override the API base URL — staging/dev only. */
  apiUrl?: string;
  verbose?: boolean;
  driftFindings?: DriftFindingReport[];
  /** Optional human-readable project name override (--project-name flag). */
  projectName?: string;
  /** Composite score (0-100) from local scoring, sent for dashboard history. */
  scoreHint?: number;
  /** Letter grade from local scoring. */
  gradeHint?: string;
}

/**
 * Build deviation payloads from Code DNA and drift findings for the ML API's
 * deviation classifier. This enables the paid feature: ML-powered verdict
 * (justified vs accidental) that improves on the local heuristic.
 */
function buildDeviationPayloads(
  codeDnaResult: CodeDnaResult | undefined,
  driftFindings: DriftFindingReport[],
): MlDeviationPayload[] {
  const deviations: MlDeviationPayload[] = [];
  const seen = new Set<string>();

  // Code DNA deviations have the richest structural data
  if (codeDnaResult?.deviationJustifications) {
    for (const dj of codeDnaResult.deviationJustifications) {
      const key = `${dj.relativePath}::${dj.deviatingPattern}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const hasComment = dj.signals?.some((s) => s.type === "explanatory_comment" && s.present) ?? false;
      const sqlComplexity = dj.signals?.find((s) => s.type === "complex_sql")?.present ? 3 : 0;
      const funcComplexity = dj.signals?.reduce((sum, s) => sum + (s.present ? Math.abs(s.weight) : 0), 0) ?? 0;

      // Map the deviation pattern to the API's DEVIATION_TYPE_MAP categories:
      //   data_access, error_handling, auth, naming, di, config
      // The API model was trained on these 6 types — sending "architectural"
      // (which is not in the map) causes it to default to 0.5 and lose signal.
      const patternToType: Record<string, string> = {
        repository: "data_access", raw_sql: "data_access", orm: "data_access",
        direct_db: "data_access", http_client: "data_access",
        wrap_with_context: "error_handling", raw_propagation: "error_handling",
        swallow: "error_handling", http_error_response: "error_handling",
        exception_throw: "error_handling", result_type: "error_handling",
        constructor_injection: "di", global_import: "di",
        service_locator: "di", no_di: "di",
        env_direct: "config", config_struct_di: "config",
      };
      const inferredType =
        patternToType[dj.deviatingPattern] ??
        patternToType[dj.dominantPattern] ??
        "data_access";

      deviations.push({
        file: dj.relativePath,
        deviation_type: inferredType,
        dominant_pattern: dj.dominantPattern,
        actual_pattern: dj.deviatingPattern,
        dominant_count: 0,
        total_files: 0,
        snippet: "",
        has_comment: hasComment,
        sql_complexity: sqlComplexity,
        function_complexity: Math.round(funcComplexity * 10),
        directory: dj.relativePath.split("/").slice(0, -1).join("/"),
      });
    }
  }

  // Drift findings provide dominant/total counts and code evidence
  for (const d of driftFindings) {
    if (d.driftCategory !== "architectural_consistency") continue;

    for (const df of d.deviatingFiles) {
      const key = `${df.path}::${df.detectedPattern}`;
      if (seen.has(key)) continue;
      seen.add(key);

      deviations.push({
        file: df.path,
        deviation_type: d.subCategory ?? "data_access",
        dominant_pattern: d.dominantPattern,
        actual_pattern: df.detectedPattern,
        dominant_count: d.dominantCount,
        total_files: d.totalRelevantFiles,
        snippet: df.evidence?.[0]?.code?.slice(0, 200) ?? "",
        has_comment: false,
        sql_complexity: 0,
        function_complexity: 0,
        directory: df.path.split("/").slice(0, -1).join("/"),
      });
    }
  }

  return deviations.slice(0, 20); // API limit
}

export async function runMlAnalysis(
  ctx: AnalysisContext,
  codeDnaResult: CodeDnaResult | undefined,
  findings: Finding[],
  options: MlAnalysisOptions,
): Promise<FilteredMlResults> {
  // Use Code DNA's extracted functions if available, otherwise we need to extract
  let functions = codeDnaResult?.functions ?? [];

  if (functions.length === 0) {
    // Fallback: extract functions
    const { extractAllFunctions } = await import("../codedna/function-extractor.js");
    functions = extractAllFunctions(ctx.files);
  }

  if (functions.length === 0) {
    return { highConfidence: [], mediumConfidence: [], droppedCount: 0 };
  }

  // Sample top functions for the API
  const sampled = sampleFunctionsForMl(functions, findings);

  // Build deviation payloads from Code DNA + drift findings
  const deviations = buildDeviationPayloads(codeDnaResult, options.driftFindings ?? []);

  // Calculate payload size for transparency
  const payloadSize = JSON.stringify(sampled).length + JSON.stringify(deviations).length;

  if (options.verbose) {
    console.error(`[deep] Sending ${sampled.length} functions + ${deviations.length} deviations (${Math.round(payloadSize / 1024)}KB) to VibeDrift API...`);
    console.error(`[deep] No full files transmitted — only function snippets and structural metadata.`);
  }

  // Detect project identity (project_name + stable project_hash) so the
  // dashboard can group scans under a user-visible label. Autodetects from
  // package.json / Cargo.toml / go.mod / pyproject.toml, or uses the
  // --project-name override if one was passed.
  const { detectProjectIdentity } = await import("./project-name.js");
  const projectIdentity = await detectProjectIdentity(
    ctx.rootDir,
    options.projectName,
  );

  // Build request
  const request = {
    language: ctx.dominantLanguage ?? "unknown",
    file_count: ctx.files.length,
    project_hash: projectIdentity.hash,
    project_name: projectIdentity.name,
    score_hint: options.scoreHint,
    grade_hint: options.gradeHint,
    // Tell the server NOT to persist a row from the analyze call —
    // the CLI logs the full scan summary via /v1/scans/log AFTER the
    // pipeline finishes, which has accurate metadata.
    defer_persist: true,
    functions: sampled,
    deviations,
    // Empty = "validate server-side". The API picks the borderline (needs_llm)
    // duplicate/intent findings itself, runs one batched Claude call, and folds
    // the verdicts back into the response before we filter by confidence. We
    // send [] rather than pre-selecting because confidence is only known after
    // the API scores the embeddings — selecting here would need a 2nd round-trip.
    llm_validations: [] as MlLlmValidationPayload[],
  };

  // Call the API
  const response = await callMlApi(request, options.token, options.apiUrl);

  if (options.verbose) {
    console.error(
      `[deep] API returned: ${response.duplicates.length} duplicates, ` +
      `${response.intent_mismatches.length} intent mismatches, ` +
      `${response.anomalies.length} anomalies, ` +
      `${response.deviations?.length ?? 0} deviation verdicts — ${response.processing_time_ms}ms`,
    );
  }

  // Filter by confidence
  const filtered = filterByConfidence(response);

  // Surface the persisted scan id so the caller can upload the HTML report
  if (response.scan_id) {
    filtered.scanId = response.scan_id;
  }

  // If API returned ML deviation verdicts, override Code DNA's local heuristic verdicts
  if (response.deviations?.length > 0 && codeDnaResult?.deviationJustifications) {
    for (const mlDev of response.deviations) {
      const local = codeDnaResult.deviationJustifications.find(
        (dj: any) => dj.relativePath === mlDev.file || dj.file === mlDev.file,
      );
      if (local && mlDev.confidence > 0.6) {
        // ML classifier overrides local heuristic
        (local as any).verdict = mlDev.verdict === "justified" ? "likely_justified"
          : mlDev.verdict === "accidental" ? "likely_accidental" : local.verdict;
      }
    }
  }

  return filtered;
}
