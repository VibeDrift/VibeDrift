/**
 * Operation-sequence analyzer.
 *
 * Reduces each function body to a sequence of abstract opcodes (22 total),
 * then compares function pairs by their longest-common-subsequence (LCS) of
 * ops. High LCS similarity between two functions means they perform the same
 * *workflow*, even if they read completely differently on the page (different
 * variable names, different surface syntax, different languages).
 *
 * Why abstract ops instead of raw tokens: drift-measurement cares about what
 * a function *does*, not how it's spelled. Two handlers that both
 *   INPUT → AUTH → CACHE_READ → QUERY → CACHE_WRITE → SERIALIZE → RETURN_OK
 * are architecturally equivalent — whether one is written in Go and the other
 * in TypeScript, and whether one uses `redis.get` vs `cache.get`. Drift shows
 * up when sibling handlers *should* look alike but don't (some have AUTH,
 * some skip it; some have CACHE_READ, some always hit the DB).
 *
 * Classification is **first-match wins** in priority order below. The order
 * matters: more-specific patterns come first so that `if err != nil { return err }`
 * is classified as RETURN_ERR, not BRANCH; `JSON.stringify(x)` is SERIALIZE,
 * not TRANSFORM; and `.reduce(...)` is AGGREGATE, not LOOP.
 *
 * Consecutive duplicates are collapsed: two QUERYs in a row become one QUERY.
 * This keeps the sequence representative of the control flow, not the verbosity.
 */

import type { ExtractedFunction, Operation, OperationSequence, SequenceSimilarity } from "./types.js";
import type { Finding } from "../core/types.js";
import { toFunctionRef } from "./function-extractor.js";

/**
 * Priority order (first match wins):
 *   1. INPUT          framework request extraction
 *   2. AUTH           session / token / guard middleware
 *   3. VALIDATE       schema / guard / assertion
 *   4. RETURN_ERR     error-shaped return (before BRANCH, because the if
 *                     guard is part of this op, not a separate branch)
 *   5. RETURN_OK      success-shaped return
 *   6. CACHE_READ     before QUERY — cache-first reads
 *   7. CACHE_WRITE    before MUTATE — cache populate after write
 *   8. QUERY          DB read
 *   9. MUTATE         DB write
 *  10. METRICS        specific metrics libs
 *  11. EMIT           event emission / pub-sub
 *  12. API_CALL       outbound HTTP / RPC
 *  13. RETRY          retry wrappers
 *  14. LOCK           mutex / semaphore
 *  15. RESOURCE       generic open / close / defer
 *  16. LOG            generic logging
 *  17. SERIALIZE      JSON.stringify etc. (before TRANSFORM which would eat it)
 *  18. DESERIALIZE    JSON.parse etc.
 *  19. AGGREGATE      .reduce / groupBy (before LOOP which would eat .reduce)
 *  20. LOOP           for / forEach / while
 *  21. BRANCH         if / switch / match
 *  22. TRANSFORM      generic data manipulation (fallthrough)
 */
function classifyLine(line: string, _language: string): Operation | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "{" || trimmed === "}" || trimmed === ")") return null;

  // 1. INPUT — reading parameters, request body, context
  if (/(?:req\.params|req\.query|req\.body|c\.Param|c\.QueryParam|c\.Bind|c\.FormValue|request\.args|request\.form|request\.json|request\.GET|request\.POST|r\.URL\.Query|web::Path|web::Query|web::Json)/i.test(trimmed)) {
    return "INPUT";
  }

  // 2. AUTH — session / token / guard patterns
  if (/(?:requireAuth|isAuthenticated|\.verify(?:Token|Jwt|JWT)?\(|jwt\.verify\(|session\.(?:user|get)\b|req\.user\b|currentUser\(|getCurrentUser\(|middleware.*auth|authMiddleware|use\(.*auth|@(?:login_required|permission_classes)|AuthGuard|hasPermission\()/i.test(trimmed)) {
    return "AUTH";
  }

  // 3. VALIDATE — schema validation, type checking, bounds
  if (/(?:validate|schema\.parse|\.validate\(|zod\.|joi\.|assert|ensure|check.*(?:nil|null|empty|valid)|guard|sanitize)/i.test(trimmed)) {
    return "VALIDATE";
  }

  // 4. RETURN_ERR — error returns (check before BRANCH since if err != nil { return ... } is common)
  if (/(?:return\s+(?:nil|null|None),?\s*(?:err|fmt\.Errorf|errors\.)|throw\s+new|raise\s+|return\s+(?:err|error)|res\.status\(\d{3,}\)|c\.JSON\(\d{3,}|http\.Error)/i.test(trimmed)) {
    return "RETURN_ERR";
  }

  // 5. RETURN_OK — success returns
  if (/(?:return\s+c\.JSON\(2|return\s+res\.(?:json|send|status\(2)|return\s+(?:Ok|Some|jsonify)|c\.JSON\(http\.Status(?:OK|Created))/i.test(trimmed)) {
    return "RETURN_OK";
  }

  // 6. CACHE_READ — check cache before hitting DB
  if (/(?:redis\.get\(|cache\.get\(|memcache\.get\(|lru\.get\(|localStorage\.getItem\(|sessionStorage\.getItem\(|\.hget\(|memo\.get\(|cacheClient\.get\()/i.test(trimmed)) {
    return "CACHE_READ";
  }

  // 7. CACHE_WRITE — populate cache after DB write / compute
  if (/(?:redis\.set\(|cache\.set\(|memcache\.set\(|lru\.put\(|localStorage\.setItem\(|sessionStorage\.setItem\(|\.hset\(|memo\.set\(|cacheClient\.set\()/i.test(trimmed)) {
    return "CACHE_WRITE";
  }

  // 8. QUERY — database read operations
  if (/(?:SELECT\s|\.find\(|\.findOne\(|\.findAll\(|\.get\(|repo\.(?:Get|Find|List|Load)|db\.Query(?:Row)?\(|\.query\(|cursor\.execute.*SELECT|\.Where\(.*\.First\(|\.Where\(.*\.Find\()/i.test(trimmed)) {
    return "QUERY";
  }

  // 9. MUTATE — database write operations
  if (/(?:INSERT\s|UPDATE\s|DELETE\s|\.save\(|\.create\(|\.insert\(|repo\.(?:Create|Save|Store|Insert)|db\.Exec\(|cursor\.execute.*(?:INSERT|UPDATE|DELETE)|\.Remove\(|\.Delete\(|\.destroy\()/i.test(trimmed)) {
    return "MUTATE";
  }

  // 10. METRICS — prometheus / statsd / counter / histogram
  if (/(?:prometheus\.|statsd\.|metrics\.(?:inc|record|observe|set|gauge|counter|timer|histogram)|\.(?:Inc|Dec|Observe|Record)\b.*(?:counter|gauge|histogram|timer)|\bhistogram\.\w+\(|\bgauge\.\w+\(|\bcounter\.\w+\(|NewHistogram\(|NewCounter\(|NewGauge\()/i.test(trimmed)) {
    return "METRICS";
  }

  // 11. EMIT — pub/sub, event bus
  if (/(?:emitter\.emit\(|eventBus\.(?:emit|publish|send)\(|bus\.publish\(|socket\.emit\(|io\.emit\(|broker\.publish\(|publisher\.publish\(|pubsub\.publish\(|kafkaProducer\.send\()/i.test(trimmed)) {
    return "EMIT";
  }

  // 12. API_CALL — outbound HTTP/gRPC
  if (/(?:fetch\(|axios\.|http\.(?:Get|Post|Put|Delete)\(|\.request\(|requests\.(?:get|post|put|delete)|grpc\.|client\.\w+\()/i.test(trimmed)) {
    return "API_CALL";
  }

  // 13. RETRY — retry wrapper / backoff
  if (/(?:\bretry\s*\(|\.retry\s*\(|\bbackoff\s*\(|pRetry\(|retryAsync\(|withRetry\(|exponentialBackoff|\bretries\s*:)/i.test(trimmed)) {
    return "RETRY";
  }

  // 14. LOCK — mutex / semaphore
  if (/(?:mutex\.Lock\(|sync\.Mutex|sync\.RWMutex|\.Lock\(\)|\.RLock\(\)|\.acquire\(\)|Semaphore\(|withLock\(|\bsemaphore\.|\basync_lock\b|Mutex::lock)/i.test(trimmed)) {
    return "LOCK";
  }

  // 15. RESOURCE — open/close/defer
  if (/(?:defer\s|\.Close\(|\.close\(|fs\.open|os\.Open|with\s+open|try.*finally|\.release\(|\.dispose\(|\.end\()/i.test(trimmed)) {
    return "RESOURCE";
  }

  // 16. LOG — logging
  if (/(?:console\.(?:log|warn|error|info|debug)|log\.(?:Info|Warn|Error|Debug|Printf|Println)|logger\.|logging\.|slog\.)/i.test(trimmed)) {
    return "LOG";
  }

  // 17. SERIALIZE — to wire format
  if (/(?:JSON\.stringify\(|\.toJSON\(|\.serialize\(|json\.Marshal\(|proto\.Marshal\(|msgpack\.encode\()/i.test(trimmed)) {
    return "SERIALIZE";
  }

  // 18. DESERIALIZE — from wire format
  if (/(?:JSON\.parse\(|\.fromJSON\(|\.parse\(.*['"]\{|json\.Unmarshal\(|proto\.Unmarshal\(|msgpack\.decode\()/i.test(trimmed)) {
    return "DESERIALIZE";
  }

  // 19. AGGREGATE — reduction / grouping pipelines
  if (/(?:\.reduce\(|\.reduceRight\(|groupBy\(|\.aggregate\(|partitionBy\(|collect::<[A-Za-z]|\.fold\()/i.test(trimmed)) {
    return "AGGREGATE";
  }

  // 20. LOOP — iteration
  if (/(?:^for\s|^for\(|\.forEach\(|\.map\(|\.filter\(|while\s|while\(|\.each\(|range\s)/i.test(trimmed)) {
    return "LOOP";
  }

  // 21. BRANCH — conditional logic
  if (/(?:^if\s|^if\(|^else\s|^else\{|switch\s|switch\(|case\s|match\s|\?\s)/i.test(trimmed)) {
    return "BRANCH";
  }

  // 22. TRANSFORM — data manipulation (generic fallthrough)
  if (/(?:\.sort\(|\.slice\(|\.splice\(|strings\.|strconv\.|fmt\.Sprintf|\.trim\(|\.split\(|\.join\()/i.test(trimmed)) {
    return "TRANSFORM";
  }

  return null;
}

export function extractOperationSequences(functions: ExtractedFunction[]): OperationSequence[] {
  return functions.map((fn) => {
    const lines = fn.rawBody.split("\n");
    const sequence: Operation[] = [];

    for (const line of lines) {
      const op = classifyLine(line, fn.language);
      if (op) {
        if (sequence.length === 0 || sequence[sequence.length - 1] !== op) {
          sequence.push(op);
        }
      }
    }

    return { functionRef: toFunctionRef(fn), sequence };
  });
}

// Longest Common Subsequence length
function lcsLength(a: Operation[], b: Operation[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;

  // Space-optimized: only need previous row
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  return prev[n];
}

export function findSequenceSimilarities(
  sequences: OperationSequence[],
  functions: ExtractedFunction[],
): SequenceSimilarity[] {
  const similarities: SequenceSimilarity[] = [];

  // Build a map of domain categories for filtering
  const domainMap = new Map<string, string>();
  for (const fn of functions) {
    const key = `${fn.file}::${fn.name}::${fn.line}`;
    domainMap.set(key, fn.domainCategory);
  }

  // Only compare cross-file pairs in the same domain category
  for (let i = 0; i < sequences.length; i++) {
    const seqA = sequences[i];
    if (seqA.sequence.length < 3) continue; // Too short to be meaningful

    const keyA = `${seqA.functionRef.file}::${seqA.functionRef.name}::${seqA.functionRef.line}`;
    const domainA = domainMap.get(keyA);

    for (let j = i + 1; j < sequences.length; j++) {
      const seqB = sequences[j];
      if (seqB.sequence.length < 3) continue;

      // Must be in different files
      if (seqA.functionRef.file === seqB.functionRef.file) continue;

      // Must be in same domain category (skip "general" and "request_handling")
      const keyB = `${seqB.functionRef.file}::${seqB.functionRef.name}::${seqB.functionRef.line}`;
      const domainB = domainMap.get(keyB);
      if (!domainA || !domainB || domainA !== domainB) continue;
      if (domainA === "general" || domainA === "request_handling") continue;

      const lcs = lcsLength(seqA.sequence, seqB.sequence);
      const maxLen = Math.max(seqA.sequence.length, seqB.sequence.length);
      const similarity = maxLen > 0 ? lcs / maxLen : 0;

      if (similarity >= 0.80) {
        similarities.push({
          functionA: seqA.functionRef,
          functionB: seqB.functionRef,
          similarity,
          lcsLength: lcs,
          maxLength: maxLen,
        });
      }
    }
  }

  return similarities;
}

export function sequenceFindings(similarities: SequenceSimilarity[]): Finding[] {
  return similarities.map((sim) => {
    // Grade severity by match strength: a long, high-LCS sequence echo is a
    // genuine drift signal (warning); a short or borderline-similarity match
    // is likely incidental and registers only faintly (info). Confidence
    // stays graded by similarity as before.
    const strong = sim.similarity >= 0.92 && sim.lcsLength >= 6;
    const severity: Finding["severity"] = strong ? "warning" : "info";
    return {
      analyzerId: "codedna-opseq",
      severity,
      confidence: Math.min(sim.similarity, 0.95),
      message: `Near-duplicate operation sequence: ${sim.functionA.name}() and ${sim.functionB.name}() share ${Math.round(sim.similarity * 100)}% of their operation flow`,
      locations: [
        { file: sim.functionA.relativePath, line: sim.functionA.line, snippet: sim.functionA.name + "()" },
        { file: sim.functionB.relativePath, line: sim.functionB.line, snippet: sim.functionB.name + "()" },
      ],
      tags: ["codedna", "duplicate", "opseq"],
    };
  });
}
