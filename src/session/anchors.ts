/**
 * Deterministic task anchors extracted from a prompt (Phase 3, free tier). No
 * ML: file paths, backticked symbols, and identifier tokens the user named
 * become the task's targets; follow-up prompts extend them. Used only for the
 * conservative scope-drift signal, which ships labeled experimental.
 */

export interface Anchors {
  files: string[];
  symbols: string[];
  tokens: string[];
}

// Prose stopwords + ubiquitous programming words. The token signal only works
// if anchor tokens are DISTINCTIVE (stripe, webhook, billing) — generic code
// words (return, error, export, value, response) appear in almost every file
// and would make every edit look "related", neutering the scope signal.
const STOPWORDS = new Set([
  // prose
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "add",
  "use", "using", "follow", "make", "also", "then", "when", "should", "would",
  "like", "have", "will", "some", "them", "they", "want", "need", "please",
  "here", "there", "where", "which", "while", "about", "over", "onto", "each",
  // generic programming words
  "code", "file", "files", "function", "functions", "route", "routes", "handler",
  "handlers", "return", "returns", "export", "exports", "import", "imports",
  "const", "async", "await", "throw", "catch", "class", "type", "types", "void",
  "null", "true", "false", "undefined", "value", "values", "result", "results",
  "response", "request", "params", "config", "data", "index", "name", "names",
  "props", "state", "event", "events", "callback", "promise", "string", "number",
  "boolean", "object", "array", "console", "message", "error", "errors", "update",
  "create", "delete", "user", "users", "test", "tests", "mock", "util", "utils",
  "helper", "helpers", "common", "shared", "base", "core", "main", "page", "pages",
]);

const uniq = (xs: string[]): string[] => [...new Set(xs)];

export function extractAnchors(prompt: string): Anchors {
  const pathFiles: string[] = [];
  // a slash-separated path that ends in a file extension (routes/billing.ts).
  // The extension requirement stops prose like "async/await" or "and/or" from
  // being captured as a file.
  for (const m of prompt.matchAll(/\b[\w.-]*\/[\w./-]*\.[a-z][a-z0-9]{0,4}\b/gi)) pathFiles.push(m[0]);
  const pathBases = new Set(pathFiles.map((f) => baseName(f).toLowerCase()));
  const files: string[] = [...pathFiles];
  for (const m of prompt.matchAll(/\b[\w-]+\.[A-Za-z][\w]*\b/g)) {
    // a bare dotted filename like package.json; skip when a path anchor already
    // covers the same basename (routes/billing.ts vs billing.ts) so coverage
    // does not double-count one file.
    if (
      /\.(ts|tsx|js|jsx|py|go|rs|json|md|yml|yaml|toml|css|html|sql)$/i.test(m[0]) &&
      !pathBases.has(m[0].toLowerCase())
    ) {
      files.push(m[0]);
    }
  }

  const symbols: string[] = [];
  // backticked code spans: `handleStripeWebhook`, `apiClient.get`
  for (const m of prompt.matchAll(/`([^`]+)`/g)) {
    const inner = m[1].trim();
    if (/^[A-Za-z_$][\w$.]*$/.test(inner)) symbols.push(inner.split(".")[0]);
  }
  // lowerCamelCase identifiers (a lowercase start with an internal capital) —
  // these are unambiguously code symbols. Bare Capitalized words are NOT
  // captured: they swallow ordinary prose (Update, User, Error) and made
  // relatedness match nearly every file.
  for (const m of prompt.matchAll(/\b([a-z][a-z0-9]*[A-Z]\w*)\b/g)) symbols.push(m[1]);
  // explicit call sites: word(  or  word.word
  for (const m of prompt.matchAll(/\b([a-zA-Z_$][\w$]{2,})\s*\(/g)) symbols.push(m[1]);

  const tokens: string[] = [];
  for (const m of prompt.toLowerCase().matchAll(/\b[a-z][a-z0-9]{3,}\b/g)) {
    const w = m[0];
    if (!STOPWORDS.has(w)) tokens.push(w);
  }

  return { files: uniq(files), symbols: uniq(symbols), tokens: uniq(tokens) };
}

export function mergeAnchors(a: Anchors, b: Anchors): Anchors {
  return {
    files: uniq([...a.files, ...b.files]),
    symbols: uniq([...a.symbols, ...b.symbols]),
    tokens: uniq([...a.tokens, ...b.tokens]),
  };
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** True when the edited file is (or is within) an anchor file. Path anchors
 *  match by exact path or a separator-bounded suffix; bare filenames match by
 *  basename. Bounded so "a.ts" never matches "banana.ts". */
export function fileMatchesAnchors(relFile: string, files: string[]): boolean {
  const rf = relFile.toLowerCase().replace(/\\/g, "/");
  const rfBase = baseName(rf);
  for (const raw of files) {
    const f = raw.toLowerCase().replace(/\\/g, "/");
    if (f.includes("/")) {
      if (rf === f || rf.endsWith(`/${f}`)) return true;
    } else if (rfBase === f) {
      return true;
    }
  }
  return false;
}

export function editRelatesToAnchors(relFile: string, body: string, anchors: Anchors): boolean {
  if (fileMatchesAnchors(relFile, anchors.files)) return true;

  // Tokenize the body ONCE (no per-anchor regex): identifier set (case-kept for
  // symbols) + lowercased set for token matching.
  const idents = body.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const identSet = new Set(idents);
  const lowerJoined = `${relFile} ${idents.join(" ")}`.toLowerCase();

  // body uses an anchor symbol verbatim
  for (const s of anchors.symbols) {
    if (s.length >= 3 && identSet.has(s)) return true;
  }
  // shares a DISTINCTIVE task token (anchor tokens are already stopword-filtered,
  // so a substring hit like "webhook" in "webhookRouter" is meaningful, not noise)
  for (const t of anchors.tokens) {
    if (t.length >= 4 && lowerJoined.includes(t)) return true;
  }
  return false;
}

export function taskSummary(prompt: string): string {
  const firstLine = prompt.split("\n")[0].trim().replace(/\s+/g, " ");
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
