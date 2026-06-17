import type { Finding } from "../core/types.js";
import type {
  MlAnalyzeResponse,
  MlFindingForLlm,
  FilteredMlResults,
} from "./types.js";

const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.50;
const MAX_LLM_CANDIDATES = 5;

export function filterByConfidence(response: MlAnalyzeResponse): FilteredMlResults {
  const highConfidence: Finding[] = [];
  const mediumConfidence: MlFindingForLlm[] = [];
  let droppedCount = 0;

  // ──── Process duplicates ────
  for (const dup of response.duplicates) {
    if (dup.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      highConfidence.push({
        analyzerId: "ml-duplicate",
        severity: "error",
        confidence: dup.confidence,
        message: `ML-detected semantic duplicate: ${dup.function_a} and ${dup.function_b} (${Math.round(dup.similarity * 100)}% similar)`,
        locations: [
          { file: dup.function_a.split("::")[0] },
          { file: dup.function_b.split("::")[0] },
        ],
        tags: ["ml", "duplicate"],
      });
    } else if (dup.confidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
      mediumConfidence.push({
        type: "duplicate",
        confidence: dup.confidence,
        detail: dup,
        question: `Are ${dup.function_a} and ${dup.function_b} doing the same thing? Similarity: ${Math.round(dup.similarity * 100)}%`,
      });
    } else {
      droppedCount++;
    }
  }

  // ──── Process intent mismatches ────
  // Single-word function names (Accept, Quote, List, Verify) are inherently hard
  // to embed semantically — a single word can't convey enough meaning for reliable
  // name-body comparison. Only flag names with 2+ words where semantic distance is clear.
  const GENERIC_SINGLE_WORDS = new Set([
    "handle", "process", "get", "set", "run", "do", "make", "create",
    "update", "delete", "find", "check", "init", "start", "stop",
    "accept", "quote", "ingest", "verify", "request", "list", "serve",
    "parse", "build", "load", "save", "send", "read", "write", "close",
    "open", "reset", "flush", "sync", "fetch", "push", "pull", "setup",
    "execute", "invoke", "dispatch", "resolve", "reject", "validate",
    "render", "mount", "unmount", "connect", "disconnect",
  ]);

  // CRUD verbs followed by a domain noun are standard handler patterns — the name
  // perfectly describes the intent. Embedding models struggle because the body involves
  // many steps (parse request, validate, DB call, return response) beyond the literal verb.
  const CRUD_PREFIXES = /^(create|update|delete|remove|get|list|find|fetch|search|add|edit|patch|upsert|insert|save|read|load|count|check|validate|verify|accept|reject|approve|deny|submit|publish|archive|restore|activate|deactivate|enable|disable|cancel|revoke|grant|assign|unassign|invite|register|login|logout|signup|signin|signout|reset|confirm|generate|send|export|import|download|upload|sync|refresh|clone|copy|move|merge|split|batch|bulk|process|handle|serve|render|show|display|index|new|close|open|start|stop|pause|resume|retry|queue|schedule|trigger|execute|run|init|setup|configure|install|deploy|migrate|seed|clear|flush|purge|mark|flag|tag|rate|score|vote|like|follow|subscribe|unsubscribe|notify|broadcast|log|track|record|audit|monitor|watch|inspect|scan|analyze|parse|transform|convert|format|encode|decode|encrypt|decrypt|hash|sign|wrap|unwrap|serialize|deserialize|marshal|unmarshal|quote|ingest|request)[A-Z_]/i;

  for (const intent of response.intent_mismatches) {
    // Skip single-word names — they generate false positives
    const nameWords = intent.name.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s_]+/);
    if (nameWords.length <= 1 || GENERIC_SINGLE_WORDS.has(intent.name.toLowerCase())) {
      droppedCount++;
      continue;
    }

    // Skip CRUD verb + domain noun patterns — these names describe the intent correctly,
    // but embedding models can't match a verb-noun name to a complex handler body
    if (CRUD_PREFIXES.test(intent.name)) {
      droppedCount++;
      continue;
    }

    if (intent.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      highConfidence.push({
        analyzerId: "ml-intent",
        severity: "warning",
        confidence: intent.confidence,
        message: `Function name mismatch: ${intent.name}() — name doesn't match behavior (${Math.round(intent.similarity * 100)}% name-body alignment)`,
        locations: [{ file: intent.function_id.split("::")[0] }],
        tags: ["ml", "intent"],
      });
    } else if (intent.confidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
      mediumConfidence.push({
        type: "intent_mismatch",
        confidence: intent.confidence,
        detail: intent,
        question: `Does ${intent.name}() actually do what its name suggests? Name-body similarity is only ${Math.round(intent.similarity * 100)}%.`,
      });
    } else {
      droppedCount++;
    }
  }

  // ──── Process anomalies ────
  for (const anomaly of response.anomalies) {
    if (anomaly.confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      highConfidence.push({
        analyzerId: "ml-anomaly",
        severity: "info",
        confidence: anomaly.confidence,
        message: `Pattern outlier: ${anomaly.function_id} doesn't cluster with its ${anomaly.cluster_size} peers (distance: ${anomaly.distance_from_cluster.toFixed(2)})`,
        locations: [{ file: anomaly.function_id.split("::")[0] }],
        tags: ["ml", "anomaly"],
      });
    } else if (anomaly.confidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
      mediumConfidence.push({
        type: "anomaly",
        confidence: anomaly.confidence,
        detail: anomaly,
        question: `Is ${anomaly.function_id} intentionally different from the ${anomaly.cluster_size} similar functions?`,
      });
    } else {
      droppedCount++;
    }
  }

  // Cap LLM candidates at MAX_LLM_CANDIDATES (highest confidence first)
  mediumConfidence.sort((a, b) => b.confidence - a.confidence);
  droppedCount += Math.max(0, mediumConfidence.length - MAX_LLM_CANDIDATES);

  return {
    highConfidence,
    mediumConfidence: mediumConfidence.slice(0, MAX_LLM_CANDIDATES),
    droppedCount,
  };
}
