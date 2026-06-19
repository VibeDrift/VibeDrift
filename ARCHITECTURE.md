# VibeDrift Architecture

> Engineering system design for the open-source `@vibedrift/cli`. This document explains how the
> pieces fit together: the layered analysis engine, the scan pipeline, the scoring math, the
> channel-portable in-loop tools, and the seam to the hosted service.
>
> It is the map. Two companion docs are the territory:
> [`docs/algorithms.md`](./docs/algorithms.md) is the per-heuristic audit (what each algorithm does,
> why it is correct, where it is wrong), and [`docs/tools-api.md`](./docs/tools-api.md) is the
> reference for the importable tools API. [`AGENTS.md`](./AGENTS.md) and
> [`CONTRIBUTING.md`](./CONTRIBUTING.md) cover conventions and how to contribute. This file does not
> repeat those; it shows how the components connect.

---

## Table of contents

- [1. What VibeDrift is](#1-what-vibedrift-is)
- [2. Design principles](#2-design-principles)
- [3. The two faces and the shared core](#3-the-two-faces-and-the-shared-core)
- [4. The layered analysis model](#4-the-layered-analysis-model)
- [5. Repository map](#5-repository-map)
- [6. Core data types](#6-core-data-types)
- [7. The batch scan pipeline](#7-the-batch-scan-pipeline)
- [8. Layer 1: static analyzers](#8-layer-1-static-analyzers)
- [9. Layer 1: drift detectors and the dominance vote](#9-layer-1-drift-detectors-and-the-dominance-vote)
- [10. Layer 1.7: the Code DNA engine](#10-layer-17-the-code-dna-engine)
- [11. Layer 2: deep scan and the cloud seam](#11-layer-2-deep-scan-and-the-cloud-seam)
- [12. Scoring: the Vibe Drift Score and the Hygiene Score](#12-scoring-the-vibe-drift-score-and-the-hygiene-score)
- [13. Intent hints](#13-intent-hints)
- [14. In-loop tools and channel portability](#14-in-loop-tools-and-channel-portability)
- [15. Output and renderers](#15-output-and-renderers)
- [16. Core plumbing, persistence, and determinism](#16-core-plumbing-persistence-and-determinism)
- [17. Auth and telemetry](#17-auth-and-telemetry)
- [18. The hosted API seam and the open-core boundary](#18-the-hosted-api-seam-and-the-open-core-boundary)
- [19. Build, packaging, and distribution](#19-build-packaging-and-distribution)
- [20. Extending VibeDrift](#20-extending-vibedrift)
- [21. Constants reference](#21-constants-reference)
- [22. Sharp edges worth knowing](#22-sharp-edges-worth-knowing)

---

## 1. What VibeDrift is

VibeDrift detects **drift** in AI-generated codebases: the gap between the patterns a codebase
started with and the patterns new code introduces when an agent writes across many sessions. The
headline output is the **Vibe Drift Score**, a measure of how consistent a codebase is with its own
dominant patterns. It is deliberately not a quality score or a tech-debt score.

The product has two shapes built on one engine:

1. A **batch scanner** (`npx @vibedrift/cli`) that scans a whole repository and produces an
   interactive report plus a 0-100 score with file-level evidence. Drift *detection*.
2. Five **in-loop tools** that an AI coding agent calls while it writes, so new code matches the
   repo's conventions the first time. Drift *prevention*. These reach the agent over four channels
   (an MCP server, a plain import, an Agent Skill, and a git hook), all wrapping the same engine.

It is implemented in TypeScript (ESM, strict), runs entirely on the developer's machine, and talks
to a separate hosted service only for the optional, metered deep scan.

---

## 2. Design principles

These constraints explain most of the structural decisions below.

- **Drift, not quality.** Every detector must be grounded in deviation from the codebase's own
  dominant pattern, established by a peer group. A finding without a baseline it deviates from does
  not belong. Regex-only checks feed a dominance vote rather than emitting findings on their own.
- **Determinism.** The same commit produces the same score on every machine and in CI. File
  discovery sorts by code-unit order (never `localeCompare`), analyzers run concurrently but their
  output is reassembled in declaration order, and number formatting is pinned to `en-US`. There is
  no randomness in the analysis path.
- **Local-first and open-core.** Layers 1 and 1.7 run locally and ship in this repo. Layer 2 is a
  thin request/response client; the embeddings, clustering, and LLM validation run server-side in a
  separate hosted service. Your code never leaves the machine for a local scan.
- **Fail-soft.** Network features degrade rather than error. Tools return a `status` instead of
  throwing; the deep client maps every failure to a `degraded` result and falls back to the local
  answer. A missing git history silently disables the temporal and pivot signals.
- **Channel portability.** The five in-loop tools live in a transport-free core (`src/tools-core`).
  MCP, the npm import, and the Agent Skill are thin adapters over it. A guard test keeps the core
  free of any transport import.
- **Honest telemetry.** A default scan sends one anonymous beacon (no code, no paths, no
  identifiers) and a daily npm update check, both opt-out. The docs never claim "zero network
  calls" for a default run; `--local-only` is the switch that makes that true.

---

## 3. The two faces and the shared core

```
            BATCH SCANNER                              IN-LOOP TOOLS
   npx @vibedrift/cli  (the CLI)             an AI agent, mid-edit, asks 5 questions
            │                                          │
            │                          ┌───────────────┼───────────────┬──────────────┐
            │                       MCP server     plain import     Agent Skill     git hook
            │                      (src/mcp)    (@vibedrift/cli/tools) (skills/)   (hook.ts)
            │                          └───────────────┴───────────────┴──────────────┘
            │                                          │                       (shells back to CLI)
            ▼                                          ▼
   ┌─────────────────────┐                  ┌─────────────────────────┐
   │  scan pipeline       │                  │  src/tools-core          │
   │  (src/cli/scan.ts)   │                  │  5 channel-neutral tools │
   └──────────┬──────────┘                  └────────────┬────────────┘
              │                                           │  (reads a cached baseline)
              │                                           ▼
              │                              ┌─────────────────────────┐
              │                              │ src/core/baseline.ts     │
              │                              │ RepoDriftBaseline cache  │
              │                              └────────────┬────────────┘
              │                                           │
              └─────────────────────┬─────────────────────┘
                                    ▼
              ┌───────────────────────────────────────────────┐
              │           THE ANALYSIS ENGINE                  │
              │  Layer 1   analyzers + drift detectors         │
              │  Layer 1.7 Code DNA (fingerprints, MinHash,    │
              │            op-sequences, taint, deviation)      │
              │  Layer 2   ml-client -> hosted API (optional)   │
              │  scoring   findings -> 5 categories -> 0-100    │
              └───────────────────────────────────────────────┘
```

The batch scanner runs the full engine and writes a report. The in-loop tools run a small slice of
the same engine against a precomputed **baseline** (built once per repo, then cached) so an agent
can check a single function in milliseconds without rescanning. The git hook is the odd one out: it
does not use `tools-core`, it shells back to the CLI with `--fail-on-score`, reusing the exact path
CI uses.

---

## 4. The layered analysis model

| Layer | Where | What it adds | Cost |
|-------|-------|--------------|------|
| **Layer 1: static** | `src/analyzers/` (13 analyzers) | Single-file regex/AST checks: naming, imports, complexity, security, dead code, TODO density, dependencies, and more | local, free |
| **Layer 1: drift** | `src/drift/` (14 detectors) | Cross-file dominance voting: "8 of 10 files do X, the 2 that do Y are drift" | local, free |
| **Layer 1.7: Code DNA** | `src/codedna/` (5 modules) | Semantic fingerprinting, MinHash/LSH near-duplicates, abstract operation sequences, taint flows, deviation justification | local, free |
| **Layer 2: deep scan** | `src/ml-client/` + `src/mcp/deep-client.ts` | UniXcoder embeddings, clustering anomalies, and LLM-validated semantic duplicates / intent mismatches | cloud, metered |

Supporting subsystems: `src/scoring/` turns findings into the 0-100 score, `src/output/` renders
every report format, `src/tools-core/` is the in-loop tools core, `src/mcp/` is the MCP adapter,
`src/intent/` parses declared conventions, `src/auth/` and `src/telemetry/` handle accounts and the
beacon, and `src/core/` is the shared spine (discovery, types, caches, persistence).

Languages supported across all layers: **JavaScript, TypeScript, Python, Go, Rust**. Parsing is via
`web-tree-sitter` (WASM grammars from `tree-sitter-wasms`), with regex fallbacks where an AST is
absent.

---

## 5. Repository map

```
src/
  cli/
    index.ts              Commander program: registers 14 commands + every flag
    commands/
      scan.ts             THE ORCHESTRATOR (runScan): drives the whole pipeline
      watch.ts            continuous local re-scan for AI sessions (forces --local-only)
      hook.ts             git pre-push hook install/uninstall/status (gates on score)
      login/logout/status/usage/billing/upgrade/update/doctor/feedback.ts
  core/                   the shared spine
    types.ts              SourceFile, AnalysisContext, Finding, ScanResult, CategoryScores
    discovery.ts          gitignore-aware walk + manifest loaders + buildAnalysisContext
    run-analyzers.ts      concurrent, order-preserving analyzer execution + cache
    baseline.ts           RepoDriftBaseline: the cached per-repo aggregate for the tools
    history.ts            scan history + scan-over-scan finding digests
    git-metadata.ts       per-HEAD git history aggregation (temporal signal)
    findings-cache.ts     per-analyzer Merkle-keyed cache
    import-graph.ts       JS/TS export/import reachability graph
    file-filter.ts language.ts config.ts scoring-notice.ts update-check.ts version.ts
  analyzers/              Layer 1 static (13 analyzers + base.ts + index.ts)
  drift/                  Layer 1 cross-file (14 detectors + utils.ts vote machinery + types.ts)
  codedna/                Layer 1.7 (fingerprint, minhash, op-sequence, pattern, taint, deviation)
  scoring/
    engine.ts             the decay formula, drag penalty, drift + hygiene tracks
    categories.ts         the 5 categories and the analyzer -> category -> kind map
    dedup.ts              cross-layer duplicate-finding precedence
  ml-client/              Layer 2 client (sampler, confidence, summarize, fix-prompts, log-scan, ...)
  tools-core/             the 5 in-loop tools as transport-free functions ("./tools" export)
    tools/                get-intent-hints, get-dominant-pattern, check-file-drift,
                          find-similar-function, validate-change
    result.ts nudge.ts finalize.ts
  mcp/                    MCP adapter over tools-core
    server.ts             stdio MCP server, registers the 5 tools
    baseline-provider.ts  lazy baseline cache  (imported BY tools-core)
    deep-client.ts        in-loop Layer-2 client (imported BY tools-core)
    envelope.ts nudge.ts  wire serialization + nudge finalize
    tools/                ~30-line adapters per tool
  intent/                 parses CLAUDE.md / AGENTS.md / .cursorrules into IntentHint[]
  output/                 terminal, html, csv, docx, history-diff, fix-prompt, tease, context-md
  auth/                   device-auth flow, token resolution, config storage, API client
  telemetry/              the anonymous scan beacon
  render.ts               "./render" export: renderHtmlReport + scoring functions
  utils/                  ast (tree-sitter wrapper), gitignore, text helpers
bin/vibedrift.mjs         the executable shim (suppresses warnings, imports dist/cli/index.js)
skills/vibedrift/         the Agent Skill channel (SKILL.md + scripts/vibedrift-tools.mjs)
docs/                     algorithms.md (heuristic audit) + tools-api.md (tools reference)
eval/                     manual, metered A/B drift-delta harness (not run by CI)
```

---

## 6. Core data types

Five types in `src/core/types.ts` carry almost everything between subsystems.

- **`SourceFile`** is the unit of analysis: `{ path, relativePath, language, content, lineCount,
  tree?, git? }`. Git metadata is grafted on during discovery; the tree-sitter `tree` is populated
  lazily by `utils/ast`.
- **`AnalysisContext`** is the immutable read-only bundle every analyzer and detector receives:
  the file list, parsed manifests (`package.json`, `go.mod`, `Cargo.toml`, `requirements.txt`,
  `.env.example`), `totalLines`, `languageBreakdown`, `dominantLanguage`, `hasGitMetadata`, and the
  parsed `intentHints`.
- **`Finding`** is the universal output unit from every layer: `{ analyzerId, severity
  (info|warning|error), confidence (0..1), message, locations, tags, consistencyImpact?, metadata?
  }`. The `analyzerId` is the routing key: scoring uses it to find the category and the drift/hygiene
  kind. `metadata` carries drift context (dominant pattern, deviating files, pivot, intent
  divergence) for renderers and fix prompts.
- **`DriftFinding`** (`src/drift/types.ts`) is the rich record a drift detector emits before it is
  adapted into a generic `Finding`: dominant pattern, dominant count, total relevant files, a
  `consistencyScore` (dominant share times 100), the deviating files with code evidence, and
  optional pivot / legacy / intent-divergence enrichment.
- **`ScanResult`** is the full object the pipeline builds and every renderer consumes: findings,
  drift findings, the two score tracks (drift and hygiene), per-file scores, the Code DNA result,
  the scan-over-scan diff, an optional AI summary, and the scoring version.

---

## 7. The batch scan pipeline

`runScan` in `src/cli/commands/scan.ts` is the orchestrator. The ordering is fixed and
load-bearing.

```
  buildAnalysisContext(rootDir)                              [src/core/discovery]
      ├─ discoverFiles        gitignore-aware walk, <=5000 files, skip >1MB, deterministic sort
      ├─ load manifests       package.json / go.mod / Cargo.toml / requirements.txt / .env.example
      ├─ collectGitMetadata   single `git log` pass, per-HEAD cached (temporal signal)
      └─ parseIntentFiles     CLAUDE.md / AGENTS.md / .cursorrules -> IntentHint[]
                │
  applyIncludeExclude  ──►  parseFiles (tree-sitter)
                │
  ┌─────────────┴──────────────────────────────────────────────┐
  │  runAnalyzers (concurrent, order-preserving, cached)         │  Layer 1 static  -> Finding[]
  │  runDriftDetection                                           │  Layer 1 drift   -> Finding[]
  │  runCodeDnaAnalysis        (skipped by --no-codedna)         │  Layer 1.7       -> Finding[]
  │  runMlAnalysis             (only --deep + signed in + net)   │  Layer 2 cloud   -> Finding[]
  └─────────────┬──────────────────────────────────────────────┘
                │
  deduplicateFindingsAcrossLayers   ML > Code DNA fingerprint > Code DNA opseq > static
                │
  computeScores(findings, totalLines, ctx, previousScores)      -> Vibe Drift Score + Hygiene Score
                │
  diffScans(previous, current)        scan-over-scan resolved / new / persistent
  writeBaseline(assembleBaseline(...))   refresh the in-loop tools' cached baseline
  synthesizeFixPrompts (signed in)    AI fix prose attached to findings
  sendScanBeacon (telemetry on)       anonymous beacon
  saveScanResult(...)                 history under ~/.vibedrift/scans
  writeContextFiles (--write-context) .vibedrift/ agent context files
  logScan (signed in)                 sanitized result -> dashboard
                │
  renderToFormat   html (default) | terminal | json | csv | docx
                │
  process.exit(1) if compositeScore < --fail-on-score
```

A few flags change the shape materially:

- `--deep` enables Layer 2; it is silently forced off under `--local-only`.
- `--local-only` skips every network call (beacon, update check, deep scan, scan log, fix prompts).
- `--json` overrides `--format` and suppresses spinners, banners, and notices.
- HTML format does not exit the process: it serves the report on a random local port (4173-4272)
  for ten minutes, so the `--fail-on-score` exit check does not apply to it.
- `--write-context` and `watch` require a signed-in token, to keep the full-detail output behind the
  same gate as a normal scan.

---

## 8. Layer 1: static analyzers

Thirteen analyzers in `src/analyzers/`, each a small object implementing the `Analyzer` interface
(`id`, `name`, `category`, `applicableLanguages`, optional `version`, `analyze(ctx)`).
`createAnalyzerRegistry()` returns them in a fixed order, and `runAnalyzers` reassembles their
findings in that order for deterministic output. Most are regex-driven; `naming` and `complexity`
use the AST when present.

| Analyzer | Scoring category | Kind | Detects |
|----------|------------------|------|---------|
| `naming` | architectural | **drift** | Naming-convention split, entropy-gated |
| `imports` | architectural | **drift** | Mixed ESM and non-builtin CommonJS |
| `error-handling` | architectural | hygiene | Empty catches, unhandled async |
| `language-specific` | architectural | hygiene | Go/Python/Rust idiom violations |
| `duplicates` | redundancy | hygiene | Cross-file near-duplicate functions (MinHash + LCS) |
| `todo-density` | redundancy | hygiene | Poisson-outlier TODO files, stub-adjacent TODOs |
| `dead-code` | redundancy | hygiene | Dead exports, orphan files, unreachable code |
| `dependencies` | dependencyHealth | hygiene | Phantom and missing deps per ecosystem |
| `config-drift` | dependencyHealth | hygiene | Env vars used-but-undocumented vs declared-unused |
| `security` | securityPosture | hygiene | ~24 OWASP-style rules, Bayesian-stacked per line |
| `intent-clarity` | intentClarity | hygiene | Generic names, long functions, low doc density |
| `complexity` | intentClarity | hygiene | Sonar cognitive complexity, p90/median summary |
| `implementation-gap` | intentClarity | hygiene | Placeholder returns, `NotImplementedError`, `panic`, `todo!()` |

The single most counterintuitive fact in this subsystem: an analyzer's **`category`** routes its
findings to a scoring bucket, but a separate **`kind`** (looked up by `analyzerId` in
`CATEGORY_CONFIG`) decides whether it counts toward the headline Vibe Drift Score or the parallel
Hygiene Score. Of the 13 statics, only `naming` and `imports` are `kind: "drift"`. The other 11 are
hygiene. So most of the classic static checks (complexity, security regex, dead code) do not move
the Vibe Drift Score at all; they form the Hygiene Score. This is the drift-not-quality principle
enforced in code.

`version` on each analyzer is the cache-invalidation knob: it is folded into the findings-cache key,
so bumping it after a logic change drops stale cached results.

---

## 9. Layer 1: drift detectors and the dominance vote

This is the heart of the product. Fourteen detectors in `src/drift/` each profile every file down to
one pattern, run a peer-group vote, and flag the files that deviate from the dominant pattern.

### The vote machinery (`src/drift/utils.ts`)

```
profile each file (regex/heuristic) -> one primary pattern per file
        │
buildPatternDistribution -> Map<pattern, {count, files, weight?}>
        │
optional gates and weights:
   entropyGate            skip if the distribution is too uniform to have a winner
   temporalWeight         weight recent files more heavily (git age)
   seedDominanceVote      let a declared convention bias the vote (intent)
        │
findDominantPattern / findWeightedDominantShared
        │
collectDeviatingFiles -> every file whose pattern != dominant
        │
DriftFinding { dominantPattern, dominantCount, totalRelevantFiles, consistencyScore, deviatingFiles }
```

The shared primitives:

- **`buildDirectoryScopedVote`** groups files by directory (sorted for determinism), requires a
  minimum group size of 3, skips unanimous directories, and flags deviators only when the dominant
  share clears 0.7, unless an intent declaration seeds the vote.
- **`entropyGate`** computes normalized Shannon entropy over the pattern counts. Above 0.8 it
  reports "no convention exists" instead of flagging anyone. Below that, deviator confidence is
  `clamp(1 - normalizedEntropy, 0.3, 0.9)`: the tighter the convention, the higher the confidence.
- **`temporalWeight(daysAgo) = 2.0 * exp(-ln2 * daysAgo / 90)`** gives a file a recency multiplier
  with a 90-day half-life (0 days is 2.0x, 90 days is 1.0x, 180 days is 0.5x). Missing git metadata
  returns 1.0, collapsing to flat voting. This lets a recent refactor of three files outvote ten
  legacy files.
- **`seedDominanceVote`** lets a declared convention (an intent hint) bias the vote. Crucially it
  computes the raw, unboosted dominant first, so `declaredMatched` is honest: a declaration that
  flips a close vote still reports a divergence rather than laundering the result into apparent
  agreement.

### The detectors

```
detector                          drift category               weight*
architectural-contradiction       architectural_consistency      16   (data access, errors, config, DI)
security-consistency              security_posture               14   (auth/validation/rate-limit, 3-phase)
semantic-duplication              semantic_duplication           14   (MinHash + LSH + LCS, reuses Code DNA)
convention-oscillation            naming_conventions             12   (symbol + file naming)
phantom-scaffolding               phantom_scaffolding            12   (unimported CRUD exports, uses import graph)
import-consistency                import_style                   12   (relative vs alias)
return-shape-consistency          return_shape_consistency       12   (error-path return shapes)
async-consistency                 async_patterns                 10   (async/await vs .then chains)
export-consistency                export_style                   10   (default vs named)
state-management-consistency      state_management_consistency   10   (React/Vue/Svelte state strategy)
logging-consistency               logging_consistency             8   (console / structured / per-language)
test-structure-consistency        test_structure_consistency      6   (framework + mock style)
comment-style-consistency         comment_style_consistency       5   (jsdoc / line / hash)
commit-archaeology                architectural_consistency       -   (git burst-authorship, folds in)
```

\*These `DRIFT_WEIGHTS` are per-category bar weights for the report radar only. They are not the
composite score. The authoritative composite is the exponential-decay scoring engine (Section 12);
an earlier second engine was collapsed, and `attachEngineComposite` only mirrors the engine's number
onto `driftScores.composite` for the dashboard.

Note that 14 detectors map to 13 categories because `commit-archaeology` folds into
`architectural_consistency`, and that two files in `src/drift/` are not registered detectors:
`async-style.ts` is a shared classifier (also imported by the `validate_change` tool so batch and
in-loop agree on async vocabulary), and `pivot-detector.ts` is a post-pass.

### Two enrichment passes

After all detectors run, `runDriftDetection` applies two passes over the findings:

1. **Pivot detection** (`pivot-detector.ts`): when a directory is mid-migration (the dominant
   pattern among recent files differs from the dominant among legacy files, each above its
   consistency floor), deviating files matching the old pattern are reclassified as `legacy`
   (migration candidates, prompted "migrate when convenient") rather than `drift` (prompted "fix
   now"). This needs git metadata and is a silent no-op without it.
2. **Intent divergence**: when the voted dominant disagrees with a declared convention, the finding
   is stamped with the declaration's source and line so the report can cite the rule directly.

The wiring contract to remember: `driftFindingToFinding` keys the `analyzerId` off the typed
`driftCategory` (`drift-<category>`), not off the free-form `detector` string. Relying on the
`detector` string was a historical bug that silently excluded most detectors from the score.

---

## 10. Layer 1.7: the Code DNA engine

`src/codedna/` is local, network-free semantic analysis. `runCodeDnaAnalysis` extracts functions
once, then runs five modules in a fixed order and aggregates their findings.

```
extractAllFunctions (cross-language regex + brace/indent bounding, reject <10 chars / <5 tokens)
        │
  1. Semantic fingerprint    normalize body (vars -> _vN, strings -> STR, numbers -> NUM),
                             two-pass FNV-1a hash, SHA-256 to kill collisions -> EXACT duplicates
  2. Operation sequence      reduce each function to a sequence of 22 abstract opcodes
                             (INPUT, VALIDATE, QUERY, MUTATE, ...), cross-file LCS >= 0.80
  3. Pattern classifier      Bayesian posterior over 6 data-access patterns per handler/service file
  4. Taint analysis          source -> sanitizer -> sink, intraprocedural + one-hop interprocedural
  5. Deviation heuristics    score whether a deviation is justified (complex SQL, ADR comment,
                             special directory) vs accidental; emits only "likely_accidental"
```

A subtle but important separation: `index.ts` uses the **semantic-fingerprint** path for exact
duplicates. The **MinHash / LSH / LCS** machinery in `minhash.ts` is a shared primitive that
`index.ts` does *not* call directly; it is consumed by other subsystems instead:

```
codedna/minhash.ts  (buildSignature, findLshCandidatePairs, lcsSimilarity)
        ├──► analyzers/duplicates.ts          (Layer 1 static duplicate analyzer)
        ├──► drift/semantic-duplication.ts     (Layer 1 cross-file duplication detector)
        ├──► ml-client/sampler.ts              (selects ambiguous near-dup pairs for the deep scan)
        ├──► core/baseline.ts                  (builds the persisted MinHash index for the tools)
        └──► codedna/find-similar-to-body.ts   (one-vs-N search used by the in-loop tools)
```

The MinHash configuration (128 hash families, k=5 shingles, 16 bands of 8 rows, LCS verify
`2*LCS / (|a| + |b|)`) and the fingerprint normalization rules are documented heuristic-by-heuristic
in [`docs/algorithms.md`](./docs/algorithms.md). Two normalizers exist and are not interchangeable:
`semantic-fingerprint` renames locals to `_vN`, while `minhash.normalizeTokens` renames to `ID{n}`
but preserves call-target chains (`db.query` stays literal) because the API a function calls is
architectural signal.

---

## 11. Layer 2: deep scan and the cloud seam

Layer 2 (`src/ml-client/`) is the only part that sends anything off the machine, and only what it
sends is function snippets, never whole files. It is opt-in (`--deep`), requires sign-in, and is
fail-soft.

```
runMlAnalysis(ctx, codeDnaResult, findings, {token, apiUrl, driftFindings})
        │
  sampler.ts          pick <=30 functions, truncate each to 60 lines, force-include both members of
                      every ambiguous near-duplicate pair (LCS in [0.55, 0.80])
  build deviations    map Code DNA + drift evidence to <=20 trained deviation payloads
  project identity    project_hash = SHA-256(absolute rootDir); the server never sees a path
        │
  callMlApi  POST /v1/analyze   (Bearer auth, 90s timeout)
        │
   < the hosted service runs UniXcoder embeddings, DBSCAN anomaly clustering, and a server-side
     Claude validation pass over borderline findings; rejected findings are removed before reply >
        │
  filterByConfidence  >= 0.85 ship as a high-confidence Finding; 0.50-0.85 is medium (not shipped
                      in the current flow since the server already validated); below 0.50 dropped
```

The CLI sends `llm_validations: []` and lets the server self-select and validate borderline cases,
so the LLM never runs in this repo. High-confidence ML findings (`ml-duplicate`, `ml-intent`,
`ml-anomaly`) merge into the finding set and then go through cross-layer dedup.

`ml-client` also owns the dashboard side-channels, all Bearer-authed and silent on failure:
`/v1/summarize` (a Claude executive summary), `/v1/fix-prompts` (peer-grounded fix prose attached to
findings), and `/v1/scans/log` (the sanitized scan result that is the dashboard's single source of
truth, with progressive payload compaction to stay under a 9MB target / 24MB hard limit).

Privacy is enforced by `sanitize-result.ts` before any upload: it strips `rootDir`, rewrites
absolute paths to relative, drops raw file contents and AST nodes, and summarizes per-file scores
into histograms.

The same `callMlApi` primitive backs the in-loop deep checks via `src/mcp/deep-client.ts`, tagged
`source: "mcp"` so the API bills it at a fraction of a full deep scan and validates with a cheaper
model.

---

## 12. Scoring: the Vibe Drift Score and the Hygiene Score

`src/scoring/engine.ts` runs **two parallel tracks** over the same findings, split by each finding's
`kind`:

- The **Vibe Drift Score** (the headline) sums only `kind: "drift"` findings.
- The **Hygiene Score** sums only `kind: "hygiene"` findings (generic lint-style issues).

This split is the scoring expression of the drift-not-quality principle. The two never mix.

### The per-category formula

There are five categories (`architecturalConsistency`, `redundancy`, `dependencyHealth`,
`securityPosture`, `intentClarity`), each worth 20 points. For each category:

```
score = maxScore * e^(-K_DECAY * adjustedWeight)          K_DECAY = ln(2) / 15

per-finding weight = severityWeight        (error 3.0, warning 1.5, info 0.5)
                   * confidence            (default 1.0)
                   * fileImportance         (1.5 for entry points, else 1.0; max over locations)
                   * correlationAmplifier   (1.5 if >=4 distinct analyzers touch the file, 1.3 if >=3)

per-analyzer cap   = maxScore * 0.6        (one noisy analyzer cannot annihilate a category)
sizeFactor         = sqrt(totalLines / 1000), clamped to [0.5, 4.5]  (1.0 below 500 lines)
adjustedWeight     = cappedRawWeight / sizeFactor
```

So fifteen weighted points of findings halves a category's score. The size factor gives larger
codebases proportionally more tolerance.

### The drag penalty

On the drift track only, if `architecturalConsistency` or `redundancy` drops below 50% health, a
penalty is subtracted from the composite (up to 10% of the max per dragging category). A codebase
cannot hide 38% architectural consistency behind a perfect security score.

### Normalization to 100

The drift composite sums the *applicable* categories. `dependencyHealth` has only hygiene-kind
analyzers, so it is non-applicable on the drift track and drops out: the drift composite typically
sums four categories of 20 (a max of 80), which is then normalized to a clean `/100`. The Hygiene
Score uses all five categories for a max of 100.

### Cross-layer dedup and impact attribution

Before scoring, `deduplicateFindingsAcrossLayers` collapses duplicate-detection findings that
multiple layers reported for the same files, keeping the highest-priority one
(`ml-duplicate` > `codedna-fingerprint` > `codedna-opseq` > static `duplicates`) and annotating the
winner with "confirmed by ..." labels.

The engine also writes a `consistencyImpact` onto each drift finding (a first-order estimate of how
many points removing it would recover). Because the decay is sub-additive, summing impacts
overestimates real recovery, so renderers call `estimateScoreAfterFixes` for a true recompute when
they show a projected "score after fixes".

### Version stability

`SCORING_VERSION` (currently `"v3"`) tags the math. When stored previous scores were computed under a
different version, deltas are suppressed silently and a one-time "scoring refined" notice is shown
once. This keeps trend lines comparable across releases without per-scan version banners.

---

## 13. Intent hints

`src/intent/parser.ts` reads team-declared conventions and turns them into a force that biases the
dominance vote, so a stated rule outweighs a close raw vote and a violation becomes a
high-confidence finding.

```
INTENT_FILES (priority order):  CLAUDE.md, AGENTS.md, AGENT.md, .cursorrules, .claude/instructions.md
        │
  per line: match against a per-category keyword table (10 drift categories)
  confidence = 0.5 base + 0.2 if under a "conventions/patterns/..." heading
                        + 0.2 if imperative ("use", "always", "prefer", "require"); capped 0.95
  negation suppression ("do NOT use default exports" does not seed default exports)
  dedupe (highest confidence wins; ties broken by file priority)
        │
  IntentHint { category, pattern, label, source, line, confidence }
        │
        ├──► core/discovery attaches to AnalysisContext.intentHints -> the dominance vote
        └──► tools-core/get-intent-hints surfaces them directly to an agent
```

The vote consumes hints with confidence at or above 0.6 (`pickIntentHint`). A present declared
pattern gets a 1.5x weight boost; an absent one is injected as a virtual entry worth about two file
votes, enough to flip a close vote but not to override a broad consensus.

One hard contract: a hint's `pattern` string must match the detector's emitted pattern string
exactly. A mismatch produces a hint that parses but never binds. There is no literal
`intent_divergence` finding type; intent divergence is realized as an ordinary `DriftFinding` whose
declared pattern is not the code's raw dominant.

---

## 14. In-loop tools and channel portability

The five tools an agent calls while writing live in `src/tools-core/`, deliberately free of any
transport import. They take a plain args object and return plain data with a `status`, never
throwing to signal missing data.

| Tool | Args | Returns |
|------|------|---------|
| `getIntentHints` | `{ rootDir }` | declared conventions from the intent files |
| `getDominantPattern` | `{ rootDir, dimension }` | the repo's majority pattern for a dimension + examples |
| `checkFileDrift` | `{ rootDir, filePath }` | whether a file fits the repo's patterns, with deviations |
| `findSimilarFunction` | `{ rootDir, body, deep? }` | existing functions that already do the same thing |
| `validateChange` | `{ rootDir, targetPath, body, deep? }` | whether a proposed function would drift or duplicate |

Every result carries `status`: `ok`, `partial` (local plus deep both contributed), `stale` (baseline
served but the file changed), `no_baseline` (repo never scanned), or `degraded` (an opt-in deep check
could not reach the cloud, local result intact). The optional `deep: true` on `findSimilarFunction`
and `validateChange` runs the metered Layer-2 check on the single function and degrades gracefully
offline.

### The lazy baseline

Four of the five tools read a precomputed **`RepoDriftBaseline`** rather than rescanning. The
provider builds it lazily on first use and caches it:

```
getBaseline(rootDir):
   in-process memCache  ->  disk (~/.vibedrift/baseline-cache)  ->  build once and persist
   build = discovery + runDriftDetection + extractAllFunctions/buildSignature (per-category votes
           + intent hints + a 128-wide MinHash index)
   freshness: re-hash the files the baseline saw; status ok (fresh) vs stale
```

A real architectural quirk lives here: `baseline-provider.ts` and `deep-client.ts` physically sit
under `src/mcp/`, but they are imported *by* `src/tools-core`. The dependency arrow points from
`tools-core` back to `mcp` for these two files, so `src/mcp/` is not redundant with `tools-core`.
The genuinely thin parts of `src/mcp/` are the five `tools/*.ts` adapters (about 30 lines each), the
wire `envelope.ts`, and the nudge finalizer.

### The four channels

```
                    src/tools-core  (5 functions, transport-free)
                            ▲
        ┌───────────────────┼───────────────────┬────────────────────┐
   MCP server          plain import         Agent Skill           git hook
   src/mcp/*       @vibedrift/cli/tools   skills/vibedrift/    cli/commands/hook.ts
   (stdio JSON-RPC)  (package "./tools")  (vibedrift-tools.mjs) (shells the CLI,
   registers 5 tools,  direct function     reads body on stdin,  NOT tools-core,
   serializes to       calls, same         dispatches to one     runs full scan +
   the MCP envelope    verdicts            tools-core fn         --fail-on-score)
```

- **MCP** is launched with `npx -y @vibedrift/cli mcp` (stdio transport; the MCP SDK is dynamically
  imported so it never loads during a normal scan). Each tool wrapper calls the `tools-core` `run()`
  and serializes the plain data into the MCP wire envelope.
- **Import** is the package `"./tools"` export: `import { validateChange } from "@vibedrift/cli/tools"`.
  Same engine, same verdicts.
- **Agent Skill** ships in the tarball under `skills/`; its runner shells over the import.
- **Git hook** is the exception: it does not touch `tools-core`. `vibedrift hook install` writes a
  pre-push script that runs `vibedrift --local-only --format terminal --fail-on-score <threshold>`
  (default 70), reusing the tested CLI scan path. If `vibedrift` is not on PATH the hook exits 0
  rather than blocking a push.

### The deep-scan nudge

Write-time tools can carry an optional `nudge` (an offer to run a deep scan) attached by
`finalizeResult`. It is gated to be rare: the agent must be signed in, have made at least eight tool
calls this session, be past a one-day cooldown, and either have never deep-scanned or have a deep
scan older than three days. It is a push surface, not a paywall, and the billing for an actual deep
scan is owned by the API.

---

## 15. Output and renderers

`src/output/` is a pure presentation layer over a finished `ScanResult`. `src/render.ts` is the
package `"./render"` export and re-exposes `renderHtmlReport` plus the scoring functions.

| Renderer | Output |
|----------|--------|
| `terminal.ts` | Colorized terminal report (full and brief modes), JSON dump |
| `html.ts` | Interactive HTML report, two modes: `summary` (glanceable hero, fix-plan widget, vote buttons) and `detailed` (AI summary, SVG radar fingerprint, intent coherence matrix, drift evidence, Code DNA, security matrix, file ranking, ML insights) |
| `csv.ts` / `docx.ts` | Multi-section CSV; hand-rolled OOXML `.docx` (no external zip dependency) |
| `history-diff.ts` | Scan-over-scan diff: resolved / new / persistent finding buckets plus score deltas |
| `fix-prompt.ts` | Markdown AI-paste prompts per finding and a bundled full plan |
| `context-md.ts` | The committable `.vibedrift/` files (`context.md`, `fix-plan.md`, `fix-prompts.md`, `patterns.json`) written by `--write-context` for agents to read |
| `tease.ts` | Deep-scan upsell strings naming specific files a deep scan would resolve |

Two things to know. First, the terminal and HTML reports both render the Vibe Drift Score and the
Hygiene Score as separate panes, and the Fix Plan projects a score-after-fixes via
`estimateScoreAfterFixes`. Second, the generated HTML report makes two browser-side network calls: a
report-open beacon (only when the scan carried a `scanId`) and a vote pixel on the thumbs up/down
buttons. This is why the docs never claim a default report sends nothing externally.

---

## 16. Core plumbing, persistence, and determinism

`src/core/` is the spine. Discovery is gitignore-aware (honoring `.gitignore` and
`.vibedriftignore`), skips heavy directories and any dotfile directory, caps at 5000 files and 1MB
per file, and sorts deterministically. Manifests and git metadata load in parallel inside
`buildAnalysisContext`.

All persistence lives under `~/.vibedrift/`, never inside the project tree, with per-project
subdirectories named `sha256(rootDir)[:16]` so a directory listing leaks no paths:

```
~/.vibedrift/
  config.json              auth token + plan + telemetry flags (mode 0600)
  scans/<hash>/            scan history (retention 10) + finding digests for diffs
  baseline-cache/<hash>    the in-loop tools' RepoDriftBaseline
  git-metadata-cache/<hash> per-HEAD git history aggregation
  findings-cache/<hash>/   per-analyzer Merkle-keyed cache (30-day TTL, 500MB cap)
  version-check.json       24h npm update-check cache
```

Three independent version knobs invalidate their caches when logic changes: `analyzer.version`
(per-analyzer findings cache), `BASELINE_VERSION` (the baseline merkle key), and
`HISTORY_SCHEMA_VERSION` (the saved-scan shape). `SCORING_VERSION` separately gates cross-version
score deltas.

Determinism is a hard guarantee, enforced in several places: code-unit sorting in discovery (not
locale-dependent), order-preserving concurrent analyzer execution, finding digests with a +/-3 line
slop window so small edits keep their identity, and `en-US`-pinned number formatting so report bytes
do not vary by host locale.

---

## 17. Auth and telemetry

`src/auth/` implements an RFC-8628-style device authorization flow: `vibedrift login` starts the
flow, opens the verification URL in a browser, and polls the token endpoint (with backoff on 429)
until the user approves. The token is stored at `~/.vibedrift/config.json` (mode 0600) and resolved
by precedence: an explicit flag, then `VIBEDRIFT_TOKEN`, then the config file. The API base resolves
the same way, defaulting to `https://vibedrift-api.fly.dev`.

`src/telemetry/beacon.ts` sends one anonymous beacon after each scan. The payload is exactly
`{ language, file_count, loc, scan_time_ms, cli_version, is_deep, has_git, has_intent_hints,
finding_count, score, authed }`: no code, no paths, no identifiers, no token. The `authed` field is
a derived boolean.

There are three independent opt-out mechanisms with different scopes:

- `--local-only` gates all network at the call site, before telemetry is even consulted.
- `VIBEDRIFT_TELEMETRY_DISABLED` (any non-empty value) disables the beacon and the update check.
- `vibedrift telemetry disable` persists `telemetryEnabled: false` in the config.

Telemetry is on by default for everyone, signed in or not, and the README and `SECURITY.md` disclose
this plainly.

---

## 18. The hosted API seam and the open-core boundary

This repository is the **open client**. The hosted service that the deep scan talks to is a separate
product and is not in this repo. The boundary is verifiable: there is no embedding generation, no
clustering, and no model inference code in `src/`.

```
THIS REPO (MIT, runs on your machine)          HOSTED SERVICE (separate, vibedrift-api.fly.dev)
  Layer 1 analyzers + drift                 │   UniXcoder 768-dim embeddings
  Layer 1.7 Code DNA                        │   DBSCAN anomaly clustering (eps 0.30)
  scoring, output, tools-core               │   server-side Claude validation
  ml-client / deep-client (request only)  ──┼──► billing, accounts, scan storage
  auth client, telemetry beacon             │
```

The endpoints the client calls:

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/analyze` | Deep-scan findings (embeddings + LLM validation), used by `--deep` and in-loop `deep: true` |
| `POST /v1/summarize` | Claude executive summary for the report |
| `POST /v1/fix-prompts` | Peer-grounded AI fix prose |
| `POST /v1/scans/log` | Sanitized scan result for the dashboard |
| `POST /v1/beacon/scan`, `POST /v1/beacon/report-open` | Anonymous telemetry |
| `POST /v1/vote` | Finding thumbs up/down from the HTML report |
| `/auth/*`, `/account/*` | Device auth, validation, usage, credits, Stripe portal |

The embedding and clustering constants (UniXcoder, DBSCAN `eps=0.30`, cosine duplicate threshold
0.85, intent-mismatch threshold 0.30) are documented in `docs/algorithms.md` for completeness but
are computed server-side; the code lives in the separate API repository. `@anthropic-ai/sdk` is a
dev-only dependency used by the eval harness and is marked external in the build, so it is never
bundled into the shipped CLI.

---

## 19. Build, packaging, and distribution

`tsup` bundles four entry points to ESM under `dist/`:

```
src/cli/index.ts          -> dist/cli/index.js       (the CLI, package ".")
src/render.ts             -> dist/render.js          (package "./render")
src/tools-core/index.ts   -> dist/tools-core/index.js (package "./tools")
src/mcp/server.ts         -> dist/mcp/server.js       (reached via the `mcp` subcommand, not exported)
```

The npm tarball ships only `dist/`, `bin/`, and `skills/` (source, tests, eval, and docs are
excluded). `prepublishOnly` runs lint, typecheck, test, and build. CI builds and tests on Node 20
and 22 and runs a gitleaks secret-scan over full history. Node 20+ is required at runtime.

The `eval/` harness is a manual, metered A/B experiment (control vs treatment arms through a real
Claude agent, measuring drift introduced) and is intentionally not part of CI or `npm test`.

---

## 20. Extending VibeDrift

| To add | Do this |
|--------|---------|
| A **static analyzer** | Create `src/analyzers/<name>.ts` implementing `Analyzer`; register it in `index.ts`; map its `id` and `kind` in `CATEGORY_CONFIG` (`scoring/categories.ts`). Unregistered ids default to `hygiene` and never touch the Vibe Drift Score. |
| A **drift detector** | Create `src/drift/<name>.ts`; add its `DriftCategory` to `types.ts` and `DRIFT_WEIGHTS`; register it in `createDriftDetectors()`. It must be grounded in a dominance or similarity signal, never a raw heuristic. |
| A **voting axis** on an existing detector | Build a profiles array and call `buildDirectoryScopedVote` (directory-scoped) or `buildPatternDistribution` + `seedDominanceVote` (project-wide). |
| An **in-loop tool** | Create `src/tools-core/tools/<name>.ts` (a `run` plus a zod `inputSchema`); re-export it from `tools-core/index.ts`; add a thin `src/mcp/tools/<name>.ts` adapter and register it in `server.ts`. The same function then serves every channel. |
| A **delivery channel** | Import `@vibedrift/cli/tools`, call the functions, and call `finalizeResult` on write-time tools. No transport is bundled into the core. |
| A **language** | Extend `SupportedLanguage`, add extensions to `EXTENSION_MAP` (`language.ts`), add the grammar to `utils/ast.ts`, and add per-language patterns to the analyzers / Code DNA modules that need them. |
| A **scoring tweak** | Edit the module constants in `engine.ts`, then bump `SCORING_VERSION` so cross-version deltas are refused and the one-time notice fires. |
| A **public entry point** | Add it to the `tsup` entry array and the `package.json` exports, inside the files allowlist. |
| A **scoring heuristic** | Add a section to `docs/algorithms.md` (What / Why / Limitations / Tests). |

---

## 21. Constants reference

The numbers that govern behavior, with their source files. `docs/algorithms.md` is the canonical
audit for the similarity and vote constants.

**Scoring** (`src/scoring/engine.ts`)

| Constant | Value |
|----------|-------|
| `SCORING_VERSION` | `"v3"` |
| `K_DECAY` | `ln(2) / 15` (15 weighted points halves a category) |
| Severity weights | error 3.0, warning 1.5, info 0.5 |
| File importance | 1.5x for entry points (`index`, `main`, `app`, `server`, `main.go`, `lib.rs`, ...) |
| Correlation amplifier | 1.5x if >=4 distinct analyzers touch a file, 1.3x if >=3 |
| Per-analyzer cap | `maxScore * 0.6` |
| Size factor | `sqrt(totalLines / 1000)`, clamped `[0.5, 4.5]`, 1.0 below 500 lines |
| Drag penalty | up to 10% of max per category, on `architecturalConsistency` and `redundancy` below 50% |
| Per-file decay | `ln(2) / 5`, starting from 100 |
| Dedup precedence | `ml-duplicate` > `codedna-fingerprint` > `codedna-opseq` > `duplicates` |

**Drift vote** (`src/drift/utils.ts`, `pivot-detector.ts`)

| Constant | Value |
|----------|-------|
| Min peer-group size | 3 |
| Dominance threshold | 0.7 |
| Entropy "no convention" gate | normalized H > 0.8 |
| Temporal weight | `2.0 * exp(-ln2 * daysAgo / 90)`, 90-day half-life |
| Intent boost / injected weight | 1.5x existing / `1 + confidence` for absent |
| Pivot windows | recent <= 90 days, recent consistency >= 70, legacy >= 60 |

**Code DNA** (`src/codedna/`)

| Constant | Value |
|----------|-------|
| MinHash families / signature length | 128 |
| Shingle size | 5 tokens |
| LSH bands x rows | 16 x 8 |
| Operation-sequence similarity threshold | 0.80 (over 22 opcodes) |
| Semantic-duplication flag (drift) | LCS >= 0.7, min 15 body tokens |
| Find-similar threshold (tools) | 0.6 discovery, 0.8 for `validate_change` |
| Sampler near-dup band (deep scan) | LCS in `[0.55, 0.80]`, recall LSH 32 x 4 |

**Deep scan** (`src/ml-client/`)

| Constant | Value |
|----------|-------|
| Functions sent / lines each | <= 30 / 60 |
| Confidence bands | ship >= 0.85, medium >= 0.50, else drop |
| Server-side embeddings | UniXcoder 768-dim |
| Server-side anomaly clustering | DBSCAN, cosine, eps 0.30, min_samples 2 |

**Discovery, history, channels**

| Constant | Value |
|----------|-------|
| Max files / max file size | 5000 / 1MB |
| Finding-digest line bucket | `floor(line / 3)` (+/-3 line slop) |
| History retention | 10 scans |
| Hook default threshold | 70 |
| Grade bands | A >= 90, B >= 75, C >= 50, D >= 25, F < 25 |
| Default API | `https://vibedrift-api.fly.dev` |

---

## 22. Sharp edges worth knowing

These are the facts that surprise people reading the code for the first time.

- **Only `naming` and `imports` are drift among the static analyzers.** The other eleven feed the
  Hygiene Score, not the Vibe Drift Score. Most static checks do not move the headline number.
- **A finding routes by `analyzerId`, not by class.** Scoring keys the category and kind off the
  string id. For drift detectors that id is `drift-<driftCategory>`, derived from the typed category,
  not the free-form `detector` field. An unregistered id silently defaults to hygiene.
- **`computeScores` mutates findings.** It writes `consistencyImpact` in place on the drift track.
  The hygiene track and `estimateScoreAfterFixes` run with mutation off.
- **`dependencyHealth` has no drift signal**, so it drops out of the drift composite. That is why the
  drift max is 80 before normalization to 100.
- **The MinHash engine is not called by the Code DNA orchestrator.** `codedna/index.ts` uses the
  FNV-1a + SHA-256 fingerprint path for exact duplicates; the MinHash near-duplicate path is a shared
  primitive consumed by five other subsystems.
- **`src/mcp/` is not redundant with `tools-core`.** `baseline-provider.ts` and `deep-client.ts` live
  under `mcp/` but are imported by `tools-core`; only the per-tool wrappers and envelope are thin.
- **The git hook does not use `tools-core`.** It shells out to the CLI, so it depends on `vibedrift`
  being on PATH and gates on the aggregate score, not the per-function tools.
- **A default scan and a generated report do make network calls** (the beacon, the daily update
  check, the report-open beacon, the vote pixel). Honest disclosure is the posture; `--local-only`
  is the way to a fully offline run.
- **Counts in prose drift.** Some inline comments and a couple of doc lines say "12 analyzers / 8
  detectors" or "26 security patterns"; the registries (`src/analyzers/index.ts`,
  `src/drift/index.ts`) and the tables in this document are ground truth: 13 analyzers, 14 detectors
  across 13 categories, 24 security rules.
