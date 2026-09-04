/**
 * Taint-flow analysis with one-hop interprocedural propagation (L1.7-S2).
 *
 * Two phases:
 *
 *   Phase 1 — intraprocedural taint (existing).
 *     For each function, track tainted variables from sources (req.params,
 *     etc.) through assignments and sanitizers, and emit a flow when a
 *     tainted var reaches a dangerous sink (db.Query, exec, innerHTML, …).
 *
 *   Phase 2 — function summary + one-hop propagation (NEW).
 *     For each function, build a SUMMARY:
 *         paramsTainted: Set<index>   // indices of params that, if tainted
 *                                       at call site, would reach a sink
 *                                       within this function
 *     Then scan every function body for call sites `g(arg1, arg2, ...)`.
 *     If arg_i is currently tainted in the caller AND param_i is in
 *     g.summary.paramsTainted, emit a one-hop finding ("tainted value
 *     from f reaches a sink via g(arg_i)").
 *
 * Why one hop: catches the dominant pattern (handler → service with
 * unsanitized input). Doesn't recurse — full fixpoint iteration is
 * expensive and rarely catches what one hop misses.
 *
 * Limitations:
 *   - Only resolves calls by function name (no module/class scoping).
 *     Multiple functions with the same name in different files are all
 *     candidates; emit at reduced confidence.
 *   - If sanitization happens INSIDE the callee but outside the
 *     paramsTainted summary's view (e.g., the callee is over-conservative
 *     about its own taint), we may emit a false positive. Mitigated by
 *     requiring the source variable to be from a recognized taint source.
 */

import type { TaintFlow, TaintSource } from "./types.js";
import type { Finding } from "../core/types.js";
import type { ExtractedFunction } from "./types.js";
import { escapeRegex } from "../core/regex.js";

// ──── Taint Sources (user input entry points) ────

interface SourcePattern {
  regex: RegExp;
  label: string;
}

const TAINT_SOURCES: Record<string, SourcePattern[]> = {
  go: [
    { regex: /c\.Param\s*\(/, label: "URL parameter" },
    { regex: /c\.QueryParam\s*\(/, label: "query parameter" },
    { regex: /c\.Bind\s*\(/, label: "request body binding" },
    { regex: /c\.FormValue\s*\(/, label: "form value" },
    { regex: /r\.URL\.Query\s*\(\)/, label: "query string" },
    { regex: /r\.FormValue\s*\(/, label: "form value" },
    { regex: /json\.NewDecoder\s*\(\s*r\.Body/, label: "request body JSON" },
    { regex: /mux\.Vars\s*\(/, label: "URL path variable" },
  ],
  javascript: [
    { regex: /req\.params\.\w+/, label: "URL parameter" },
    { regex: /req\.query\.\w+/, label: "query parameter" },
    { regex: /req\.body\.\w+/, label: "request body" },
    { regex: /c\.req\.param\s*\(/, label: "Hono parameter" },
    { regex: /event\.(?:pathParameters|queryStringParameters)/, label: "Lambda parameter" },
  ],
  typescript: [
    { regex: /req\.params\.\w+/, label: "URL parameter" },
    { regex: /req\.query\.\w+/, label: "query parameter" },
    { regex: /req\.body\.\w+/, label: "request body" },
    { regex: /c\.req\.param\s*\(/, label: "Hono parameter" },
  ],
  python: [
    { regex: /request\.args\.get\s*\(/, label: "query parameter" },
    { regex: /request\.form\.get\s*\(/, label: "form value" },
    { regex: /request\.json/, label: "request JSON body" },
    { regex: /request\.GET\.get\s*\(/, label: "GET parameter" },
    { regex: /request\.POST\.get\s*\(/, label: "POST parameter" },
    { regex: /request\.data/, label: "request data" },
  ],
  rust: [
    { regex: /web::Path/, label: "URL path parameter" },
    { regex: /web::Query/, label: "query parameter" },
    { regex: /web::Json/, label: "request JSON body" },
  ],
};

// ──── Dangerous Sinks ────

interface SinkPattern {
  regex: RegExp;
  label: string;
  severity: "error" | "warning";
  category: string;
}

/**
 * Left boundary for a bare (undotted) call name.
 *
 * A sink regex like `/exec\s*\(/` has no left boundary at all, so it matched the
 * SUFFIX of every longer identifier and every member call. `RE.exec(userInput)`
 * — a RegExp match, the single most common `exec` in any JS/TS codebase —
 * reported an ERROR-severity command injection, `parseFunction(x)` reported
 * dynamic code evaluation, and `reopen(path)` reported path traversal. Requiring
 * that the name not be preceded by an identifier character OR a `.` restricts
 * these to genuine bare calls; the module forms (`child_process`, `os.Open`,
 * `subprocess.run`) have their own dotted patterns below, so the real sinks are
 * still reached.
 */
const BARE = "(?<![\\w$.])";

/**
 * A dotted call is a sink too when the receiver is a known alias for the module
 * or global that owns the real function: `cp.exec(cmd)` and `window.fetch(url)`
 * are exactly the calls the bare anchor was never meant to exclude. The receiver
 * must itself be bare, so `RE.cp.exec(` or `this.sh.exec(` — somebody's own
 * object, not the module — still do not qualify.
 */
function bareOrOn(receivers: string): string {
  return `(?:${BARE}|(?<=(?:^|[^\\w$.])(?:${receivers})\\.))`;
}
const EXEC_RECEIVERS = "child_process|childProcess|cp|proc|subprocess|shell|sh";
const FETCH_RECEIVERS = "window|globalThis|self|global|node";

const TAINT_SINKS: SinkPattern[] = [
  // SQL injection
  { regex: /db\.Query\s*\(/, label: "SQL query", severity: "error", category: "sql_injection" },
  { regex: /db\.Exec\s*\(/, label: "SQL exec", severity: "error", category: "sql_injection" },
  { regex: /\.query\s*\(\s*[`'"]/, label: "SQL query string", severity: "error", category: "sql_injection" },
  { regex: /cursor\.execute\s*\(/, label: "SQL execute", severity: "error", category: "sql_injection" },
  { regex: /\.raw\s*\(/, label: "raw SQL query", severity: "error", category: "sql_injection" },

  // Command injection
  { regex: new RegExp(`${bareOrOn(EXEC_RECEIVERS)}exec\\s*\\(`), label: "command execution", severity: "error", category: "command_injection" },
  { regex: new RegExp(`${bareOrOn(EXEC_RECEIVERS)}execSync\\s*\\(`), label: "sync command execution", severity: "error", category: "command_injection" },
  // `child_process.exec(` / `.execSync(` belong to the two patterns above; they
  // are excluded here so one call is not reported as two sinks. This entry still
  // covers the module's other calls (spawn, execFile, fork, ...).
  { regex: /child_process(?!\.exec(?:Sync)?\s*\()/, label: "child process", severity: "error", category: "command_injection" },
  { regex: /os\.system\s*\(/, label: "OS system call", severity: "error", category: "command_injection" },
  { regex: /subprocess\.(?:call|run|Popen)\s*\(/, label: "subprocess call", severity: "error", category: "command_injection" },

  // Path traversal
  { regex: /fs\.readFile\s*\(/, label: "file read", severity: "warning", category: "path_traversal" },
  { regex: /fs\.writeFile\s*\(/, label: "file write", severity: "warning", category: "path_traversal" },
  { regex: /os\.Open\s*\(/, label: "file open", severity: "warning", category: "path_traversal" },
  { regex: new RegExp(`${BARE}open\\s*\\(`), label: "file open", severity: "warning", category: "path_traversal" },

  // XSS
  { regex: /innerHTML\s*=/, label: "HTML injection", severity: "error", category: "xss" },
  { regex: /dangerouslySetInnerHTML/, label: "React HTML injection", severity: "error", category: "xss" },
  { regex: new RegExp(`${BARE}eval\\s*\\(`), label: "code evaluation", severity: "error", category: "code_injection" },
  { regex: new RegExp(`${BARE}Function\\s*\\(`), label: "dynamic function", severity: "error", category: "code_injection" },

  // Outbound (lower severity)
  { regex: new RegExp(`${bareOrOn(FETCH_RECEIVERS)}fetch\\s*\\(`), label: "outbound HTTP fetch", severity: "warning", category: "ssrf" },
  { regex: /http\.Get\s*\(/, label: "outbound HTTP GET", severity: "warning", category: "ssrf" },
  { regex: /axios\.\w+\s*\(/, label: "outbound HTTP request", severity: "warning", category: "ssrf" },
];

/**
 * Sink labels whose category is `code_injection` or `command_injection`
 * (unsanitized input reaching eval/exec). `Finding.message` (built in
 * `taintFindings` below) embeds the sink's human label, not its category, so
 * this is the real field a downstream consumer can match on to recognize an
 * eval/exec-class taint flow without duplicating TAINT_SINKS. Exported for
 * src/output/floor-badge.ts (the render-only "Security floor" badge, D1).
 */
export const INJECTION_SINK_LABELS: ReadonlySet<string> = new Set(
  TAINT_SINKS.filter((s) => s.category === "code_injection" || s.category === "command_injection").map(
    (s) => s.label,
  ),
);

// ──── Sanitizers that remove taint ────

interface SanitizerPattern {
  regex: RegExp;
  label: string;
  removes: string | "all";
}

/**
 * Left boundary for a sanitizer's call name.
 *
 * A false sanitizer is worse than a false sink: it SILENCES a real flow, and it
 * silences it for the rest of the function. Unanchored, `/int\s*\(/` was
 * satisfied by `print(`, `/Number\s*\(/` by `PhoneNumber(`, and `/escape\s*\(/`
 * by `unescape(` — the exact function that REINTRODUCES the characters escaping
 * removed. One `print(user)` for debugging, anywhere above a SQL sink, cleared
 * the taint on that variable and the injection went unreported.
 *
 * A preceding `.` is allowed (unlike sinks): `Number.parseInt(x)`,
 * `_.escape(x)` and `validator.escape(x)` are the idiomatic spellings and are
 * genuine sanitizers.
 */
const SAN = "(?<![\\w$])";

const SANITIZERS: SanitizerPattern[] = [
  // Type coercion (removes SQL injection for numbers)
  { regex: new RegExp(`${SAN}parseInt\\s*\\(`), label: "parseInt", removes: "sql_injection" },
  { regex: new RegExp(`${SAN}parseFloat\\s*\\(`), label: "parseFloat", removes: "sql_injection" },
  { regex: new RegExp(`${SAN}Number\\s*\\(`), label: "Number()", removes: "sql_injection" },
  { regex: new RegExp(`${SAN}strconv\\.Atoi\\s*\\(`), label: "strconv.Atoi", removes: "sql_injection" },
  { regex: new RegExp(`${SAN}strconv\\.Parse\\w+\\s*\\(`), label: "strconv.Parse*", removes: "sql_injection" },
  { regex: new RegExp(`${SAN}int\\s*\\(`), label: "int()", removes: "sql_injection" },

  // Parameterized queries
  { regex: /\$\d+/, label: "parameterized query ($N)", removes: "sql_injection" },
  { regex: /\?\s*(?:,|\)|\])/, label: "parameterized query (?)", removes: "sql_injection" },

  // Schema validation (removes all taint)
  { regex: /schema\.parse\s*\(/, label: "schema.parse()", removes: "all" },
  { regex: /\.validate\s*\(/, label: ".validate()", removes: "all" },
  { regex: new RegExp(`${SAN}zod\\.`, "i"), label: "Zod validation", removes: "all" },
  { regex: new RegExp(`${SAN}joi\\.`, "i"), label: "Joi validation", removes: "all" },

  // HTML escaping
  { regex: new RegExp(`${SAN}escape\\s*\\(`), label: "escape()", removes: "xss" },
  { regex: new RegExp(`${SAN}sanitize\\s*\\(`), label: "sanitize()", removes: "xss" },
  { regex: /DOMPurify/i, label: "DOMPurify", removes: "xss" },
  { regex: /html\.EscapeString/i, label: "html.EscapeString", removes: "xss" },

  // Path sanitization
  { regex: /path\.(?:join|resolve|normalize)\s*\(/, label: "path.join/resolve", removes: "path_traversal" },
  { regex: /filepath\.(?:Clean|Abs)\s*\(/, label: "filepath.Clean", removes: "path_traversal" },
];

// ──── Taint Tracking Engine (per-function scope) ────

interface TaintedVar {
  name: string;
  source: TaintSource;
  sanitizedFor: Set<string>; // categories sanitized
  /** Whole-identifier match for `name`; see `makeTaintedVar`. */
  mention: RegExp;
}

/**
 * Build a tainted-variable record, with its whole-identifier matcher compiled
 * ONCE at the point the variable becomes tainted (it is then tested against
 * every remaining line of the function).
 *
 * "Is this variable mentioned on this line" used to be `line.includes(name)`,
 * a raw substring test. A tainted `id` was therefore "present" on
 * `db.query("SELECT * FROM invalid_rows")` (inside `invalid`), on `validate(x)`,
 * on `width`, and on `userId` — so an unrelated line carrying a sink reported an
 * injection sourced from a variable that never reaches it, and an unrelated line
 * carrying a sanitizer cleared taint that was never sanitized. Short names (`id`,
 * `q`, `p`, `db`) are both the most common taint carriers and the most common
 * substrings of other identifiers.
 */
function makeTaintedVar(name: string, source: TaintSource): TaintedVar {
  return {
    name,
    source,
    sanitizedFor: new Set(),
    mention: new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])`),
  };
}

function extractAssignedVariable(line: string): string | null {
  // Go/JS/TS: var/const/let name = ... or name :=
  const declMatch = line.match(/(?:var|const|let)\s+(\w+)\s*[:=]/);
  if (declMatch) return declMatch[1];

  const shortDeclMatch = line.match(/(\w+)\s*:=/);
  if (shortDeclMatch) return shortDeclMatch[1];

  // Simple assignment: name = ...
  const assignMatch = line.match(/^(\w+)\s*=/);
  if (assignMatch) return assignMatch[1];

  // Python: name = ...
  const pyMatch = line.match(/^\s*(\w+)\s*=/);
  if (pyMatch) return pyMatch[1];

  return null;
}

const ALL_TAINT_CATEGORIES = new Set(["sql_injection", "command_injection", "path_traversal", "xss", "ssrf", "code_injection"]);

function identifySources(
  trimmed: string,
  langSources: SourcePattern[],
  lineNumber: number,
  taintedVars: Map<string, TaintedVar>,
): void {
  for (const src of langSources) {
    if (src.regex.test(trimmed)) {
      const varName = extractAssignedVariable(trimmed);
      if (varName) {
        taintedVars.set(
          varName,
          makeTaintedVar(varName, { type: src.label, variable: varName, line: lineNumber }),
        );
      }
    }
  }
}

function checkSanitizers(
  trimmed: string,
  taintedVars: Map<string, TaintedVar>,
): void {
  for (const [, tainted] of taintedVars) {
    if (!tainted.mention.test(trimmed)) continue;
    for (const san of SANITIZERS) {
      if (san.regex.test(trimmed)) {
        if (san.removes === "all") {
          tainted.sanitizedFor = new Set(ALL_TAINT_CATEGORIES);
        } else {
          tainted.sanitizedFor.add(san.removes);
        }
      }
    }
  }
}

function identifySinks(
  trimmed: string,
  fn: ExtractedFunction,
  lineNumber: number,
  taintedVars: Map<string, TaintedVar>,
  flows: TaintFlow[],
): void {
  for (const sink of TAINT_SINKS) {
    if (!sink.regex.test(trimmed)) continue;

    for (const [, tainted] of taintedVars) {
      if (!tainted.mention.test(trimmed)) continue;
      if (tainted.sanitizedFor.has(sink.category)) continue;

      // Check inline sanitization on the same line
      let inlineSanitized = false;
      for (const san of SANITIZERS) {
        if (san.regex.test(trimmed) && (san.removes === "all" || san.removes === sink.category)) {
          inlineSanitized = true;
          break;
        }
      }
      if (inlineSanitized) continue;

      flows.push({
        file: fn.file,
        relativePath: fn.relativePath,
        functionName: fn.name,
        source: tainted.source,
        sink: { type: sink.label, expression: trimmed.slice(0, 100), line: lineNumber, severity: sink.severity },
        sanitized: false,
        language: fn.language,
      });
    }
  }
}

function analyzeFunction(
  fn: ExtractedFunction,
): TaintFlow[] {
  const flows: TaintFlow[] = [];
  const lines = fn.rawBody.split("\n");
  const taintedVars = new Map<string, TaintedVar>();
  const langSources = TAINT_SOURCES[fn.language] ?? [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const lineNumber = fn.line + i;

    identifySources(trimmed, langSources, lineNumber, taintedVars);
    checkSanitizers(trimmed, taintedVars);
    identifySinks(trimmed, fn, lineNumber, taintedVars, flows);
  }

  return flows;
}

// ─── One-hop interprocedural taint (Phase 2) ─────────────────────────

/**
 * Per-function taint summary: which parameter indices, if tainted by a
 * caller, would reach a sink within this function. Computed by treating
 * each parameter as if it came from a synthetic source and checking which
 * parameters reach a sink.
 */
interface FunctionSummary {
  fn: ExtractedFunction;
  paramsTainted: Set<number>;   // indices of params that reach a sink
  sinkCategories: Set<string>;  // which sink categories are reached
}

function buildSummary(fn: ExtractedFunction): FunctionSummary {
  const paramsTainted = new Set<number>();
  const sinkCategories = new Set<string>();
  // Bare parameter NAMES, index-aligned with `params`. Reading `fn.params`
  // directly (which is what this did) compared `"id: string"` against
  // identifiers in the body, so no parameter ever matched in TypeScript, Go or
  // Rust and Phase 2 was silently dead outside plain JavaScript.
  const paramNames = fn.paramNames ?? fn.params;
  if (paramNames.length === 0) return { fn, paramsTainted, sinkCategories };

  // Treat every parameter as a synthetic taint source at function entry.
  const taintedVars = new Map<string, TaintedVar>();
  paramNames.forEach((p, idx) => {
    if (!p) return;
    taintedVars.set(p, makeTaintedVar(p, { type: `param[${idx}]`, variable: p, line: fn.line }));
  });
  if (taintedVars.size === 0) return { fn, paramsTainted, sinkCategories };

  const lines = fn.rawBody.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    checkSanitizers(trimmed, taintedVars);

    // Check for sinks reached by any still-tainted param.
    for (const sink of TAINT_SINKS) {
      if (!sink.regex.test(trimmed)) continue;
      for (const [varName, tainted] of taintedVars) {
        if (!tainted.mention.test(trimmed)) continue;
        if (tainted.sanitizedFor.has(sink.category)) continue;
        const idx = paramNames.indexOf(varName);
        if (idx >= 0) {
          paramsTainted.add(idx);
          sinkCategories.add(sink.category);
        }
      }
    }
  }

  return { fn, paramsTainted, sinkCategories };
}

/**
 * Scan a caller function's body for call sites of any function in
 * `summaryByName`. When the caller is passing a tainted arg into a
 * tainted-param slot of the callee, emit a one-hop finding.
 */
function findOneHopFlows(
  caller: ExtractedFunction,
  summaryByName: Map<string, FunctionSummary[]>,
): TaintFlow[] {
  const flows: TaintFlow[] = [];
  const lines = caller.rawBody.split("\n");
  const langSources = TAINT_SOURCES[caller.language] ?? [];
  const taintedVars = new Map<string, TaintedVar>();

  // First pass: track caller-local taint
  for (let i = 0; i < lines.length; i++) {
    identifySources(lines[i].trim(), langSources, caller.line + i, taintedVars);
    checkSanitizers(lines[i].trim(), taintedVars);
  }

  // Second pass: look for call sites and check args against summaries
  const callPattern = /\b(\w+)\s*\(([^()]*)\)/g;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    let m;
    const re = new RegExp(callPattern.source, callPattern.flags);
    while ((m = re.exec(trimmed)) !== null) {
      const calleeName = m[1];
      if (calleeName === caller.name) continue; // skip self-calls
      const candidates = summaryByName.get(calleeName);
      if (!candidates) continue;

      const argsRaw = m[2].split(",").map((s) => s.trim());

      for (const summary of candidates) {
        if (summary.fn === caller) continue;
        for (const taintedIdx of summary.paramsTainted) {
          if (taintedIdx >= argsRaw.length) continue;
          const arg = argsRaw[taintedIdx];
          // Strip simple wrappers like `safe(x)` to get the leaf identifier
          const leaf = arg.replace(/^[!\s(]+|[)!\s]+$/g, "").split(/[.[]/)[0];
          const tainted = taintedVars.get(leaf);
          if (!tainted) continue;
          // If the arg has been sanitized for ALL the sink categories the
          // callee reaches, no finding.
          const allSanitized = [...summary.sinkCategories].every((c) =>
            tainted.sanitizedFor.has(c),
          );
          if (allSanitized) continue;

          flows.push({
            file: caller.file,
            relativePath: caller.relativePath,
            functionName: caller.name,
            source: tainted.source,
            sink: {
              type: `${calleeName}() reaches ${[...summary.sinkCategories].join("/")} sink`,
              expression: trimmed.slice(0, 100),
              line: caller.line + i,
              severity: "warning",
            },
            sanitized: false,
            language: caller.language,
          });
        }
      }
    }
  }

  return flows;
}

export function analyzeTaintFlows(functions: ExtractedFunction[]): TaintFlow[] {
  const allFlows: TaintFlow[] = [];

  // Phase 1: intraprocedural
  for (const fn of functions) {
    allFlows.push(...analyzeFunction(fn));
  }

  // Phase 2: build summaries then one-hop check
  const summaryByName = new Map<string, FunctionSummary[]>();
  for (const fn of functions) {
    const s = buildSummary(fn);
    if (s.paramsTainted.size === 0) continue;
    const list = summaryByName.get(fn.name);
    if (list) list.push(s);
    else summaryByName.set(fn.name, [s]);
  }
  for (const fn of functions) {
    allFlows.push(...findOneHopFlows(fn, summaryByName));
  }

  return allFlows;
}

export function taintFindings(flows: TaintFlow[]): Finding[] {
  // Deduplicate by file+function+sink type
  const seen = new Set<string>();

  return flows
    .filter((flow) => {
      const key = `${flow.relativePath}:${flow.functionName}:${flow.sink.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((flow) => ({
      analyzerId: "codedna-taint",
      severity: flow.sink.severity,
      confidence: 0.75,
      message: `Unsanitized ${flow.source.type} reaches ${flow.sink.type} in ${flow.functionName}(): ${flow.source.variable} (line ${flow.source.line}) → ${flow.sink.type} (line ${flow.sink.line})`,
      locations: [
        { file: flow.relativePath, line: flow.source.line, snippet: `${flow.source.variable} = ${flow.source.type}` },
        { file: flow.relativePath, line: flow.sink.line, snippet: flow.sink.expression.slice(0, 80) },
      ],
      tags: ["codedna", "taint", "security"],
    }));
}
