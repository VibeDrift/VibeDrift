# AI Contributor Guide

How to work in this repository with an AI coding agent so that what it produces is trustworthy. Written against `main` at v0.19.2.

If you are contributing by hand, read `CONTRIBUTING.md` and `AGENTS.md` instead; those cover setup, layout, and style. This guide is for the case where an agent is doing the reading, measuring, and writing, which fails in specific ways that are worth naming.

---

## 1. What this file is and how to load it

This file tells an AI agent *how to work* in this repository so that what it produces is trustworthy. It does not restate what the repo already documents. Two files own that ground and you should read both before you touch anything:

| File | What it owns |
| --- | --- |
| `AGENTS.md` | Core identity (drift, not quality), stack, architecture table, layer map, code style, commit format, what does not belong here |
| `CONTRIBUTING.md` | Setup, project layout, where community contributions land, the pre-PR gate, how changes land |

Everything below assumes you have read those. If this file and one of them disagree on a rule, they win on rules and this file wins on *method*.

**How to load it.** This file lives in the repo, so a clone already has it, but most agents will not read it on their own. Point your agent at it in whatever it treats as always-on project instructions:

- **Claude Code**: in your own `CLAUDE.md`, add a line telling the agent to read `docs/AI_CONTRIBUTOR_GUIDE.md` before any work in this repo. `AGENTS.md` is picked up automatically; this file is not.
- **Cursor**: a rule in `.cursor/rules/` with `alwaysApply: true` that references this path.
- **Codex and others**: whatever your tool treats as always-on project instructions. If it only supports a one-shot paste, paste this file at the top of the session and again after any context compaction.

Keep your own agent configuration out of your pull requests. `CLAUDE.md`, `.cursor/`, and similar files are contributor-side tooling and do not belong in the diff.

---

## 2. The prime directive: four bars, and the one everybody skips

Bug reports filed against this repo, including ones written by AI agents, fail in a consistent way. The **mechanism is usually right**: the filer correctly identifies a regex, a threshold, a missing guard. The **magnitude and blast radius are usually wrong**, and wrong in both directions. Cosmetic edge cases get called critical. Systemic blind spots get called nits. Nobody measured.

So a claim about this codebase is not finished until it clears four bars, in order.

**Bar 1: the mechanism exists in isolation.** You can point at the code and explain why it behaves the way you say. This is the easy bar and it is where most reports stop being wrong.

**Bar 2: the path is reachable in practice.** The code you found is actually executed on the path you claim. In this repo that is a real question, because a lot of code is gated: an analyzer's output can be cached, a detector can be registered but scored as hygiene, an inline session check silently no-ops above a baseline size. Reaching bar 1 without bar 2 is how you file a bug about code that never runs.

**Bar 3: there is a user-visible outcome.** Name what a user sees differently. A wrong finding. A missing finding. A score that moves. A crash. If you cannot name the observable, you have found a code smell, not a bug, and it belongs in a PR description rather than an issue.

**Bar 4: the magnitude is measured on a population.** Not on one fixture. Not on the file that made you notice. On a set of inputs large enough that the number means something: every file in a directory, every function in a real repo, every case in a generated matrix, every analyzer in the registry.

Bar 4 is the one that gets skipped, and the reason is structural rather than lazy. Bars 1 through 3 are satisfied by *reading*, which is what an agent is fastest at and most confident about. Bar 4 requires *running something*, usually something you have to write first, and the reading already produced a claim that feels finished. The prose comes out identical either way, which is exactly the problem: "this affects most TypeScript files" and "this affects 41 of 47 TypeScript files in `src/drift`, listed below" read the same to the writer and completely differently to a maintainer.

The concrete rule: **any sentence containing a quantifier is a measurement you owe.** "Most", "many", "widely", "rarely", "significant", "minor", "systemic", "edge case". Either produce the number or delete the sentence. A missing magnitude claim is far better than a guessed one.

A cheap way to hit bar 4 in this repo: write a throwaway `tsx` script in a scratch directory outside the repo tree that imports the real function and runs it over a real corpus. Everything is a plain exported function, and the CLI runs from source, so this takes minutes:

```bash
# from the repo root, against any real project on disk
npx tsx src/cli/index.ts /path/to/some/real/repo --local-only --format json > /tmp/before.json
```

Calibrate your intuition before you reason about score deltas. A tiny, obviously clean TypeScript project does **not** score 100: `NO_FINDING_PRIOR` and the LOC evidence scale hold small projects well below full marks, and the exact number moves with the fixture. Run it yourself and write the number down.

---

## 3. The subagent protocol: investigator, refuter, editor

Use three passes with different jobs. They can be three subagents or three separated turns, but the refuter must not be the investigator wearing a different hat, because the investigator is attached to its own conclusions.

**Pass 1, the investigator.** Establishes the mechanism, reachability, and user-visible outcome (bars 1 through 3), and takes an honest first shot at bar 4. Produces a draft with file:line evidence for every claim.

**Pass 2, the refuter.** Does not review the draft. **Executes** it. Every measured number gets recomputed independently. Every unmeasured quantifier gets measured or struck. The refuter's success condition is finding a wrong number, not agreeing.

**Pass 3, the editor.** Applies the refuter's corrections, deletes anything that could not be verified, and cuts the report to what survived. The editor does not add new claims.

### What the refuter actually buys you

In practice the adversarial pass rarely overturns a verdict and almost always corrects the numbers, and the corrections come from measurements the first pass asserted but never ran.

Read that carefully, because it says two things. The investigator's *judgment* tends to be reliable: it is usually right about what is broken. The investigator's *numbers* tend not to be. The refuter is not a safety net against bad reasoning. It is a safety net against confident arithmetic that was never performed. If you skip it because the first pass "looks solid", you are skipping it in exactly the case where it pays off.

### The refuter prompt, verbatim

Give this to the second agent along with the draft. Do not soften it.

```
You are the refuter. A previous agent produced the report below about the
VibeDrift CLI at <ABSOLUTE_REPO_PATH>. Your job is not to review it. Your job
is to EXECUTE it and try to prove it wrong.

Rules:
1. Do not modify any file in the repo. Read and run only. Write scratch
   scripts outside the repo tree.
2. Check your shell first with `type grep`. Some setups alias `grep` to a
   gitignore-aware ripgrep wrapper that silently skips files. If yours does,
   use `command grep` for every recursive search, or your negative results
   are meaningless.
3. For EVERY quantitative claim in the report ("most", "many", "N files",
   "rarely", "systemic", "minor", "significant", percentages, counts):
   recompute it yourself with a command or a script, from scratch. Do not
   check the first agent's arithmetic. Redo the measurement. Paste the exact
   command and its raw output.
4. For EVERY claim of the form "X does not happen" or "X is never reached":
   construct an input that would make it happen and run it. A claim that was
   only reasoned about is not verified.
5. For EVERY claimed behavior, build a minimal reproduction and run it.
   Prefer importing the real exported function over reading it. Prefer
   running the real CLI (`npx tsx src/cli/index.ts <path> --local-only
   --format json`) over describing what it would output.
6. Measure on a POPULATION, not a single fixture. One passing example proves
   nothing about magnitude. If the report says a behavior is common or rare,
   enumerate the population and count.
7. Specifically attack the blast radius in BOTH directions. Ask: is this
   narrower than claimed (gated, cached, dead, hygiene-tracked, language-
   specific, behind a size threshold)? And: is this WIDER than claimed
   (other call sites, other languages, other detectors sharing the helper)?
   Enumerate every caller with a recursive search over src/.
8. Anything you cannot verify by execution, mark UNVERIFIED explicitly.
   Do not repair it with reasoning.

Output exactly three sections:

  VERDICT: one of CONFIRMED / CONFIRMED-WITH-CORRECTIONS / OVERTURNED,
  and one sentence saying why.

  CORRECTIONS: a numbered list. For each, quote the original claim, give
  the corrected claim, and paste the command plus raw output that
  establishes it. If the correction is "this number was never measured and
  I measured it", say so.

  UNVERIFIED: everything you could not establish by execution, and what
  would be needed to establish it.

Expect to find corrections. A refuter pass that returns CONFIRMED with no
corrections and no pasted command output has not done the work.
```

---

## 4. Working in this codebase

`AGENTS.md:38-44` lists the command set and `CONTRIBUTING.md:96-103` states the four-command pre-PR gate. Here is what they actually cost and what they actually cover, all verified on this tree.

### Where contributions land

Read this before you pick a target, because it determines whether your PR is acceptable at all (`CONTRIBUTING.md`, "Where to contribute"). Community contributions land in the local layers: analyzers, drift detectors, the Code DNA engine, the MCP tools, scoring, output renderers, and docs. The Layer 2 client (`src/ml-client/`, `src/mcp/deep-client.ts`) talks to a hosted service you cannot run locally, so PRs touching it should be limited to client-side request and response shape and serialization, and are validated by maintainers against the live service. The `eval/` harness needs your own `ANTHROPIC_API_KEY`, is manual and metered, and is not run by `npm test`.

### The loop

Prerequisite: Node.js >= 20 (`CONTRIBUTING.md:33`; CI covers 20.x and 22.x only).

```bash
npm ci
npm run build     # REQUIRED before npm test on a fresh clone, see below
npm test
npm run lint
npm run typecheck
```

**`npm run build` before `npm test` is not optional on a fresh clone.** `test/integration/mcp.test.ts:12` does `const CLI = resolve("dist/cli/index.js")` and spawns it with node. Nothing guards that path: a recursive search for `dist/cli` across `test/` returns only that one line, with no `existsSync` check and no skip fallback around it. `dist/` is gitignored, so a fresh clone has nothing there. CI orders build before test, and so does `prepublishOnly` (commit `dab99f6`, "ci: build before test in publish gate (tests exec dist)").

### Running one test

```bash
npx vitest run test/unit/scoring/engine.test.ts   # 1 file, 19 tests
npx vitest run engine                             # substring filter, same result
```

A wrong path is a hard failure, not a no-op. Verified: `npx vitest run test/unit/scoring/composite.test.ts` (a file that does not exist) prints "No test files found" and **exits 1**. The substring filter is more forgiving. Check the file exists before you conclude your tests passed.

### Running the CLI from source

No build needed. This is the fastest way to get a real measurement:

```bash
npx tsx src/cli/index.ts /path/to/a/project --local-only --format json
```

Verified working end to end. `--local-only` keeps it offline. `--no-cache` (`src/cli/index.ts:88`) or `VIBEDRIFT_DISABLE_CACHE=1` (`src/core/findings-cache.ts:156`) bypasses the findings cache, which you want whenever you are testing a change to an analyzer.

### What the gates actually cover

| Gate | Covers | Does NOT cover |
| --- | --- | --- |
| `npm test` (vitest) | `test/**/*.test.ts` only, 189 files | `test/calibration/run.ts` and `precision-recall.ts` (not `.test.ts`); `eval/context-token-benchmark/` (own sub-package) |
| `npm run typecheck` (`tsc --noEmit`) | `src/**/*.ts` only | **all of `test/`** (`tsconfig.json:22` excludes it). A type error in your test passes typecheck |
| `npm run typecheck:eval` | `src`, `eval` except `eval/fixtures` and `eval/context-token-benchmark/**`, `test/eval` | `test/unit`, `test/integration`, and those two excluded eval paths (`tsconfig.eval.json`). Also: not run by CI |
| `npm run lint` (`eslint .`) | 416 files, currently 0 errors 0 warnings | `dist/`, `node_modules/`, `test/fixtures/`, **`scripts/`**, **`eval/`** (all in the ignores list) |

Two things about lint that matter. First, the script is bare `eslint .` with no `--max-warnings`, and the main rules (`no-explicit-any`, `no-unused-vars`, `no-useless-escape`, `no-useless-assignment`) are all set to `warn`, so warnings exit 0 and cannot fail CI. Second, the repo is nonetheless at zero warnings across 416 files, so a reviewer will expect you to keep it there. Convention, not enforcement.

`no-explicit-any` is turned off for `test/**/*.ts` and `**/*.test.ts` only, deliberately, with the reasoning written into `eslint.config.mjs`. `src/` stays strict: use real types or `unknown` plus narrowing, not disable comments.

### What CI enforces

Everything here comes from `.github/workflows/ci.yml`, which you can read. CI runs on push to `main` and on every pull request. Four jobs, all `ubuntu-latest`:

- `build-and-test`, matrix Node 20.x and 22.x, `fail-fast: false`, running `npm ci` then lint, typecheck, build, test in that order.
- `release-rehearsal` on Node 22.x, standing up a throwaway Verdaccio registry and installing the package from it.
- `drift-scan`, which dogfoods the CLI on this repo.
- `secret-scan`, gitleaks v8.18.4 against `.gitleaks.toml`.

The `drift-scan` job's `--fail-on-score` threshold is commented out in the workflow pending recalibration, with an explicit "fail threshold is DISABLED for now" comment, so a green CI is not evidence the self-score is healthy.

Not run by CI at all: `typecheck:eval`, both calibration harnesses, the eval harness, the handbook build.

---

## 5. Traps that will make you produce a wrong answer

These are ordered by how often they turn a correct-looking investigation into a wrong report.

### Check whether your shell shadows `grep`

Run `type grep` before you trust a single negative search result. Some setups (including several agent shells) alias or wrap `grep` with a gitignore-aware ripgrep, which **silently skips files**. Under such a wrapper a recursive search that returns nothing may mean "not present" or may mean "present in a file the wrapper declined to read". If yours is wrapped, use `command grep` for every recursive search. Every negative result in your report that came from a wrapped `grep` is worthless, and negative results are exactly what blast-radius claims rest on.

### Function extraction is regex, not AST, and it is blind in specific ways

`src/codedna/function-extractor.ts` is the shared extractor feeding nine call sites: baseline assembly (`core/baseline.ts:206`), the MCP candidate feeder (`mcp/candidate-feeder.ts:43`), semantic duplication (`drift/semantic-duplication.ts:62`), the scoring engine's function count (`scoring/engine.ts:794`), the embedding index builder (`ml-client/build-embedding-index.ts:36`), the ml-client (`ml-client/index.ts:121`), the codedna entry (`codedna/index.ts:25`), session change detection (`session/detect.ts:80`), and session finding anchoring (`session/finding-anchor.ts:119`). Eight of those call `extractAllFunctions`; only `semantic-duplication.ts` calls `extractFunctionsFromFile`. Enumerate the radius with both symbols or you will undercount:

```bash
command grep -rn "extractAllFunctions\|extractFunctionsFromFile" src/
```

It supports four languages via five regex patterns. For JS/TS it recognizes exactly two shapes: a `function NAME(...)` declaration and a `const NAME = (...)` arrow.

Running the real extractor over a case matrix gives:

| Construct | Extracted? |
| --- | --- |
| `function doThing(a: number) { ... }` | yes |
| `function doThing(a: number): { v: number } { ... }` | yes (return-type braces are handled by a dedicated scanner) |
| `function doThing<T>(a: T) { ... }` | yes |
| class method | **no** |
| static class method | **no** |
| object-literal method (shorthand) | **no** |
| `let` / `var` arrow | **no** |
| `const f = function () {}` | **no** |
| `const f = a => {}` (no parens) | **no** |
| `function* gen() {}` | **no** |
| `function f(cb: (x: number) => number)` | **no** (params captured with `([^)]*)`, stops at the first `)`) |
| `function f(a = compute(1, 2))` | **no** (same cause) |
| `function f<T extends Array<string>>(a: T)` | **no** (generics captured with `<[^>]*>`) |
| `const f: Fn = (a) => {}` | **no** (type annotation on the const) |

This is JS/TS-specific. Go receiver methods, Python class methods, and Rust `impl` methods all extract fine.

The consequence for your reports: **a class-heavy TypeScript repo can score well on semantic duplication because almost none of its code was extracted.** If you are about to claim "VibeDrift misses duplicates in X", check whether X was extracted at all before you blame the similarity math. Conversely, if you are about to claim a duplication bug is narrow, check whether the same extractor feeds eight other consumers.

Two silent size guards drop functions: raw body under 10 characters (`function-extractor.ts:239`), and fewer than 5 tokens under `tokenizeBody` (`:244`).

`ExtractedFunction.params` and `paramCount` come from `paramsStr.split(",")` with no structural awareness (`:241`). A destructured `{ a, b }` becomes two params. A trailing comma adds an empty one. Do not build anything on `paramCount`.

### There are two duplicate detectors with different coverage

`src/analyzers/duplicates.ts` is the one consumer that does **not** use the shared extractor. It carries a private five-regex `extractFunctions` (lines 61-95) plus its own `extractBody` (lines 30-59). Its JS/TS patterns require `)\s*\{` (line 64) or `)\s*=>\s*\{` (line 65) immediately after the params, so it sees **no TypeScript function with a return-type annotation of any kind and no generic function**. The shared extractor handles both return-type annotations and simple generics such as `<T>`, though not nested-angle generics such as `<T extends Array<string>>`. On annotated TypeScript, `duplicates.ts` is strictly weaker.

The two also disagree on body boundaries: the shared extractor's `rawBody` excludes the opening `{` and includes the closing `}`; `duplicates.ts`'s `extractBody` includes both. Same MinHash pipeline, different token streams.

They share `FLAG_THRESHOLD = 0.7` and a 15-token floor, but `duplicates.ts` adds a `body.length < 20` character floor (line 79) and does **not** call `isAnalyzableSource`, so it does not exclude tests and configs the way `semantic-duplication.ts:53` does.

If you fix a duplicate-detection bug, decide which of the two you are fixing and say so. Fixing one is not fixing the other.

### Hygiene vs drift: registering a detector does not make it count

The scoring engine runs two parallel tracks. Only **drift**-kind findings feed the Vibe Drift Score composite. Hygiene findings render in their own pane with their own parallel score (`src/scoring/categories.ts:20-24`).

Kind is a per-analyzer-id field in `CATEGORY_CONFIG` (`src/scoring/categories.ts`). The critical behavior is at `categories.ts:188-189`:

```ts
export function getAnalyzerKind(analyzerId: string): AnalyzerKind {
  return ANALYZER_KIND_INDEX.get(analyzerId) ?? "hygiene";
}
```

**An analyzer id that is not registered silently defaults to hygiene.** It compiles, it renders, and it never moves the headline. The comment at `src/drift/index.ts:310-312` records that using the freeform `detector` string "was the root of the wiring bug that excluded 11 of 14 detectors from the score", which is why `driftFindingToFinding` now derives the id from the typed `driftCategory` as `drift-<category>`.

Of the 13 registered static analyzers, only `naming` and `imports` are drift-kind. The other 11 are hygiene, including `duplicates`, while `drift-semantic_duplication` is drift-kind. So "the duplicates analyzer fires more" and "the drift score moved" are different claims about different tracks.

A few other scoring behaviors that make naive magnitude claims wrong:

- `dependencyHealth` has only hygiene analyzers, so on the drift track it is marked not-applicable and drops out of the composite denominator entirely.
- `securityPosture` and `intentClarity` with zero drift findings are **not measured**, not clean. They are excluded from the composite (`engine.ts:317-320`).
- A category with zero findings earns `NO_FINDING_PRIOR = 0.8` of maxScore scaled by LOC over `EVIDENCE_SCALE_LINES = 2500` (`engine.ts:304-305`), not full marks. Small fixtures do not score 100.
- Findings are weighted by location (`engine.ts:348-359`): generated/fixture 0.05, tests 0.35, examples 0.35, entry points 1.5, everything else 1.0. A finding you plant in a test fixture is worth about a third of a real one.
- Two re-tagging gates run before scoring: the reimplementation concentration gate (`REIMPL_CONCENTRATION_MIN_COUNT = 3`, `REIMPL_CONCENTRATION_DENSITY_MIN = 1.0` per KLOC, `engine.ts:115-116`) and the security min-peer floor (`MIN_SECURITY_PEERS = 4`, `engine.ts:154`). Both are applied inside `computeScores` **and** hoisted into `src/cli/commands/scan.ts:435` and `:450`, where they mutate the shared findings array, because the in-engine call only re-tags its own local copy.

### The findings cache will hide your change

`src/core/findings-cache.ts:74-75` keys on `sha256(analyzerId \0 version \0 sorted file content hashes)`, and `src/core/run-analyzers.ts:38` reads `analyzer.version ?? 1`. If you change an analyzer's logic without bumping its `version` field, anyone with a warm cache keeps seeing the old output. It will not reproduce on your machine after a clean run.

Current version fields (verified by enumerating `src/analyzers/*.ts`):

```
complexity 3   config-drift 2   dead-code 7   dependencies 3   duplicates 3
implementation-gap 1   imports 2   intent-clarity 2   naming 2   security 3
todo-density 2   error-handling NO VERSION FIELD   language-specific NO VERSION FIELD
```

Those last two are permanently keyed at 1. Editing either one **requires** adding the field.

Only the analyzer layer is cached. Drift detectors and Code DNA run uncached every scan, so `Analyzer.version` is irrelevant to them. The cache that can mask a drift-detector change is the MCP baseline: `BASELINE_VERSION = 3` in `src/core/baseline.ts:34`, which prefixes the content merkle in the cache key. Bump it when vote logic, the detector set, or the signature format changes.

### Version bumps and stale docs

`SCORING_VERSION` is `"v14"` (`src/scoring/engine.ts:95`). Any change to scoring math, a constant, a factor, or a gate threshold requires bumping it and adding a history entry to the comment block above it. Note the history block documents v1-v7 and v10-v13 only, with no v8, v9, or v14 entry, so do not treat that block as a complete changelog.

Cross-version scan diffs are refused on purpose. A cross-version delta once reached the diff surfaces and was committed into `.vibedrift/context.md` with resolved and new claims it could not support (CHANGELOG 0.16.2). The engine now suppresses the score delta and the whole "since last scan" section on a version mismatch, in the terminal banner and in the committed `context.md` alike.

Several handbook chapters are stale on this constant: `docs/handbook/08-scoring.md` says v13, and `11-outputs.md` and `15-glossary.md` say v11. The registry counts in `AGENTS.md` (13 analyzers, 14 detectors) do match the code. **When a doc and a registry disagree, the registry wins**, and `docs/handbook/02-architecture.md:19` says so explicitly.

Other independent version knobs: `HISTORY_SCHEMA_VERSION = 3` (`src/core/history.ts:37`), `EMBEDDING_INDEX_VERSION = 2` (`src/core/embedding-index.ts:30`).

### Helpers that behave surprisingly

`isAnalyzableSource` (`src/drift/utils.ts:127-131`) does unanchored substring matching on `test|spec|mock|fixture`. Running it on path strings: `src/latest.ts`, `src/protest-form.ts`, `src/mockup.ts`, and `src/specimen.ts` all return `false`, while `src/normal.ts` returns `true`. Use the helper anyway for consistency, but know that your file counts exclude paths like these.

The entropy gate is more aggressive on a two-pattern axis than the `0.8` constant suggests. Running `entropyGate` directly on binary distributions:

| Distribution | Decision | H_norm | Plurality |
| --- | --- | --- | --- |
| 9 / 1 | `flag_deviators` | 0.469 | 0.900 |
| 8 / 2 | `flag_deviators` | 0.722 | 0.800 |
| 76 / 24 | `flag_deviators` | 0.795 | 0.760 |
| 75 / 25 | `no_convention` | 0.811 | 0.750 |
| 7 / 3 | `no_convention` | 0.881 | 0.700 |
| 5 / 5 | `no_convention` | 1.000 | 0.500 |

The boundary for a binary axis sits between a 0.75 and 0.76 plurality share, which is **stricter than the 0.70 directory dominance threshold** (`utils.ts:558`). If your detector runs both, the entropy gate is what actually decides, not the vote threshold. A 70/30 split is already "no convention here", not "drift".

Also: `seedDominanceVote` (`utils.ts:359`) and `buildDirectoryScopedVote` (`utils.ts:552`) mutate the distribution Map you hand them, writing a `weight` field on every entry. Reusing a distribution across two votes means the second sees the first's weights.

---

## 6. Filing an issue

Blank issues are disabled (`.github/ISSUE_TEMPLATE/config.yml`). You must use the bug or the feature template, and the feature template requires you to answer "How does this improve drift measurement?". Security problems never go in a public issue: use the GitHub advisory form or `security@vibedrift.ai`, and upgrade to the latest published `@vibedrift/cli` first, since fixes land on the latest release (`SECURITY.md`).

### Before you file

1. Search open issues **and** `todo.md` at the repo root. `todo.md` is tracked and public, it is the live backlog, and nothing links to it from the README, `CONTRIBUTING.md`, `AGENTS.md`, or `.github/`, so you will not be told to read it. Its top items carry `[P0]` markers and `(#N)` issue references, and they are written as executable specs: exact files, reproduced symptom, proposed fix, and the measurement required before shipping. If your issue is already there, a maintainer expects a PR that follows that spec, not a duplicate report.
2. Reproduce on the **built** CLI or from source, not from your memory of a run: `npx tsx src/cli/index.ts <path> --local-only --format json`.
3. Determine which layer you are in. A finding that renders but does not move the score is a hygiene-track finding, not a scoring bug. A finding that does not appear at all may be an extraction blind spot, not a detector bug.
4. Run the four bars. Do not file until bar 4 has a number.
5. Run the refuter on your own draft before you post it. This is the whole point of the file.

### The template that forces the work

Fill this in on top of the repo's bug template. Every line exists because a filed issue got one of them wrong.

```markdown
## Mechanism (bar 1)
<file:line>. What the code does and why. Quote the line.

## Reachability (bar 2)
The exact call path from a user command to this line.
Gates on that path and whether they are open in the reported case:
- findings cache (analyzer version): 
- kind track (drift or hygiene): 
- language applicability: 
- size or peer-count thresholds: 

## User-visible outcome (bar 3)
What a user sees that is wrong. Paste the actual output, redacted.

## Magnitude, measured (bar 4)
Population measured: <what set, how large, why that set>
Command run:
```
<exact command>
```
Raw output:
```
<paste it>
```
Result: N of M. Not "most". Not "many".

## Blast radius, measured in both directions
Narrower than it looks because: <gates that limit it, or "none found">
Wider than it looks because: <every other caller>
Callers enumerated with:
```
command grep -rn "<symbol>" src/
```
<paste the list>

## What I could not verify
Explicit UNVERIFIED list. Do not fill this with reasoning.
```

Two things reliably make a report worse: asserting a count you computed by eye from a search result, and claiming a behavior "does not happen" without constructing an input that would make it happen. If you assert absence, build the input and run it.

---

## 7. Fixing a bug

### Root cause, not the symptom site

The recurring failure here is a fix that swaps one false-positive class for another. A concrete example lives in the tree. The Go multi-module fix for issue #48 (CHANGELOG 0.17.x) added a nested `go.mod` walker that resolves each `.go` file to its nearest enclosing module. That walker does not apply the main scan's gitignore, file-count-cap, or size filters, so a nested module can exist with zero of its files in `ctx.files`. The guard at `src/analyzers/dependencies.ts:410-416` exists precisely for that: a scope with `fileCount === 0` is skipped, because "no files scanned implies no evidence of what it imports implies no phantom claim". Without it, every declared dependency of an empty scope would be reported as unused, on exactly the repo class the original issue was about.

So before you write the fix, answer: **what new false class does this create, on the same input that motivated the bug?** Then measure it, on a population, the same way you measured the original.

### The regression test is required and it must bind

`AGENTS.md:81`, `CONTRIBUTING.md:110`, and `docs/handbook/14-extending.md:103` all say bug fixes need a regression test. The harder requirement is that the test must actually bind. A golden test can stay green while the constant it supposedly guards is moved.

The house technique: invert your change (stash the fix, reverse the sort, restore the old constant) and confirm the test **fails**. A test you have not seen fail is not a regression test.

There is a good model in the tree. `test/unit/output/floor-badge.test.ts:426-433` explains in a comment exactly why the test is not vacuous: both findings carry the same severity so the default priority tier ties, and without the fix the tie-break would put naming first. That comment is what a reviewer wants to read.

### Write a fixture that looks like production code

Author-written tests here can pass on artificial fixtures while the feature is inert on real code. Two failure shapes to watch for: a signal that depends on identifier relatedness will behave completely differently on bodies full of ubiquitous words (`return`, `error`, `value`, `response`) than on a hand-picked `const palette = {red:1}`; and a path that decomposes multi-function files will not be exercised at all by single-function test bodies.

Include at least one fixture that looks like something a person would write: a logger, a cache, a multi-function file, a class.

### Proving the fix without breaking calibration

For a behavior fix, the fast loop is:

```bash
npx vitest run test/unit/<area>/<file>.test.ts
npm test
```

If your change touches a **detector or classifier**, the handbook (chapter 13, steps 3 through 5) says to run the accuracy harness and diff the trend rows:

```bash
npm run calibrate
```

This overwrites `test/calibration/reports/latest.json` and writes a timestamped `pr-<stamp>.json`. Both paths are gitignored so your tree stays clean, but the run you are supposed to diff against is the one you just destroyed. **Copy `latest.json` somewhere first.**

That harness enforces exactly one gate: the `security-floor` row must hold precision at or above `FLOOR_PRECISION_GATE = 0.95` (`precision-recall.ts:52`, enforced at `:233`) or the script throws. Every other row, including all four `security_posture` rows, is report-only and cannot fail the run. Do not lower the gate to make a run pass; the comment at `precision-recall.ts:45-50` says so directly.

If your change touches **scoring or finding weights**, the handbook says to run:

```bash
npm run calibrate:monotonic
```

**This is currently red on `main` and it is not your fault.** Running it on this tree:

```
inject     composite    drift    findings   Δ comp
0%         83.2         83.2     11         n/a
10%        85.0         85.0     15         1.8
25%        83.9         83.9     16         -1.1
50%        78.3         78.3     17         -5.6
75%        71.1         71.1     21         -7.2
90%        69.3         69.3     21         -1.8

monotonicity:   ✗ composite non-monotonic: 0% (83.2) → 10% (85.0)
responsiveness: ✓ each 25% → ≥3pt drop confirmed
```

The composite rises from 83.2 to 85.0 between 0% and 10% injection, so `checkMonotonic` fails and the script exits non-zero. Responsiveness still passes. `todo.md` records this as pre-existing and tracked with the scoring-formula responsiveness work. **Capture a before and after rather than chasing it**, and say in your PR that the 0-to-10 violation was present before your change. This harness writes only to a tmpdir, so it is safe to run repeatedly.

---

## 8. Adding a detector

`AGENTS.md:76` and `CONTRIBUTING.md` state the bar. `docs/handbook/14-extending.md:3` expands it:

> a new signal must be grounded in a baseline it deviates from (a dominance vote, a similarity measure, a taint flow). A raw heuristic with no peer group can still ship, but it is hygiene-kind by definition and will never move the Vibe Drift Score.

So decide up front which one you are building, because it determines everything downstream. If you cannot name the peer group, you are building a hygiene analyzer, and that is a legitimate thing to build as long as you do not tag it drift.

### The wiring, and the step that silently does nothing

Adding a drift detector touches five places. Step 4 is the one that looks optional and is not.

1. New file in `src/drift/`.
2. Add the `DriftCategory` to the union in `src/drift/types.ts:12-25` **and** a `DRIFT_WEIGHTS` entry (`types.ts:27-41`). Note there are 14 detectors and 13 categories: `architectural-contradiction` and `commit-archaeology` both emit `architectural_consistency`, so a detector reusing an existing category skips this step.
3. Register in `createDriftDetectors()` in `src/drift/index.ts:22-39`.
4. **Register `drift-<category>` in `CATEGORY_CONFIG` in `src/scoring/categories.ts` with `kind: "drift"`.** Skip this and `getAnalyzerKind` returns `"hygiene"` by default (`categories.ts:188-189`), your detector renders, and it never moves the score. Nothing errors. Shipping-and-it-compiles is not evidence.
5. Add the field to the `DriftScores` interface (`src/drift/index.ts:67-86`) and the category array entry inside `computeDriftScores` (`src/drift/index.ts:124-174`, array literal near the top of that function) if you added a new category.

`DRIFT_WEIGHTS` look like composite weights and are not. They are per-category report-bar maximums used only inside `computeDriftScores`. The composite is a geometric mean of five 0-20 category healths (`engine.ts:710`) and never reads them.

### Count-based detectors must say so

If your detector measures a **count** (pairs, orphans, occurrences) rather than a peer ratio, set `countBased: true` on the finding. `driftFindingToFinding` then drops `driftSignal`, which routes the finding into the scoring engine's saturating-density branch instead of letting a `consistencyScore` you invented be read as a real deviation rate. `src/drift/semantic-duplication.ts:236` does this and explains why in the comment block above it. Copy that pattern, not the dominance one.

For a dominance detector, note that the sample-confidence term (`SAMPLE_FULL_CONFIDENCE = 8`, `engine.ts:283`) means a vote reaches full damage weight only once it saw at least 8 relevant files, and a finding with `consistencyScore` of 100 contributes exactly zero damage: `engine.ts:451-455` deliberately does not apply the `DEVIATION_FLOOR = 0.05` to it.

### Thresholds are not interchangeable

Two existing callers of `findSimilarToBody` (`src/codedna/find-similar-to-body.ts:24`) use different thresholds on purpose: 0.60 for discovery (`src/tools-core/tools/find-similar-function.ts:15,53`) and 0.80 for validating a change (`src/tools-core/tools/validate-change.ts:29,195`, whose comment says it is "stricter than discovery" because a change introducing a near-clone is a stronger claim). That helper has **no LSH pre-filter and no minimum-token guard**: it runs a full LCS against every index entry. If you add a third caller, pick a threshold consciously and add your own token floor.

Do not fold the deep-index floor into that set. `src/mcp/deep-index.ts:41` defines `BORDERLINE_FLOOR = 0.72`, but it is passed to `findSimilarByEmbedding` (`deep-index.ts:75`), an embedding-cosine search over the embedding index, not an LCS token search. Different metric, not comparable to 0.60 and 0.80.

The deep-scan sampler (`src/ml-client/sampler.ts:31-32`) deliberately uses a different LSH configuration, 32 bands by 4 rows instead of the shared 16 by 8 (`src/codedna/minhash.ts:148-149`), and keeps only pairs in the band [0.55, 0.80] (`sampler.ts:20-21`), strictly below the 0.7 flagging threshold. If you "unify" those configs to remove the apparent duplication you delete the sampler's reason for existing. The rationale is written out at `sampler.ts:22-30`.

Understand what the similarity numbers actually mean before you set a threshold, and measure your own pair rather than reusing someone else's number, because the figures move with token count. Running `buildSignature` plus `lcsSimilarity` on two pairs:

```
"const total = a + b; return total;"  vs  "const total = a - b; return total;"
  10 tokens each, similarity 0.900

a 9-line cache method vs the same method with `this.cache` swapped for `this.store`
  69 tokens each, similarity 0.971
```

Both are well above the 0.7 flag threshold. The minimum-token floors are the only thing standing between the pipeline and that false-positive class, so do not lower them casually.

### Calibrating a new detector

Per `test/calibration/README.md:30-32`, adding a measurable category is two steps: add an injector to `test/calibration/injectors.ts` that produces a clear minority deviation from the baseline's dominant pattern, and map its key to your `driftCategory` in `INJECTOR_CATEGORY` in `precision-recall.ts`. Ground truth is mechanical: the harness diffs baseline against injected content, and every file whose content changed is a labeled positive.

If your detector is language-specific security work, give each language corpus its **own directory root**. The comment at `precision-recall.ts:129-136` gives the rule: merging a language's files into the shared baseline contaminates the naming and architecture rows and shifts the clean-scan false-positive floor, and merging its counts into the shared `security_posture` row lets that language's regression hide behind good numbers from the others. The underlying reason is that `repoHasAuthMachinery` (`src/drift/security-consistency.ts:107`) is repo-global over `ctx.files` rather than scoped to a route group, documented at `test/calibration/python-security-fixture.ts:8-14`.

Categories with no synthetic ground truth (`semantic_duplication`, `dead-code`, `phantom_scaffolding`) are reported as un-measured rather than scored as failures, because they legitimately fire on the templated baseline's near-identical handlers.

If your detector touches security, the governing invariant is **NEVER-FALSE-BLESS**, stated in four modules (`security-xfile-index.ts:10`, `security-ast-rust.ts:167`, `security-ast-go.ts:56`, `security-ast-python.ts:674`, and restated at `security-ast-rust.ts:870`, `security-ast-go.ts:153` and `:505`). Under-resolving and hedging to "unsure" is acceptable. Marking an unauthenticated route as authenticated is not. Past false-bless bugs came from reusing a deliberately loose helper as a strict bless gate, and from a bless lane missing the produce-position check its sibling lane had.

---

## 9. Opening a PR

### What "green" actually means

The four commands passing is the floor, not the ceiling. Specifically, green does **not** mean:

- Your test files typecheck. `tsc --noEmit` excludes `test/`.
- You introduced no lint warnings. Warnings exit 0.
- The self-scan is healthy. `drift-scan`'s fail threshold is commented out.
- Calibration holds. Neither harness runs in CI.

If your change touches detectors, classifiers, or scoring, state the calibration result in the PR body. Nobody else will run it.

### Commit and PR title conventions, as measured

The documented format is `feat|fix|docs(scope): description` (`AGENTS.md:80`). What history actually looks like, measured on `main`:

| Measurement | Last 40 commits |
| --- | --- |
| Mean subject length | 43.9 chars |
| Median subject length | 43 chars |
| Subjects at or under 50 chars | 23 of 40 |
| Parenthesized conventional form (`fix(scope): ...`) | 5 of 40 |
| Bare `prefix: subject` form, no parentheses | 32 of 40 |
| Any `prefix:` form (bare or parenthesized) | 37 of 40 |

The live prefix vocabulary is wider than the documented three. Across all 141 commits on `main`: `fix` 24, `feat` 21, `release` 19, `docs` 19, `ci` 7, `chore` 7, `changelog` 7, `session` 4, `test` 2, and one each of `scoring`, `refactor`, `gitignore`, `eval`, and `core`. There is no commitlint configuration anywhere in the repo. Following the documented form is always safe; do not assume anything is mechanically enforced.

**Title the PR the way you want the commit to read.** PRs are squash-merged, and the PR title usually becomes the permanent subject on `main`, not your local commit messages. A few recent subjects are sentence-case PR titles that broke the convention. Keep it short: the recent median is 43 characters.

Branch naming is `type/kebab-slug` by convention: 24 of 35 remote branches use it (`feat/` 10, `fix/` 6, `docs/` 3, `release/` 2, `assets/` 2, `chore/` 1). The rest are ten older flat `security-*` names plus `release-0.16.0`. Merged branches are not auto-deleted on this repo, so an old branch existing does not mean the work is unmerged.

### What the PR must contain

The repo template asks for a summary, a type checkbox, six checklist items, and a `Closes #`. Two checklist items are content policies rather than code policies and are easy to trip on a docs PR: no secrets, credentials, pricing, or internal strategy; and copy that says "Vibe Drift Score", never "debt score" or "quality score". A `secret-scan` gitleaks job runs on every PR and will fail the build on a committed credential.

On top of the template, add these three things. They are what makes a PR reviewable without the reviewer redoing your work:

1. **The measurement.** The command you ran, the raw output, and the population. If the PR changes what fires, show before and after on a real repo, not a fixture.
2. **The regression proof.** State that you inverted the change and watched the test fail. One sentence.
3. **The blast radius.** Every caller of anything you touched, enumerated with a recursive search over `src/`. If you edited the shared function extractor, say which of the nine consumers you considered, and enumerate them with `command grep -rn "extractAllFunctions\|extractFunctionsFromFile" src/` rather than a single-symbol search.

If a change makes a Developer Handbook chapter stale, update the chapter in `docs/handbook/` and rebuild with `npm run handbook` **in the same PR** (`AGENTS.md:83-84`).

### After a squash merge, do not keep pushing

Follow-on commits on a squash-merged branch get orphaned and never reach `main`. Open a new PR from a fresh branch off current `main`. If you have to reconstruct a branch after a squash merge, transplant with a tree-identity acceptance check (`git diff old-tip new-branch` empty) rather than a blind rebase.

---

## 10. Reviewing a PR

Reviewing here means verifying, not reading. The pattern holds on the review side too: the author's mechanism is usually right and the author's magnitude is usually unmeasured.

**Run the branch.** Check it out, `npm ci && npm run build && npm test`, then run the CLI from source against a real repo before and after. If the PR claims a detector now fires on something it missed, construct that input and watch it fire. A described behavior is not a verified behavior.

**Recompute every number in the description from scratch.** Do not check the author's arithmetic; redo the measurement. This is the single highest-yield review action in this repo.

**Ask the gating questions explicitly**, because they are where the blast radius lives:

- If an analyzer changed, was its `version` bumped? If not, warm-cache users see nothing. `error-handling` and `language-specific` have no version field at all, so editing either one requires adding it.
- If a drift detector was added, is `drift-<category>` in `CATEGORY_CONFIG` with `kind: "drift"`? If not, it renders and never scores.
- If scoring math changed, was `SCORING_VERSION` bumped and a history entry added?
- If vote logic, the detector set, or the signature format changed, was `BASELINE_VERSION` bumped?
- If a shared helper changed, were all its callers enumerated? Run the search yourself.

**Check that the tests bind.** Stash the source change, keep the test, run it. If it still passes, the test is decorative.

**Check the fixtures are realistic.** If every new test body is a two-line arithmetic function, the feature may be inert on real code. See the two failure shapes in section 7.

**Read the whole diff as one unit if it spans modules.** Cross-file review finds bugs that per-file review structurally cannot. Two documented instances in the security work: a Python `permission_classes` blessing non-`api_view` routes (a cross-task composition bug), and a Rust 403 bless lane missing the produce gate its 401 sibling had.

**Verify claims in docs and CHANGELOG against the code that implements them.** Two caught examples in this project. A CHANGELOG entry described behavior gated on `ScanResult.deepInsights`, a field that is declared at `src/core/types.ts:262`, initialized to `[]` at `src/cli/commands/scan.ts:483`, read by output modules, and never written; a live JSON scan still emits `"deepInsights": []`. And a signed-in scan was uploading the full body of every scanned file plus the parsed syntax tree, because the step that strips them was unreachable from the code path that built the upload (CHANGELOG 0.18.x). Grounding a doc in a plan document as if it were shipped is itself the bug.

---

## 11. Lessons a newcomer would otherwise violate

These come from this project's own incident history, and each is anchored in code you can read.

**Determinism is a hard requirement.** `src/core/discovery.ts:74-79` sorts directory entries by code-unit comparison and the comment says explicitly *not* `localeCompare`, because `localeCompare` is itself locale-dependent, and because traversal order drives `MAX_FILE_COUNT` truncation. All number formatting goes through a fixed `Intl.NumberFormat("en-US")` helper (`src/output/format.ts:20`) rather than `toLocaleString()`; the only remaining occurrence of that method name in `src/` is the word inside the helper's own explanatory comment at `format.ts:13`. Reintroducing either would make the same commit score differently on different machines.

**Anything that keys state by repository root must call `canonicalizeRoot()`** from `src/core/baseline.ts:95`. It is called at six sites in five files across three subsystems: `cli/commands/scan.ts:1095`, `mcp/baseline-provider.ts:112`, `session/repo.ts:15` and `:17`, `session/decision.ts:85`, `session/mcp-tee.ts:65`. A *partial* canonicalization is worse than none: when only the session layer was realpath'd while scan still used `resolve()`, every symlinked path (macOS `/tmp` to `/private/tmp`) silently loaded no baseline and produced zero flags, with no error. Related: on macOS, synthetic hook payloads in tests and demos must carry the canonical `/private/tmp` path or the baseline cache misses.

**The session resolve path creates false resolves.** This is the repo's most-repeated bug, and one round of it was introduced by the fix for a previous round. The binding rule is at `src/session/finding-anchor.ts:16-17`: resolve only on the **positive absence** of the anchored construct, never because a classifier went quiet. Four documented silence paths that are not fixes are listed at `finding-anchor.ts:10-13`: the `MAX_FUNCTIONS = 5` query cap (`src/session/detect.ts:17`), a majority vote over the whole body, a "mixed" verdict that maps to no pattern, and a similarity query diluted because the surrounding file grew. The raise goes through `src/session/detect.ts`; the re-check resolves through `signalPresent` (`src/session/finding-anchor.ts`), which measures the positive absence of the anchored construct rather than re-running detection blind. For redundancy that predicate is raw-token containment of the anchored clone OR the whole-file duplicate query, OR'd on purpose: a whole-body-only query dilutes a 3-function body against a 1-function index entry to roughly 0.33 similarity, under the 0.8 threshold (`detect.ts:4-5`), and containment covers the wrap-plus-one-token disguise the query misses, so neither check alone can falsely resolve a still-present clone (#86, #84).

**Do not simplify the regexes in `src/session/mask.ts`.** Two critical leaks were found there. Provider keys with internal hyphens (`sk-ant-api03-`) need a run that allows hyphens and underscores mid-token (`mask.ts:14-17`). Snake_case env names (`OPENAI_API_KEY=`, `DB_PASSWORD=`) defeat a leading `\b` because `_` is a word character (`mask.ts:36-41`). Both fixes look like redundant complexity and are not.

**The hook entrypoint is fail-open by contract.** `src/session/hook-entry.ts:10-12` exits 0 on malformed input, unknown events, missing baseline, internal errors, and timeout, and exits 2 only to deliver an advisory. The `SELF_TIMEOUT_MS = 2000` self-timeout (declared at line 30) is armed at line 33, **before** the dynamic imports, on purpose. Do not add a static heavy import, a throw path, or a network call there. The in-memory edit body is destructured off at line 229, under the comment at line 228, and must never reach the ledger.

**The inline session check silently no-ops on large repos.** `src/session/check.ts:106` skips when the baseline exceeds `INLINE_CHECK_MAX_ENTRIES = 2000` (`check.ts:23`). It reports no error. If you are testing session flags on a big codebase and see nothing, check this gate before hunting for a bug.

**`vitest` blanks `VIBEDRIFT_HOME` for the whole suite** (`vitest.config.ts:12`) because a developer's sandbox override leaking into tests was a reproduced HIGH finding, and test writes would land in the sandbox. Do not remove it, and do not write a test that depends on inheriting it.

**Test-harness traps that have burned hours here.** `spawnSync` blocks the parent's event loop, so if your harness is also a fake HTTP server the child's connection can never be accepted; it looks exactly like a code bug. Use async `spawn`. And a stub more permissive than the real server makes correct policy look broken: fix the stub, never weaken the policy to satisfy it.

**Fields that report an outcome must carry the real outcome, never an inference.** `checked` on edit events (`src/session/types.ts:29-34`) is true only when the inline check actually ran, with an enumerated skip list, precisely so a downstream density metric cannot be fabricated from edits that were never checked.

**`src/scoring/dedup.ts` returns a copy even in the no-op path, deliberately.** Callers replace their list in place via `allFindings.length = 0; allFindings.push(...deduped)`, and returning the input reference would empty the array before the re-push, silently dropping every finding and floating the composite to roughly 100. The comment at `dedup.ts:28-32` says so. Preserve it if you refactor.

**Known accepted limitations, not bugs to fix silently.** `upload-state.ts` has a non-atomic read-merge-write under racing uploaders; `todo.md` records the race as benign and prescribes fixing the two over-promising docstrings rather than adding a lock, since a stranded lockfile from a killed flush child is worse. Separately, `DF-<n>` display numbers are per-session sequential and can collide across concurrent same-repo sessions, documented at `src/session/decision.ts:13`, `:62`, and `:90`. Changing either is a design decision, so open an issue first.

**Never state a capability without reading the code that implements it.** This is the house rule that subsumes most of the rest, and it is why the four bars and the refuter exist. The worst outcome in this project is not a missing feature. It is a user receiving a confident claim that turns out to be false.