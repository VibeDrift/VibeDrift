/**
 * MinHash + LSH similarity pipeline (shared between Layer-1 duplicate
 * detection and Layer-1.5 semantic-duplication drift detection).
 *
 * What it does: given two function bodies, decide quickly whether they're
 * "near duplicates" without pairwise-comparing every function to every other
 * function (which is O(n²) in function count × O(m·k) in body length).
 *
 * Pipeline:
 *   1. Tokenize       — strip comments / collapse strings+numbers
 *   2. Normalize      — rename local/param identifiers to ID0, ID1, …
 *                        BUT keep call-target chains (db.query, Repository.find)
 *                        literal, because the API a function calls is
 *                        architectural signal, not noise
 *   3. Shingle        — slide a 5-token window → set of shingles
 *   4. MinHash        — 128 seeded FNV-1a permutations → 128-value signature
 *   5. LSH            — 16 bands × 8 rows → O(n) candidate pair discovery
 *   6. LCS verify     — for each candidate pair, exact token-LCS similarity
 *
 * Collision probabilities (b=16 bands, r=8 rows, P(collide)=1-(1-s^8)^16):
 *   s=0.9  → 99.999% (almost always caught)
 *   s=0.8  → 94.7%
 *   s=0.7  → 61.3%   (our default flag threshold)
 *   s=0.5  →  6.1%
 *   s=0.3  →  0.1%
 */

// ─── Tokenizer ────────────────────────────────────────────────────────

/**
 * Everything the tokenizer must NOT see — string literals and comments — as
 * ONE left-to-right alternation. Group 1 captures a string literal; the
 * comment alternatives capture nothing.
 *
 * A single pass is the only correct shape; every sequential order has a bug.
 * Neutralizing strings before comments lets an apostrophe inside a comment
 * (`// don't do this`) open a "string" that runs to the next quote on a later
 * line and swallows the real code between them. Neutralizing comments before
 * strings lets a `//` inside a literal (`"https://api.example.com/v1"`)
 * truncate the literal mid-line, leaving an unbalanced quote that pairs with
 * the next one below. With one alternation the engine takes whichever
 * construct STARTS first at the current position and skips past it whole, so a
 * comment's apostrophe never opens a string and a literal's `//` never opens a
 * comment.
 *
 * Quoted strings stop at end of line (JS/TS/Go/Rust/Python strings cannot span
 * an unescaped newline, so a stray quote can damage at most one line);
 * template literals and Python triple-quoted strings may span lines. `#` line
 * comments are Python's; a `#` inside a JS string or comment has already been
 * consumed by the alternative that started earlier.
 *
 * Shared with `tokenizeBody` in function-extractor.ts, which substitutes a
 * different placeholder.
 */
export const LITERALS_AND_COMMENTS =
  /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g;

/**
 * Strip comments and collapse every string literal to `placeholder(quote)`,
 * where `quote` is the literal's delimiter character (`"`, `'` or `` ` ``).
 */
export function stripLiteralsAndComments(
  source: string,
  placeholder: (quote: string) => string,
): string {
  return source.replace(LITERALS_AND_COMMENTS, (_match: string, literal: string | undefined) =>
    literal === undefined ? "" : placeholder(literal[0]),
  );
}

export function tokenize(source: string): string[] {
  const cleaned = stripLiteralsAndComments(source, (q) => `${q}STR${q}`);
  const tokens = cleaned.match(/[a-zA-Z_]\w*|[0-9]+(?:\.[0-9]+)?|[{}()[\];,.:=<>!+\-*/%&|^~?@#]/g);
  return tokens ?? [];
}

const KEYWORDS = new Set([
  "function", "const", "let", "var", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "return", "throw", "try", "catch",
  "finally", "new", "delete", "typeof", "instanceof", "void", "in", "of",
  "class", "extends", "super", "import", "export", "default", "from",
  "async", "await", "yield", "static", "public", "private", "protected",
  "true", "false", "null", "undefined", "this",
  "func", "type", "struct", "interface", "map", "chan", "go", "select",
  "defer", "range", "package",
  "def", "elif", "except", "lambda", "with", "as", "pass",
  "raise", "global", "nonlocal", "assert", "and", "or", "not", "is",
  "None", "True", "False",
  "fn", "mut", "impl", "trait", "enum", "match", "pub", "mod",
  "use", "crate", "self", "where", "unsafe", "move", "ref",
]);

function isKeywordOrOperator(t: string): boolean {
  if (KEYWORDS.has(t)) return true;
  return /^[{}()[\];,.:=<>!+\-*/%&|^~?@#]$/.test(t);
}

function isIdentifier(t: string | undefined): boolean {
  return typeof t === "string" && /^[a-zA-Z_]\w*$/.test(t) && !KEYWORDS.has(t);
}

/**
 * Call-target-preserving identifier normalization.
 *
 * Walk left-to-right. When we see an identifier, look ahead through a
 * `.id` / `?.id` chain. If the chain ends with `(`, every identifier in it
 * is part of a call target and stays literal. Otherwise the identifier is
 * a local/param and gets mapped to ID{n}.
 *
 * Examples:
 *   `db.query(sql)`        → db . query ( ID0 )
 *   `const x = db.query()` → const ID0 = db . query ( )
 *   `new UserRepo()`       → new UserRepo ( )   (constructor name kept)
 *   `foo.bar = 1`          → ID0 . ID1 = NUM    (property access, not a call)
 */
export function normalizeTokens(tokens: string[]): string[] {
  const result: string[] = [];
  const idMap = new Map<string, string>();
  let counter = 0;

  const renameId = (t: string): string => {
    if (!idMap.has(t)) idMap.set(t, `ID${counter++}`);
    return idMap.get(t)!;
  };

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (t === "STR" || t === '"STR"' || t === "'STR'" || t === "`STR`") {
      result.push("STR");
      i++;
      continue;
    }
    if (/^[0-9]/.test(t)) {
      result.push("NUM");
      i++;
      continue;
    }
    if (isKeywordOrOperator(t)) {
      result.push(t);
      i++;
      continue;
    }

    let j = i;
    while (j + 1 < tokens.length) {
      if (tokens[j + 1] === "." && isIdentifier(tokens[j + 2])) {
        j += 2;
      } else if (
        tokens[j + 1] === "?" &&
        tokens[j + 2] === "." &&
        isIdentifier(tokens[j + 3])
      ) {
        j += 3;
      } else {
        break;
      }
    }

    const isCallTarget = tokens[j + 1] === "(";

    if (isCallTarget) {
      for (let k = i; k <= j; k++) result.push(tokens[k]);
      i = j + 1;
    } else {
      // A property chain has two halves with different meanings. The HEAD is a
      // name — a local, a parameter, an import alias — and is arbitrary, so it
      // is renamed. The MEMBERS are a path into a structure and identify what
      // the code touches, so they are kept literal.
      //
      // Erasing the members made `schema.reports` and `schema.notifications`
      // normalize identically, so every query sharing a call skeleton collided
      // regardless of which table or column it read. Renaming the head is what
      // keeps `input.data` and `payload.data` matching, which is the same logic
      // written with different parameter names.
      let k = i;
      while (k <= j) {
        if (k === i && isIdentifier(tokens[k])) result.push(renameId(tokens[k]));
        else result.push(tokens[k]);
        k++;
      }
      i = j + 1;
    }
  }

  return result;
}

// ─── Shingles + MinHash + LSH ─────────────────────────────────────────

export const DEFAULT_SHINGLE_SIZE = 5;
export const DEFAULT_PERMUTATIONS = 128;
export const DEFAULT_LSH_BANDS = 16;
export const DEFAULT_LSH_ROWS = 8;

export function buildShingles(tokens: string[], size = DEFAULT_SHINGLE_SIZE): string[] {
  if (tokens.length < size) return [tokens.join("\t")];
  const out: string[] = new Array(tokens.length - size + 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = tokens.slice(i, i + size).join("\t");
  }
  return out;
}

/**
 * 128 distinct, deterministic 32-bit seeds for the permutation family.
 * Using seeded FNV-1a isn't a theoretically perfect permutation family —
 * linear independence isn't guaranteed — but the deviation from ideal
 * collision probability is <1% for well-mixed inputs (shingle strings).
 */
function makePermSeeds(count: number): Uint32Array {
  const arr = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    arr[i] = Math.imul(0x811c9dc5 ^ (i * 0x9e3779b9), 16777619) >>> 0;
  }
  return arr;
}

let PERM_SEEDS: Uint32Array = makePermSeeds(DEFAULT_PERMUTATIONS);

/**
 * Seeds for `perms` permutations, grown on demand.
 *
 * The table used to be a fixed 128 entries indexed `p % 128`, so any caller
 * asking for more than 128 permutations silently got DUPLICATE hash rows: row
 * 128 was byte-identical to row 0. Duplicated rows are perfectly correlated, so
 * the extra bands carried no independent evidence while the LSH math assumed
 * they did — more permutations bought collision probability the signature could
 * not actually deliver. Growing the table keeps every row distinct.
 */
function permSeeds(count: number): Uint32Array {
  if (PERM_SEEDS.length < count) PERM_SEEDS = makePermSeeds(count);
  return PERM_SEEDS;
}

function fnv1aWithSeed(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function minHashSignature(shingles: string[], perms = DEFAULT_PERMUTATIONS): Uint32Array {
  const seeds = permSeeds(perms);
  const sig = new Uint32Array(perms);
  sig.fill(0xffffffff);
  for (const shingle of shingles) {
    for (let p = 0; p < perms; p++) {
      const h = fnv1aWithSeed(shingle, seeds[p]);
      if (h < sig[p]) sig[p] = h;
    }
  }
  return sig;
}

function bandKey(sig: Uint32Array, bandIdx: number, rows: number): string {
  const start = bandIdx * rows;
  let out = "";
  for (let r = 0; r < rows; r++) {
    out += (r === 0 ? "" : "|") + sig[start + r].toString(36);
  }
  return out;
}

/**
 * Above this bucket size, pairs are emitted sparsely instead of exhaustively.
 *
 * LSH is O(n) only while buckets stay small: one bucket of m members emits
 * m·(m-1)/2 candidate pair STRINGS, so a single bucket of 5,000 boilerplate
 * functions (generated CRUD, `export * from`, identical thin wrappers) produces
 * 12.5 million strings and dominates the whole scan's time and memory.
 *
 * Such a bucket cannot simply be skipped, though. Members that are identical on
 * one band are usually identical on EVERY band (a 200-strong cluster of
 * near-identical functions has near-identical signatures), so they land in the
 * same oversized bucket in all 16 bands and would never pair anywhere — the
 * whole cluster vanished from the report. Instead an oversized bucket emits
 * ~2·m pairs that keep it connected for the caller's clustering: every member
 * pairs with the bucket's first member (a star) and with its predecessor (a
 * chain). The star reaches each member in one hop even if one chain link fails
 * LCS verification; the chain gives each member a second, local witness. The
 * ceiling is that not every pair inside a giant cluster is LCS-verified
 * individually — the caller sees the cluster through its spanning pairs.
 */
const MAX_LSH_BUCKET = 200;

/**
 * Find all pairs of signatures that collide in at least one LSH band.
 * Candidates are indices into the passed array. Caller decides what to do
 * with them (typically: pass to `lcsSimilarity` for verification).
 *
 * @throws when `bands × rows` exceeds the signature length — the extra rows
 *         would read `undefined` off the end of the signature and every band key
 *         past the end would be the same string, silently bucketing everything
 *         together.
 */
export function findLshCandidatePairs(
  signatures: Uint32Array[],
  bands = DEFAULT_LSH_BANDS,
  rows = DEFAULT_LSH_ROWS,
): Set<string> {
  const candidates = new Set<string>();
  const sigLength = signatures[0]?.length ?? 0;
  if (signatures.length > 0 && bands * rows > sigLength) {
    throw new Error(
      `LSH configuration reads past the signature: ${bands} bands × ${rows} rows = ${bands * rows} > ${sigLength} permutations`,
    );
  }
  const addPair = (a: number, b2: number): void => {
    candidates.add(a < b2 ? `${a}-${b2}` : `${b2}-${a}`);
  };
  for (let b = 0; b < bands; b++) {
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < signatures.length; i++) {
      const key = bandKey(signatures[i], b, rows);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i);
      else buckets.set(key, [i]);
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      if (bucket.length > MAX_LSH_BUCKET) {
        // Star + chain: O(m) pairs that keep the bucket connected. See MAX_LSH_BUCKET.
        const hub = bucket[0];
        for (let x = 1; x < bucket.length; x++) {
          addPair(hub, bucket[x]);
          addPair(bucket[x - 1], bucket[x]);
        }
        continue;
      }
      for (let x = 0; x < bucket.length; x++) {
        for (let y = x + 1; y < bucket.length; y++) {
          addPair(bucket[x], bucket[y]);
        }
      }
    }
  }
  return candidates;
}

// ─── LCS similarity ───────────────────────────────────────────────────

/**
 * The lowest similarity any caller of `lcsSimilarity` flags at. The length-ratio
 * pre-filter is safe only below the threshold the caller will actually apply, so
 * the default has to sit at or under the most permissive one in the tree: the
 * deep-scan sampler's 0.55 borderline band, then 0.60 discovery
 * (find-similar-function), 0.70 flagging, 0.80 change validation.
 */
export const LCS_DEFAULT_MIN_SIMILARITY = 0.5;

/**
 * Longest-common-subsequence similarity between two token streams,
 * normalized to [0, 1] as `2 · LCS(a,b) / (|a| + |b|)`.
 * O(|a|·|b|) time, O(min(|a|,|b|)) space.
 *
 * Skips the DP entirely when the length ratio makes `minSimilarity`
 * unreachable. With `r = min/max`, the best possible score is a full
 * containment — LCS = min — which normalizes to `2·min/(min+max) = 2r/(1+r)`.
 * So the cheap test is `2r/(1+r) < minSimilarity`.
 *
 * The old form of this gate was `r < 0.5`, justified in its comment as
 * "impossible for LCS similarity to exceed 0.5". That is the wrong bound: at
 * r = 0.5 the ceiling is 2(0.5)/1.5 = 0.667, not 0.5. Everything from r = 1/3
 * (ceiling 0.5) up to r = 0.5 was returned as 0 despite a true similarity of up
 * to 0.645 — a 100-token function fully contained in a 210-token one scored 0
 * instead of 0.645, above BOTH the 0.60 discovery threshold and the sampler's
 * 0.55 band floor. Wrapper-and-inline and extract-a-helper duplication is
 * exactly the shape that lands in that ratio window, so the detector was blind
 * to the duplication class it most needs to see.
 *
 * @param minSimilarity the caller's own flagging threshold. Pass it to skip more
 *        DP work; the default is safe for every caller in the tree.
 */
export function lcsSimilarity(
  a: string[],
  b: string[],
  minSimilarity = LCS_DEFAULT_MIN_SIMILARITY,
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  const ratio = minLen / maxLen;
  if ((2 * ratio) / (1 + ratio) < minSimilarity) return 0;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const prev = new Int32Array(shorter.length + 1);
  const curr = new Int32Array(shorter.length + 1);

  for (let i = 1; i <= longer.length; i++) {
    for (let j = 1; j <= shorter.length; j++) {
      if (longer[i - 1] === shorter[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    prev.set(curr);
  }

  const lcs = prev[shorter.length];
  return (2 * lcs) / (a.length + b.length);
}

/**
 * One-shot: build a similarity signature for a function body.
 * Callers usually keep these around to pass to `findLshCandidatePairs`.
 */
export interface SimilaritySignature {
  tokens: string[];
  shingles: string[];
  signature: Uint32Array;
}

export function buildSignature(source: string): SimilaritySignature {
  const rawTokens = tokenize(source);
  const tokens = normalizeTokens(rawTokens);
  const shingles = buildShingles(tokens);
  const signature = minHashSignature(shingles);
  return { tokens, shingles, signature };
}
