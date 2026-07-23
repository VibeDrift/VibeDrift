# Layer 1: Static Analyzers

The 13 static analyzers are the free, local, always-on layer of a scan. Each one reads the full `AnalysisContext` (all files, ASTs, manifests) and returns a list of findings. They are deliberately conservative: an analyzer that cries wolf gets ignored, so nearly every one aggregates related evidence into a single finding, applies minimum-count thresholds before emitting anything, and carries an explicit confidence value that the scoring engine uses to discount uncertain signals.

This chapter covers how analyzers plug into the pipeline, the shape of a finding, and then each analyzer: what it detects, the algorithm and thresholds, and a real example of code it flags.

## Registration, caching, and the drift/hygiene split

An analyzer implements the `Analyzer` interface (`src/analyzers/base.ts`):

```typescript
// src/analyzers/base.ts
export interface Analyzer {
  id: string;
  name: string;
  category: ScoringCategory;          // which of the 5 score buckets it feeds
  requiresAST: boolean;
  applicableLanguages: SupportedLanguage[] | "all";
  version?: number;                   // cache-invalidation knob, defaults to 1
  analyze(ctx: AnalysisContext): Promise<Finding[]>;
}
```

`createAnalyzerRegistry()` (`src/analyzers/index.ts`) returns the 13 instances in a fixed declaration order. `runAnalyzers` executes them concurrently and reassembles findings in that order, so output is deterministic. Each analyzer's results are cached under a key derived from its `id`, its `version`, and the content hashes of the files it applies to: edit one Python file and the JS/TS-only `imports` analyzer still replays from cache (an analyzer declaring `applicableLanguages: "all"`, like `language-specific`, keys on every file and re-runs). When you change an analyzer's logic, bump its `version` or stale cached findings will keep appearing until the TTL expires.

One classification matters more than any other here. Every analyzer id is assigned a `kind` in `src/scoring/categories.ts`: `drift` (grounded in the repo's own dominant pattern) or `hygiene` (a generic check any linter could make, no repo baseline). Among the 13 static analyzers only `naming` and `imports` are drift-kind. The other 11 feed the parallel Hygiene Score and never move the headline Vibe Drift Score. This is the product identity enforced in code: VibeDrift measures drift, and a generic empty-catch finding, however real, is not drift.

> [!IMPORTANT]
> Unknown analyzer ids default to hygiene (`getAnalyzerKind` in `src/scoring/categories.ts`). If you add an analyzer and expect it to affect the headline score, you must register it as drift-kind in `CATEGORY_CONFIG`; forgetting this fails safe (the score ignores it) but silently.

## The Finding shape

Every analyzer, drift detector, and Code DNA module emits the same structure (`src/core/types.ts`):

```typescript
// src/core/types.ts (abridged)
export interface Finding {
  analyzerId: string;
  severity: "info" | "warning" | "error";
  confidence: number;                // 0.0-1.0
  message: string;
  locations: FileLocation[];
  tags: string[];
  consistencyImpact?: number;        // score gain if resolved; set by computeScores
  driftSignal?: { consistencyScore: number; dominantCount: number; totalRelevantFiles: number };
  dupGroupSize?: number;             // for grouped duplicate findings
}
```

`severity` and `confidence` are independent axes and both feed scoring: severity says how bad the pattern is if real, confidence says how sure the analyzer is that it is real. Static analyzers never set `driftSignal` (that field is populated by `driftFindingToFinding` for cross-file detectors); its absence is how the scoring engine knows to use count-based rather than dominance-based magnitude for a detector group.

The examples below draw on the repo's own end-to-end fixture at `test/fixtures/messy-project/`, a deliberately messy Express app that most of these analyzers flag.

## Convention analyzers (drift-kind)

### `naming`: Naming Conventions

Detects a codebase split between identifier conventions (camelCase vs snake_case), gated by entropy so that a genuinely mixed codebase is reported as "no convention" rather than as hundreds of deviations.

The algorithm (`src/analyzers/naming.ts`, v2): extract declared identifiers by walking declarator AST nodes when a tree exists, falling back to a regex over `const|let|var|function|def|func|fn` otherwise. Identifiers of length 1 or starting with `_` are skipped, and PascalCase and SCREAMING_SNAKE are excluded from the vote (they legitimately coexist with either convention for types and constants). Then compute Shannon entropy over the convention counts, normalized by `log2(k)`:

- `normalizedH > 0.8`: one info finding, "No dominant naming convention", confidence 0.75. There is no majority to deviate from, so flagging individual files would be noise.
- Otherwise: flag each minority convention used in at least 2 unique files as a warning, with confidence `clamp(1 - H, 0.3, 0.9)`. The tighter the dominant convention, the more confident the analyzer is that a deviation is real drift.

Example from the fixture: `src/data.ts` declares `fetchData`, `getData`, `processData` (camelCase) while `src/users.ts` declares `get_users`, `get_user_by_id`, `fetch_user_data` (snake_case). That mix trips the entropy gate, so the run emits the single info finding at confidence 0.75 reporting no dominant naming convention, counting camelCase in 4 files against snake_case in 3; the minority-deviation warning never fires here, because there is no majority to deviate from.

### `imports`: Import Patterns

Detects ESM/CommonJS mixing in JS/TS projects, with enough context awareness to avoid the classic false positive: `require("fs")` or `require("node:stream")` for Node builtins is a legitimate pattern inside ESM and is not drift, while `require("./utils")` or `require("lodash")` in an otherwise-ESM project is (`src/analyzers/imports.ts`, v2).

Config files (which routinely must be CJS) are skipped via a filename pattern, fixture paths are skipped, and comments, template literals, and regex literals are stripped before matching so a `require(` inside a string cannot fire. Two finding shapes come out: a per-file "Mixed ESM and non-builtin CommonJS" warning at confidence 0.9, and a project-level "Mixed ESM/CommonJS across project: N ESM, M CJS" warning at confidence 0.85 listing the minority-side files.

Example: the fixture's `src/app.js` opens with `const express = require('express');` and ends with `module.exports = app;` while its sibling `.ts` files use `import`/`export`. Only the project-level finding fires, as `Mixed ESM/CommonJS across project: 3 ESM files, 1 CJS files`. The per-file shape needs ESM and CommonJS inside the same file, and `src/app.js` is pure CommonJS: `module.exports` does not match the ESM pattern, which looks for `import`/`export` statements.

## Robustness analyzers (hygiene)

### `error-handling`: Error Handling

Two independent checks for JS/TS (`src/analyzers/error-handling.ts`):

- **Empty catch blocks**, matched by the regex `catch\s*\([^)]*\)\s*\{\s*\}`. All hits aggregate into one finding: severity error when the count exceeds 5, warning otherwise, confidence 0.95 (an empty catch is nearly always exactly what it looks like).
- **Unhandled async**: find `async` function headers, extract bodies by brace-depth counting, and flag bodies that `await` without any of `try`, `.catch(`, `catch(`, or a `Result`/`Either` type mention. Emitted per directory, and only when a directory accumulates more than 3 such functions (info, confidence 0.6). The directory threshold exists because a single fire-and-forget await is often intentional; a directory full of them is a habit.

Example: `src/data.ts` in the fixture ends with `export async function processData(items) { try { ... } catch (e) {} }`, an empty catch that lands in the aggregated finding.

This analyzer is JS/TS only because empty `catch` and un-awaited async are JavaScript shapes. Error handling for Go, Python, and Rust is not absent; it lives in `language-specific` below (Go unchecked `err`, Python bare `except`, Rust `.unwrap()` overuse), which tags those findings `error-handling` too.

### `language-specific`: Language-Specific Patterns

A grab bag of per-language idiom checks that do not fit the shared analyzers, including the error-handling checks for Go, Python, and Rust (`src/analyzers/language-specific.ts`):

- **Go**: unchecked `err` assignments, flagged when the next non-comment line neither mentions `err` nor starts with `return` (warning, escalating to error above 10 hits, confidence 0.7); goroutines launched with no `ctx`/`context.` within 2 lines (warning, 0.6); `.Lock()` with no `defer .Unlock()` in the next 3 lines (warning, 0.75, "risk of deadlock").
- **Python**: bare `except:` (error, confidence 0.95); mutable default arguments `=[]`, `={}`, `=set()` (warning, 0.9).
- **Rust**: more than 2 `.unwrap()` calls (warning, error above 20, confidence 0.8); `unsafe {` blocks (warning, error above 5, confidence 0.85).

Example: `def load(items=[]):` is flagged as a mutable default argument, one of the oldest Python footguns (the list is shared across calls).

## Redundancy analyzers (hygiene)

### `duplicates`: Code Duplication

Finds near-identical function bodies across files. It is a thin wrapper over the shared MinHash pipeline in `src/codedna/minhash.ts`: tokenize, normalize (preserving call targets so `fetchUsers()` and `fetchOrders()` do not collapse into the same body), shingle with k=5, hash into 128-permutation MinHash signatures, band into an LSH index (16 bands of 8 rows), then verify candidate pairs with an LCS similarity check. The banding math makes candidate lookup near-linear instead of O(n²) over all function pairs; the LCS verification step is what keeps precision high.

Thresholds (`src/analyzers/duplicates.ts`, v3): function bodies under 20 characters or 15 normalized tokens are skipped (too short to be meaningful duplicates), candidate pairs must be cross-file with a token-length ratio of at least 0.6, and only pairs with LCS similarity at or above `FLAG_THRESHOLD = 0.7` are flagged. One aggregated finding: error above 5 unique pairs, warning otherwise, confidence 0.75, with "% similar" snippets in the locations.

Example of the cross-file rule at work: the fixture's `fetchData()` and `getData()` in `src/data.ts` are byte-identical fetch wrappers, yet this analyzer emits nothing on the fixture, because both live in the same file and same-file candidate pairs are skipped (`if (a.file === b.file) continue;` in `duplicates.ts`). Paste either function into a second file and the pair gets flagged.

```typescript
// test/fixtures/messy-project/src/data.ts
export function fetchData() {
  return fetch('/api/data').then(r => r.json());
}
export function getData() {
  return fetch('/api/data').then(r => r.json());
}
```

### `todo-density`: TODO/FIXME Density

Counting TODOs is easy; deciding how many is too many for this repo is the actual problem. This analyzer (`src/analyzers/todo-density.ts`, v2) matches `\b(TODO|FIXME|HACK|XXX|TEMP)\b` and then applies a per-file Poisson outlier test: with `λ` = total TODO count divided by file count as the expected rate, a file with `k` TODOs is flagged only when `P(X >= k | λ) < 0.05`. A repo that is uniformly 2-TODOs-per-file flags nothing; the one file with 12 while the rest have none gets flagged. Requires at least 3 files (no meaningful baseline below that); severity error when the file has 10 or more TODOs; confidence 1.0 (the count is a fact, not an inference).

A second signal escalates TODOs sitting within 5 lines of stub-shaped code (placeholder returns, `raise NotImplementedError`, `unimplemented!(`, Go `panic("not implemented"`): those produce a separate finding at confidence 0.95, warning (error at 3 or more hits), because a TODO next to a stub marks unfinished shipped behavior rather than a note-to-self. A project-level info summary with density per 1000 lines is emitted whenever the repo contains at least one marker; a zero-TODO repo produces no findings at all.

Example: the fixture's `src/app.js` has three consecutive marker lines near the top (`// TODO: fix this before launch`, `// FIXME: this is a hack`, `// HACK: temporary workaround`), yet the only finding the fixture produces is the info summary, `9 TODOs/FIXMEs across 3 files (density: 81.1/1K lines)`. The markers are spread evenly enough that no single file's count clears the `P < 0.05` outlier test against the repo-wide rate, which is exactly the discipline the Poisson test enforces: a repo-wide habit is reported as a rate, not as per-file findings.

### `dead-code`: Dead Code Detection

For JS/TS this analyzer builds a real import graph (`buildImportGraph`, `src/core/import-graph.ts`) rather than grepping, and reports at two granularities (`src/analyzers/dead-code.ts`, v7, the highest version number in the registry, which reflects how much false-positive history this one has absorbed):

- **Symbol-level**: exported names that no file imports and that appear at most once in their own file (the declaration itself). Emitted only when more than 3 dead exports exist; error above 10; confidence 0.8.
- **File-level**: files with zero incoming imports, minus a long exclusion list learned from real repos: entry-point basenames (`index`, `main`, `app`, `server`, `mod`, `lib`, `init`, `__init__`, `setup`, `config`, `routes`, `handler(s)`, `cli`), test/config/`.d.ts`/`.worker.` patterns, and worker runtime roots referenced via `new Worker('X')` or `getURL('X')` strings. Warning above 5 orphans, else info, confidence 0.85.

Go and Python use simpler whole-corpus occurrence counting (a symbol appearing at most once is presumed dead), at accordingly lower confidences of 0.55 and 0.5, with Python `_private` definitions skipped. A separate unreachable-code check flags a line following a complete `return`/`throw`/`break`/`continue` at the same or deeper indent (warning, confidence 0.65).

Example: `export function retrieveData(id)` in the fixture's `src/data.ts` is exported but never imported by any other fixture file, so it lands in the dead-exports finding.

## Dependency and configuration analyzers (hygiene)

### `dependencies`: Dependency Health

Cross-references what a manifest declares against what the code imports, in both directions, for all four ecosystems (`src/analyzers/dependencies.ts`, v3).

For JS/TS: declared means dependencies, devDependencies, peerDependencies, optionalDependencies, plus the package's own name; imports are collected from the AST when a tree exists, regex otherwise. The interesting engineering is in the false-positive suppression for **phantom dependencies** (declared, never imported): dev-tool names (linters, bundlers, type packages) are excluded by pattern, and build-config references count as usage, so a webpack loader named only as a string in `webpack.config.js` is not phantom. Error above 5 phantoms, confidence 0.75. For **missing dependencies** (imported, not declared): path-alias and virtual-module imports are skipped, and detected monorepos drop severity to warning and confidence to 0.4, because the package is usually declared in a sibling workspace manifest the analyzer is not looking at.

Go compares `go.mod` requires against imports (stdlib detected by the absence of a dot anywhere in the import path). Multi-module repos are handled per module: every nested `go.mod` under the scan root is parsed, and each `.go` file is checked against its **nearest enclosing** module, not the root one, so a dependency declared in a `tools/` module, an example module, or a `go.work` service is recognized as declared. A declared module matches an import when it is the import path or a path-segment prefix of it, so multi-segment module paths (`github.com/org/sdk/submodule`) and `/vN` major-version suffixes resolve correctly. Imports of a sibling in-repo module are never counted missing, and `// indirect` requires are excluded from the unused-module check (they are transitive, never imported directly). Python compares requirements against `import`/`from` statements with 40+ stdlib names excluded and flags phantoms only above 2; Rust compares Cargo dependencies against `use` statements with `-` to `_` normalization.

Example: the fixture's `package.json` declares `moment`, `unused-package`, and `another-unused`, none of which any source file imports. All three land in one phantom-dependencies finding, but the emitted message is `4 phantom dependencies (declared but unused): moment, unused-package, another-unused, messy-project`: the analyzer adds the package's own name to the declared set (so self-imports are not reported as missing), and the phantom check does not exclude that entry, so the self-name is counted too.

### `config-drift`: Config Drift

Detects environment variables drifting out of sync with `.env.example` (`src/analyzers/config-drift.ts`, v2). It knows the access pattern for every supported language: `process.env.X` and `import.meta.env.X`, `os.environ.get("X")` (the call form only; the bracket subscript `os.environ["X"]` is not matched), `os.Getenv("X")`, `env::var("X")`.

Three findings: a variable read in code but missing from `.env.example` (warning per variable, confidence 0.85, `NODE_*` skipped); a variable declared in `.env.example` that no code reads (single info, 0.7); and no `.env.example` at all while the code reads more than 3 env vars (info, 0.7). The direction matters: a missing example entry breaks the next developer's onboarding, a stale one merely lies, and the analyzer weights them accordingly.

Example: the fixture's `src/app.js` reads `process.env.SESSION_SECRET` and `process.env.REDIS_URL`, but its `.env.example` declares only `DATABASE_URL` and `API_KEY`. Both variables get flagged as undocumented.

## Security (hygiene)

### `security`: Security Posture

Twenty regex rules in `SECURITY_PATTERNS` (`src/analyzers/security.ts`, v3) covering hardcoded secrets (API keys, tokens, `-----BEGIN ... PRIVATE KEY-----` blocks, AWS `(AKIA|ASIA)[A-Z0-9]{16}` key ids), injection (template-literal SQL in JS, `fmt.Sprintf` inside `db.Query` in Go, `shell=True` in Python), unsafe sinks (`eval(`, `new Function(`, `innerHTML =`, `dangerouslySetInnerHTML`), weak crypto (md5, sha1, `Math.random()` near security-sensitive context), path traversal, SSRF, `pickle.load`, unsafe `yaml.load`, Go `InsecureSkipVerify: true`, and Rust `unsafe {`.

Not all 20 rules are equal, and the rule metadata encodes that:

- **`floor: true`** (5 rules: hardcoded-api-key, hardcoded-token, private-key, aws-key, go-tls-skip-verify) emit under the distinct analyzer id `security-floor`. These are the near-zero-false-positive rules; the separate id lets the report render a high-precision badge. Still hygiene-kind: even a certain hardcoded key is a hygiene fact, not drift.
- **`demoted: true`** (5 rules: innerHTML-assignment, math-random-crypto, path-traversal, ssrf-risk, rust-unsafe) are forced to severity `info` and tagged `demoted`, because their regexes catch too many legitimate uses to warrant a warning.

Regex security scanning lives or dies on false-positive control, so four mechanisms stack: per-rule `negativeFilter` patterns (a "key" containing `example|placeholder|test|dummy` does not fire), `contextRequired` proximity checks (`Math.random()` only fires with token/secret/password language within 5 lines), a guard so that pattern-definition lines in analyzer-like code do not flag themselves, and a full skip of fixture and test paths. A single pre-filter regex (`SECURITY_PREFILTER`) skips files containing no security keywords at all, so the 20-rule sweep only runs where it could match.

When multiple rules hit the same `file:line`, their confidences combine by naive-Bayes log-odds rather than max: `odds = Π c_i / (1 - c_i)` with each `c_i` clamped to `[0.01, 0.99]`, and combined confidence `min(0.999, odds / (1 + odds))`. Three corroborating hits at 0.75/0.80/0.95 combine to about 0.996, sharper than any one alone, and the message is annotated with how many patterns corroborate.

Example: `const apiKey = "sk_live_abcdef1234567890abcd"` fires hardcoded-api-key as an error under `security-floor`.

## Clarity analyzers (hygiene)

### `intent-clarity`: Intent Clarity

Five sub-checks that approximate the question "can a newcomer tell what this code is for?" (`src/analyzers/intent-clarity.ts`, v2):

1. **Commented-out code**: 3 or more consecutive comment lines containing code tokens. Severity ramps info, warning above 3 blocks, error above 10; confidence 0.7.
2. **Generic names**: a hardcoded set (`data`, `temp`, `tmp`, `val`, `manager`, `helper`, `utils`, `misc`, and friends) plus a corpus-derived set: identifiers of 8 characters or fewer appearing in at least 30% of files (minimum 3) in projects of 10+ files. The corpus set matters because "generic" is repo-relative; a name carrying no information in this codebase is generic here even if it is not on anyone's list. Warning above 3 generic function names (confidence 0.65); very short names (under 3 chars, with `go`, `fn`, `ok`, `id` exempt) only above 5 (info, 0.5).
3. **Long functions**: over 50 lines flags, any over 100 lines escalates the aggregate finding to error; confidence 0.85.
4. **Low documentation**: files of 100+ lines with under 5% comment density (flagged above 2 such files), and undocumented exported functions (Go capitalized, Python public, Rust `pub fn`) above 10; confidences 0.6 and 0.55.
5. **Verb/AST mismatch**: a function's leading verb makes a promise its body must keep. `get/find/fetch` must return non-void, `validate/check` must throw or return a boolean, `is/has` must return a boolean, `delete/remove` must mutate something. Bodies under 40 characters are skipped (stubs and one-liners tell you nothing). Aggregated, warning above 10, confidence 0.6.

The fixture produces no intent-clarity finding, and the misses are instructive: generic-name matching is exact on the whole lowercased name, so `processData` does not match the set entries `process` or `data`; the corpus-derived set only activates in projects of 10 or more files (the fixture has 4); and the generic-name warning needs more than 3 generic function names before it emits. A project with several functions literally named `process` or `handle` is what trips this check.

### `complexity`: Code Complexity

Sonar-style **cognitive complexity**, not McCabe cyclomatic complexity (`src/analyzers/complexity.ts`, v3). The distinction is the point: McCabe counts branches, cognitive complexity counts what a reader must hold in their head. Each flow break costs +1; nesting constructs cost an additional +nestingLevel; `else`/`elif` walk at the same level as their `if` (they do not deepen); each `&&`/`||`/`and`/`or` adds a flat +1. Per-language AST node sets cover all five languages, with a brace-depth regex fallback for unparsed files. The practical consequence: a 3-condition if-pyramid scores 6 against 3 for its guard-clause-refactored equivalent (the worked pair in the file header), and the gap widens with every extra nesting level, which is exactly the refactor the finding should motivate.

Tiers: CC above 15 is an error (confidence 0.9), above 10 a warning (0.75), above 6 an info (0.5). Per-tier caps (30/30/20 individual findings) roll the tail into one rollup finding at confidence reduced by 0.2, so a huge legacy repo produces a bounded report instead of 400 near-identical findings. A project-level signal fires when the p90 complexity exceeds 10 (warning) or the median exceeds 6 (info), separating "a few hot spots" from "systemically dense."

### `implementation-gap`: Implementation Gap

Detects code that claims to work but does not: the analyzer was motivated by a real shipped stub in the VibeDrift API itself, where an endpoint returned a hardcoded `"unvalidated"` verdict (the header comment in `src/analyzers/implementation-gap.ts`, v1, tells the story). Three signals:

1. **Placeholder string returns**: `return "<literal>"` where the trimmed, lowercased literal is in `PLACEHOLDER_PHRASES` (`unvalidated`, `unimplemented`, `not implemented`, `todo`, `tbd`, `placeholder`, `stub`, `fake`, `dummy`, `mock`, `wip`, `coming soon`, and similar).
2. **Placeholder field assignments** (`verdict="unvalidated"` in kwargs, dicts, or object literals), capped at 3 hits per file.
3. **Explicit not-implemented markers**: `raise NotImplementedError`, `throw new Error("Not implemented...")`, Go `panic("not implemented")`, Rust `unimplemented!()` and `todo!()`.

Markers are errors at confidence 0.95 (the code announces its own gap); placeholder returns and fields are warnings, escalating to error at 3 or more, at confidence 0.75. The analyzer itself scans every file; hits in test and fixture code are instead de-weighted downstream by the scoring engine's file-importance weights (see the scoring chapter).

Example flagged: `return "placeholder";` inside a production request handler.

## Summary table

| Analyzer | Kind | Category | Version | Languages | Key threshold |
|---|---|---|---|---|---|
| `naming` | drift | Architectural Consistency | 2 | all | entropy gate 0.8; minority in 2+ files |
| `imports` | drift | Architectural Consistency | 2 | JS/TS | non-builtin `require` in ESM |
| `error-handling` | hygiene | Architectural Consistency | 1 | JS/TS (Go, Python, Rust error handling is in `language-specific`) | error above 5 empty catches |
| `language-specific` | hygiene | Architectural Consistency | 1 | all (Go/Py/Rust checks) | per-language error handling and idioms; e.g. Rust over 2 `.unwrap()` |
| `duplicates` | hygiene | Redundancy | 3 | all | LCS similarity 0.7 or above |
| `todo-density` | hygiene | Redundancy | 2 | all | Poisson `P < 0.05` per file |
| `dead-code` | hygiene | Redundancy | 7 | all | over 3 dead exports |
| `dependencies` | hygiene | Dependency Health | 3 | all | error above 5 phantoms |
| `config-drift` | hygiene | Dependency Health | 2 | all | per missing env var |
| `security` (+ `security-floor`) | hygiene | Security Consistency | 3 | all | 20 rules; 5 floor, 5 demoted |
| `intent-clarity` | hygiene | Intent Clarity | 2 | all | 50/100-line functions; generic names |
| `complexity` | hygiene | Intent Clarity | 3 | all | CC 6/10/15 tiers |
| `implementation-gap` | hygiene | Intent Clarity | 1 | all | markers at 0.95 confidence |

> [!NOTE]
> The `Languages` column is where each analyzer's checks actually fire, not just where its files parse. `error-handling` is JS/TS because its patterns (empty `catch`, un-awaited async) are JavaScript shapes; the equivalent error-handling checks for Go, Python, and Rust live in `language-specific`. The `imports` analyzer is JS/TS only. The `import-consistency` drift detector, by contrast, now checks import style across JS/TS, Go, Python, and Rust (see the Import style section in the drift chapter).
