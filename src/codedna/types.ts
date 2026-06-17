/**
 * Type definitions for the Code DNA analysis pipeline.
 *
 * Code DNA performs five analyses on extracted functions: semantic fingerprinting
 * (hash-based duplicate detection), operation sequence comparison (LCS similarity),
 * architectural pattern classification, taint flow tracking, and deviation
 * justification scoring. All intermediate and result types live here.
 */

import type { SupportedLanguage, Finding } from "../core/types.js";

// ──── Shared Function Extraction ────

export interface ExtractedFunction {
  name: string;
  file: string;
  relativePath: string;
  line: number;
  language: SupportedLanguage;
  params: string[];
  paramCount: number;
  rawBody: string;
  declarationCode: string;
  domainCategory: string;
  bodyTokens: string[];
  bodyTokenCount: number;
  bodyHash: number;
}

// ──── Module 1: Semantic Fingerprinting ────

export interface SemanticFingerprint {
  functionRef: FunctionRef;
  normalizedHash: string;
}

export interface SemanticDuplicateGroup {
  groupId: string;
  hash: string;
  functions: FunctionRef[];
}

// ──── Module 2: Operation Sequences ────

// High-level opcodes that abstract away language syntax, enabling
// cross-language function comparison via longest-common-subsequence.
// Richer alphabet → more expressive comparison: two functions that both
// look like [INPUT, QUERY, RETURN_OK] at 12 ops can look very different
// at 22 — e.g. [INPUT, AUTH, CACHE_READ, QUERY, CACHE_WRITE, SERIALIZE,
// RETURN_OK] (production-grade) vs [INPUT, QUERY, RETURN_OK] (draft).
export type Operation =
  | "INPUT"
  | "AUTH"          // middleware guard / token verify / session lookup
  | "VALIDATE"
  | "CACHE_READ"    // redis.get, cache.get, lru.get, memcache.get
  | "CACHE_WRITE"   // redis.set, cache.set, lru.put, memcache.set
  | "QUERY"
  | "MUTATE"
  | "METRICS"       // prometheus., statsd., metrics.inc, counter/gauge/histogram
  | "EMIT"          // emitter.emit, eventBus.publish, socket.emit
  | "API_CALL"
  | "RETRY"         // retry(), backoff, p-retry, .retries
  | "LOCK"          // mutex.Lock, sync.Mutex, Semaphore.acquire
  | "RESOURCE"
  | "LOG"
  | "SERIALIZE"     // JSON.stringify, toJSON, .serialize(), Marshal
  | "DESERIALIZE"   // JSON.parse, fromJSON, .parse(), Unmarshal
  | "AGGREGATE"     // .reduce(), groupBy(), aggregate pipelines
  | "LOOP"
  | "BRANCH"
  | "TRANSFORM"
  | "RETURN_OK"
  | "RETURN_ERR";

export interface OperationSequence {
  functionRef: FunctionRef;
  sequence: Operation[];
}

export interface SequenceSimilarity {
  functionA: FunctionRef;
  functionB: FunctionRef;
  similarity: number;
  lcsLength: number;
  maxLength: number;
}

// ──── Module 3: Pattern Classification ────

export type ArchPattern = "repository" | "raw_sql" | "orm" | "direct_db" | "http_client" | "none";

export interface PatternSignal {
  pattern: ArchPattern;
  signal: string;
  line: number;
}

export interface PatternDistribution {
  file: string;
  relativePath: string;
  patterns: Partial<Record<ArchPattern, number>>;
  dominantPattern: ArchPattern;
  confidence: number;
  signals: PatternSignal[];
  isInternallyInconsistent: boolean;
}

// ──── Module 4: Taint Analysis ────

export interface TaintSource {
  type: string;
  variable: string;
  line: number;
}

export interface TaintSink {
  type: string;
  expression: string;
  line: number;
  severity: "error" | "warning";
}

export interface TaintFlow {
  file: string;
  relativePath: string;
  functionName: string;
  source: TaintSource;
  sink: TaintSink;
  sanitized: boolean;
  language: SupportedLanguage;
}

// ──── Module 5: Deviation Heuristics ────

export interface JustificationSignal {
  type: string;
  present: boolean;
  weight: number;
  evidence?: string;
}

// Scores whether a file's deviation from the dominant pattern looks intentional
// (e.g., boundary adapter) or accidental (e.g., forgotten refactor)
export interface DeviationJustification {
  file: string;
  relativePath: string;
  deviatingPattern: string;
  dominantPattern: string;
  justificationScore: number;
  signals: JustificationSignal[];
  verdict: "likely_justified" | "likely_accidental" | "uncertain";
}

// ──── Aggregate Result ────

export interface FunctionRef {
  file: string;
  relativePath: string;
  name: string;
  line: number;
}

export interface CodeDnaTimings {
  extractionMs: number;
  fingerprintMs: number;
  sequenceMs: number;
  patternMs: number;
  taintMs: number;
  deviationMs: number;
  totalMs: number;
}

export interface CodeDnaResult {
  functions: ExtractedFunction[];
  fingerprints: SemanticFingerprint[];
  duplicateGroups: SemanticDuplicateGroup[];
  sequenceSimilarities: SequenceSimilarity[];
  patternDistributions: PatternDistribution[];
  taintFlows: TaintFlow[];
  deviationJustifications: DeviationJustification[];
  findings: Finding[];
  timings: CodeDnaTimings;
}
