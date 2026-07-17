// ──── Request types (CLI → API) ────

export interface MlFunctionPayload {
  id: string;
  name: string;
  file: string;
  body: string;
  line_start: number;
  line_end: number;
  language: string;
}

export interface MlDeviationPayload {
  file: string;
  deviation_type: string;
  dominant_pattern: string;
  actual_pattern: string;
  dominant_count: number;
  total_files: number;
  snippet: string;
  has_comment: boolean;
  sql_complexity: number;
  function_complexity: number;
  directory: string;
}

export interface MlLlmValidationPayload {
  finding: string;
  confidence: number;
  snippet_a: string;
  snippet_b: string;
  question: string;
}

export interface MlAnalyzeRequest {
  scan_id?: string;
  project_hash?: string;
  /**
   * Human-readable project label shown in the dashboard. Autodetected
   * from package.json / Cargo.toml / go.mod, falls back to the basename
   * of the scan root. Overridable via `--project-name`.
   */
  project_name?: string;
  language: string;
  file_count: number;
  /**
   * Composite score (0-100) from the CLI's local scoring layer. Sent
   * so the dashboard can render score history without re-scoring
   * server-side.
   */
  score_hint?: number;
  grade_hint?: string;
  functions: MlFunctionPayload[];
  deviations: MlDeviationPayload[];
  llm_validations: MlLlmValidationPayload[];
  /** When false (the MCP default), the API persists the scan row itself. */
  defer_persist?: boolean;
  /** 'cli' (a full --deep scan) or 'mcp' (an in-loop deep check, billed 1/50). */
  source?: "cli" | "mcp";
}

// ──── Response types (API → CLI) ────

export interface MlDuplicateResult {
  function_a: string;
  function_b: string;
  similarity: number;
  confidence: number;
  verdict: string;
  needs_llm: boolean;
  /** Set when Claude validated this borderline finding: "confirmed" | "uncertain". */
  llm_verdict?: string;
}

export interface MlIntentMismatchResult {
  function_id: string;
  name: string;
  similarity: number;
  confidence: number;
  needs_llm: boolean;
  /** Set when Claude validated this borderline finding: "confirmed" | "uncertain". */
  llm_verdict?: string;
}

export interface MlAnomalyResult {
  function_id: string;
  distance_from_cluster: number;
  confidence: number;
  cluster_size: number;
  verdict: string;
}

export interface MlDeviationResult {
  file: string;
  verdict: string;
  confidence: number;
  needs_llm: boolean;
}

export interface MlReimplementationResult {
  name: string;
  function_a: string;
  function_b: string;
  member_ids: string[];
  files: string[];
  group_size: number;
  verdict: string;
  /** Panel vote ratio (1.0 = unanimous, 0.667 = 2/3). Already confirmed by the API. */
  confidence: number;
  real_votes: number;
  votes: number;
  reasons: string[];
}

export interface MlAnalyzeResponse {
  scan_id?: string;
  processing_time_ms: number;
  duplicates: MlDuplicateResult[];
  intent_mismatches: MlIntentMismatchResult[];
  anomalies: MlAnomalyResult[];
  deviations: MlDeviationResult[];
  /** Panel-confirmed redundant reimplementations. Optional for old-server compat. */
  reimplementations?: MlReimplementationResult[];
  llm_validations: unknown[];
}

// ──── Confidence-filtered results ────

export interface MlFindingForLlm {
  type: "duplicate" | "intent_mismatch" | "anomaly";
  confidence: number;
  detail: MlDuplicateResult | MlIntentMismatchResult | MlAnomalyResult;
  snippetA?: string;
  snippetB?: string;
  question: string;
}

export interface FilteredMlResults {
  highConfidence: import("../core/types.js").Finding[];
  mediumConfidence: MlFindingForLlm[];
  droppedCount: number;
  /**
   * Persisted scan id returned by the API. Present when the API
   * successfully wrote a row to the `scans` table; used by the CLI
   * to upload the rendered HTML report via PUT /v1/scans/{id}/report.
   */
  scanId?: string;
}
