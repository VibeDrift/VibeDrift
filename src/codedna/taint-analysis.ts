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

const TAINT_SINKS: SinkPattern[] = [
  // SQL injection
  { regex: /db\.Query\s*\(/, label: "SQL query", severity: "error", category: "sql_injection" },
  { regex: /db\.Exec\s*\(/, label: "SQL exec", severity: "error", category: "sql_injection" },
  { regex: /\.query\s*\(\s*[`'"]/, label: "SQL query string", severity: "error", category: "sql_injection" },
  { regex: /cursor\.execute\s*\(/, label: "SQL execute", severity: "error", category: "sql_injection" },
  { regex: /\.raw\s*\(/, label: "raw SQL query", severity: "error", category: "sql_injection" },

  // Command injection
  { regex: /exec\s*\(/, label: "command execution", severity: "error", category: "command_injection" },
  { regex: /execSync\s*\(/, label: "sync command execution", severity: "error", category: "command_injection" },
  { regex: /child_process/, label: "child process", severity: "error", category: "command_injection" },
  { regex: /os\.system\s*\(/, label: "OS system call", severity: "error", category: "command_injection" },
  { regex: /subprocess\.(?:call|run|Popen)\s*\(/, label: "subprocess call", severity: "error", category: "command_injection" },

  // Path traversal
  { regex: /fs\.readFile\s*\(/, label: "file read", severity: "warning", category: "path_traversal" },
  { regex: /fs\.writeFile\s*\(/, label: "file write", severity: "warning", category: "path_traversal" },
  { regex: /os\.Open\s*\(/, label: "file open", severity: "warning", category: "path_traversal" },
  { regex: /open\s*\(/, label: "file open", severity: "warning", category: "path_traversal" },

  // XSS
  { regex: /innerHTML\s*=/, label: "HTML injection", severity: "error", category: "xss" },
  { regex: /dangerouslySetInnerHTML/, label: "React HTML injection", severity: "error", category: "xss" },
  { regex: /eval\s*\(/, label: "code evaluation", severity: "error", category: "code_injection" },
  { regex: /Function\s*\(/, label: "dynamic function", severity: "error", category: "code_injection" },

  // Outbound (lower severity)
  { regex: /fetch\s*\(/, label: "outbound HTTP fetch", severity: "warning", category: "ssrf" },
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

const SANITIZERS: SanitizerPattern[] = [
  // Type coercion (removes SQL injection for numbers)
  { regex: /parseInt\s*\(/, label: "parseInt", removes: "sql_injection" },
  { regex: /parseFloat\s*\(/, label: "parseFloat", removes: "sql_injection" },
  { regex: /Number\s*\(/, label: "Number()", removes: "sql_injection" },
  { regex: /strconv\.Atoi\s*\(/, label: "strconv.Atoi", removes: "sql_injection" },
  { regex: /strconv\.Parse\w+\s*\(/, label: "strconv.Parse*", removes: "sql_injection" },
  { regex: /int\s*\(/, label: "int()", removes: "sql_injection" },

  // Parameterized queries
  { regex: /\$\d+/, label: "parameterized query ($N)", removes: "sql_injection" },
  { regex: /\?\s*(?:,|\)|\])/, label: "parameterized query (?)", removes: "sql_injection" },

  // Schema validation (removes all taint)
  { regex: /schema\.parse\s*\(/, label: "schema.parse()", removes: "all" },
  { regex: /\.validate\s*\(/, label: ".validate()", removes: "all" },
  { regex: /zod\./i, label: "Zod validation", removes: "all" },
  { regex: /joi\./i, label: "Joi validation", removes: "all" },

  // HTML escaping
  { regex: /escape\s*\(/, label: "escape()", removes: "xss" },
  { regex: /sanitize\s*\(/, label: "sanitize()", removes: "xss" },
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
        taintedVars.set(varName, {
          name: varName,
          source: { type: src.label, variable: varName, line: lineNumber },
          sanitizedFor: new Set(),
        });
      }
    }
  }
}

function checkSanitizers(
  trimmed: string,
  taintedVars: Map<string, TaintedVar>,
): void {
  for (const [varName, tainted] of taintedVars) {
    if (!trimmed.includes(varName)) continue;
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

    for (const [varName, tainted] of taintedVars) {
      if (!trimmed.includes(varName)) continue;
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
  if (fn.params.length === 0) return { fn, paramsTainted, sinkCategories };

  // Treat every parameter as a synthetic taint source at function entry.
  const taintedVars = new Map<string, TaintedVar>();
  fn.params.forEach((p, idx) => {
    if (!p) return;
    taintedVars.set(p, {
      name: p,
      source: { type: `param[${idx}]`, variable: p, line: fn.line },
      sanitizedFor: new Set(),
    });
  });

  const lines = fn.rawBody.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    checkSanitizers(trimmed, taintedVars);

    // Check for sinks reached by any still-tainted param.
    for (const sink of TAINT_SINKS) {
      if (!sink.regex.test(trimmed)) continue;
      for (const [varName, tainted] of taintedVars) {
        if (!trimmed.includes(varName)) continue;
        if (tainted.sanitizedFor.has(sink.category)) continue;
        const idx = fn.params.indexOf(varName);
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
