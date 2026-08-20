# Changelog

All notable changes to `@vibedrift/cli` are documented here. The format
follows Keep-a-Changelog loosely; breaking-shape changes are called out
explicitly under **Breaking** so CI users can recalibrate.

## [Unreleased]

### Fixed

- **Duplicate volume now affects the Redundancy score.** `drift-semantic_duplication`
  was emitted as count-based but never carried `dupGroupSize`, so the scoring
  engine's duplicate-fraction branch was unreachable for it and it fell through
  to the generic count branch, whose divisor is the number of *findings*. Because
  its findings are rolled up per directory, one near-duplicate pair and twenty in
  the same directory produced an identical score. The detector now reports the
  redundant copies each directory holds, so twenty duplicates register as twenty.
  Reported in #102.

  Two properties the fix has to preserve, both pinned by tests: it counts
  redundant *copies* rather than pairs, because a cluster of m mutually-duplicate
  functions is m(m-1)/2 pairs but only m-1 redundant copies; and a cluster
  spanning two directories is counted once rather than in both, by attributing
  each copy to the directory that actually holds it.

### Scoring

**Composite scores move in this release and baselines rebuild.** `SCORING_VERSION`
advances to v16. Repos with several near-duplicate functions in one directory
score lower, which is the defect being corrected. Repos whose duplicate
directories hold a single pair each are unchanged, as are repos with no
near-duplicates.

## 0.20.0 — 2026-08-19

**The in-loop checks stop telling you your own conventions are wrong, and the function index finally sees the methods it was blind to.**

An audit of real Drift Sessions found that most in-loop advisories were wrong, and the causes were structural rather than a matter of tuning. A convention vote measured over one directory was applied to the whole repository, so a directory of Next.js server actions could be told to adopt the error-handling shape of a directory of React components. The in-loop path never applied the exclusion list every batch detector uses, so test setup files, database seeds and throwaway scripts were judged against application conventions. Underneath both, the JS/TS function extractor indexed only top-level `function` and `const` forms, so class methods and object-literal methods were invisible to duplicate detection entirely.

### Fixed — in-loop precision

- **Conventions are judged per directory, not repository-wide.** The baseline kept one vote per category, the one with the widest denominator, discarding both the other directories' conventions and the fact that the survivor was ever directory-scoped. All three in-loop dimensions are grouped by directory by their detectors, so a directory is the only scope in which a dominant pattern means anything. A directory with no established convention now produces silence rather than borrowing another's rule. `get_dominant_pattern` takes an optional `path` and answers from that file's own directory; without it, previous behavior is unchanged.
- **Tests, seeds, scripts and scratch files are no longer judged against application conventions.** The batch detectors already excluded them; the in-loop path did not, and its only gate was whether the language could be parsed. Two files in the audited population documented in their own comments why they throw, and were flagged for throwing.
- **A moved function is no longer reported as a duplicate.** The index is built once per session, so by the time an advisory fires the function it names may have been lifted out. The counterpart is now verified against the file as it stands, and the advisory is suppressed when the original is gone, because that is a move rather than a duplication.
- **Findings anchored to a file can now be resolved.** A redundancy finding whose anchor was not a single function reported "still present" for every possible file content, including an empty file, so no edit could ever clear it.
- **The scope check ignores paths outside the repository.** A relative path escaping the repository root cannot match a repository-relative anchor, so it flagged on every edit by construction, and it also inflated the counter that decides when to flag.

### Changed — function index and duplicate similarity

- **Class methods, object-literal methods, `let`/`var` arrow bindings, generators, accessors and `export default function` are now indexed** for JavaScript and TypeScript. A class-heavy file previously contributed a small fraction of the functions it has.
- **Go generic functions and Rust `fn` declarations with a `where` clause** are now matched. Python needed no change.
- **Duplicate similarity keeps data paths distinct.** An identifier chain was kept literal only when it ended in a call, so a property access like `schema.reports` had both halves erased and every query sharing a call skeleton normalized identically regardless of which table it touched. A chain's members are now kept literal while its head is still renamed, so two implementations that differ only in variable names still match.
- **Body tokenization neutralizes string literals before comments.** A `//` inside a literal was deleting the closing quote and desynchronizing quote pairing for the rest of the body.
- **Ordering is locale-independent.** The baseline cache key and two report orderings sorted with `localeCompare`, so identical inputs could produce different output on machines with different locales.

### Fixed — four constructs that manufactured duplicate findings

Each is a construct whose similarity is forced by the language or by a framework, so it is byte-identical everywhere it appears and carries no signal. Each was found by validating against a corpus of real repositories rather than by unit tests, because each shows up only as a distribution effect.

- **Class constructors** are not indexed. A dependency-injection constructor is the same shape in every class; on one component library they produced 80 of 214 duplicate findings on their own.
- **Not-implemented stubs** are not indexed. A body whose only statement is a throw carries no reusable logic, and telling someone to extract it is wrong advice.
- **Bodiless interface members written without semicolons** are not indexed. Without a terminator the return-type scan ran past the declaration to the first brace anywhere below, capturing comments and other declarations as a body.
- **Call expressions taking a `function (...)` callback** are not indexed. The parameter capture stopped at the callback's own parameter close, so a test registration such as `test('name', function (assert) {` was indexed as a function named after the callee. This one mattered most: function count is the denominator the duplicate scorer divides by, so the phantom entries moved composites in the optimistic direction. On one date library the index inflated from 2190 entries to 5114, and the composite reported an improvement of 10.6 points while that repository's real duplicate fraction had risen. It now reports no change.

### Scoring

**Composite scores move in this release and baselines rebuild.** `SCORING_VERSION` advances to v15 and `BASELINE_VERSION` to 5, so the first scan after upgrading rebuilds the baseline and stored scores are re-aligned. There is nothing to do.

Measured by scanning a shuffled, unbiased sample of 160 open-source repositories across all five supported languages with this release and the previous one:

| Language | repos | median | mean | range |
|---|---|---|---|---|
| Go | 27 | +0.00 | +0.00 | -1.5 to +0.3 |
| JavaScript | 35 | +0.00 | -0.03 | -4.9 to +6.1 |
| Python | 28 | +0.00 | -0.11 | -3.2 to +0.2 |
| Rust | 38 | +0.00 | +0.10 | -0.2 to +0.6 |
| TypeScript | 32 | +0.00 | -0.66 | -10.2 to +4.6 |
| **All** | **160** | **+0.00** | **-0.13** | -10.2 to +6.1 |

68 of 160 repositories (42%) scored identically before and after. 55 improved and 37 worsened.

The median repository is unchanged in every language. Go and Rust are close to inert, which is the expected shape because the gaps closed here were mostly in JavaScript and TypeScript. Movement concentrates in class-heavy and object-literal-heavy codebases, which are exactly the ones whose methods were previously invisible. Every repository moving three or more points was inspected by reading the duplicated function bodies rather than inferring from names, and that inspection is what produced the four exclusions above.

### Known limitations

- A function whose parameter list contains parentheses, such as a callback-typed or defaulted parameter, is not matched by either JS/TS pattern. This predates this release and is unchanged by it. The direction is deliberate: missing a real function is safer than inventing a phantom one, because the phantom inflates the denominator and flatters the score.
- Trivial boilerplate that is genuinely duplicated, such as a one-line accessor repeated across a dozen sibling files, is still reported. A minimum body size for duplicate findings would suppress it; measured on one ORM it halves finding count while recovering under two composite points, so it is a noise lever rather than a scoring one and is not applied here.

## 0.19.6 — 2026-08-07

**Findings stay open until the code is actually gone, and duplicate checks catch functions pasted whole.**

Two accuracy fixes, one to each half of the loop: what Drift Sessions will and will not mark resolved, and what the MCP duplicate tools can see.

- **A disguised clone no longer clears its finding.** The Drift Session re-check falsely resolved a redundancy finding when the flagged clone was moved into a class or renamed and given a one-token cosmetic edit. The re-check now requires positive absence two ways at once — raw-token shingle containment of the anchored clone OR the whole-file duplicate query — and resolves only when both agree the code is gone. Measured on this repository's own functions: the one-token disguises that previously cleared now stay open at 100% (single-token rename) and 99.8% (changed numeral), while genuine removals still resolve. Reported in #86, fixed in #94.
- **A failed file read no longer resolves findings.** When the re-check could not read the post-edit file it fell back to the edit hunk, so a small unrelated edit could "resolve" a finding whose flagged code was untouched on disk. A read failure now skips resolution entirely and leaves findings open. Reported in #84, fixed in #94.
- **`validate_change` and `find_similar_function` now catch clones pasted with their signature.** The duplicate index stores function bodies only, so a query that included the declaration line carried tokens the index never had; for short functions the length gate returned a hard 0 and the duplicate was missed outright. The query is now scored both as given and with a detected leading signature stripped, keeping the higher score per index entry. Measured across every function in this repository: an exact self-clone pasted with its signature scored a median 0.752 before (74.7% under the duplicate threshold) and 1.000 after. Both tools' `body` parameter accepts either form and says so. Reported in #81, fixed in #93.
- **A FIFO in the sessions directory can no longer hang the session-start recap.** The trial recap summed ledger files after checking only their size; a FIFO reports size 0 and a read on it blocks forever. Non-regular files are now skipped and the recap reports itself incomplete instead. Reported in #83, fixed in #97.
- **Session ledger and host prep.** The session schema now carries a `HostAgent` union instead of a hard-coded literal, the ledger writer's oversize path re-masks all detail fields before truncating so slicing can never expose a secret fragment, and a machine without a supported agent is told so before any login prompt rather than after. Docs now list all eight MCP tools.
- Internal: duplicated `escapeRegex` and confirm-prompt helpers consolidated (#95), duplicated security-AST helpers consolidated (#96), and the upload-state concurrency docstrings corrected to describe the deliberate, benign race accurately (#85 via #97).

No scoring changes in this release: these fixes touch the session re-check and MCP query paths, not the scoring engine, so composite scores do not move and baselines do not rebuild.

## 0.19.5 — 2026-08-04

**Stops reporting an ORM that isn't there.**

Three regex defects made the data-access classifier label files `orm` in codebases that have none. Scanning this repository against itself reported `src/auth/api.ts uses http_client while 5/6 files use orm` at confidence 1.0, with no ORM in `package.json`. The label was inverted: the one file that genuinely is an HTTP client was reported as the deviation from a majority that does not exist. Reported in #87, fixed in #92.

- **The Ent signal is anchored.** The ORM regex carried a bare `ent\.` alternative with no left word boundary, so any identifier ending in "ent" followed by a dot read as Ent ORM usage. `file.content.split(...)` was enough. Measured across five repos that declare no ORM, that one alternative produced 125 of 125 "ORM import/usage" signals. Ent is now matched as a package selector followed by an exported identifier, which keeps every real Ent shape and drops the false ones.
- **Handler paths match by segment, not substring.** `route` inside `autorouter.ts` and `route-extractors/`, and `api` inside `therapist.ts`, were admitting files that are not handlers, and a file that enters the classifier gets labelled by whatever signal fires first. Directories genuinely named `routers/` are still included, since that is where real data access lives.
- **Route registrations are no longer read as ORM calls.** `router.Create("/users", h)` and `r.Delete("/orders/{id}", h.Del)` were evidence of an ORM because the detector matched bare CRUD verb names with no receiver. It now discriminates on the first argument: a route path is a string literal beginning with `/`, and no ORM idiom measured passes one there. This label also reaches the MCP `validate_change` tool, so an agent editing a router could previously be told its change conflicts with an ORM the repo does not have.

Measured across 11 repositories and roughly 4,000 files: findings naming `orm` drop from 61 to 13, and architectural-consistency findings are unchanged at 29, so nothing unrelated was lost. Repos that genuinely use an ORM keep their detection: trpc retains all 20 of its real Prisma signals.

**Scores may move slightly.** Removing false findings changes the composite by up to 0.3 points on affected repos. This repository's own score moved from 87.0 to 86.8.

**Baselines rebuild once.** `BASELINE_VERSION` moves to 4 because the data-access vote is persisted in the MCP baseline, so the first scan after upgrading re-derives it.

Known and not fixed here: two other ORM regexes still produce false positives on `np.where(` and `stripe.customers.create({`. That is a separate class with a different fix.

## 0.19.4 — 2026-08-02

**Your dashboard can show real file names, for the repos you choose.**

Sessions show `file 77aa11bb` where a file was flagged, because only a salted pseudonym ever leaves your machine. You can now opt a repo in so the dashboard names it properly:

```
vibedrift watch-session --names on     # this repo only
vibedrift watch-session --names off    # deletes what was uploaded, stops future uploads
```

- **Paths only.** Never file contents, never absolute paths, never anything outside the repo. Whether a file is inside the repo is decided when the edit is recorded, not guessed from the path afterwards, and anything unmarked is left out rather than assumed safe.
- **Off by default**, per repo, and the disclosure prints before the setting is saved.
- **Reversible for real.** Turning it off deletes the names already uploaded, including for a repo that has moved on disk, and it applies to every clone of that repo rather than only the one you ran it in. If the delete cannot reach the server, nothing claims success and it retries later.
- **Never gets in the way of a session.** Names upload only after your session record is safely stored, and a failure there cannot block or corrupt it.

**Also fixed: file paths on Windows.** Paths recorded during a session used backslashes, which broke matching against your repo's patterns. They are recorded portably now.

## 0.19.3 — 2026-08-02

**The most important catch now leads.**

When one edit trips several checks, only one advisory reaches your agent. That pick used to follow a fixed category order, so a near-exact duplicate of code you already have could sit behind a debatable style note and never get mentioned.

- **Duplicates at 90% similarity or higher go first.** Everything is still recorded either way; this only changes which one the agent hears about while it works.
- **Pattern advisories say what they actually measured.** A learned convention now reads "Dominant pattern in this repo's sampled files" instead of "Repo uses", because the vote comes from the files the check indexed, not every file you have. Conventions you declared yourself in CLAUDE.md keep the direct wording and cite the line that declares them.
- **Your agent can always record its call on a live session.** Recording a decision used to time out after 10 minutes while the dashboard still showed the session live for 15. Both now use the same 15-minute window.
- **Headless runs no longer lose the agent's reasoning.** When the decision tool is unavailable, as in a CI or `-p` run, the agent is told to state its decision and reason in its reply instead of silently dropping it.

## 0.19.2 — 2026-08-01

**Sessions now record whether each edit was actually checked.**

Every edit event in a session carries a simple fact: did the inline drift check run on this edit, or was it skipped? That powers the dashboard's new drift density reading (flags per 100 checked edits) with an honest denominator; skipped edits never count.

- **Docs and config no longer flag.** Non-code files are now a proper skip: a code snippet quoted inside a markdown file was previously checked as if it were source, which could flag example code in your docs. It no longer does.
- **A huge pattern cache can't slow your session start.** The baseline read is size-capped on the hook path; an oversized cache simply counts as "no baseline" instead of being parsed while your agent waits.
- No change to advisories, decisions, or exit behavior. Hooks still fail open, and older session records without the new field are unaffected.

## 0.19.1 — 2026-07-30

**You can now see where your free trial stands.**

Drift Sessions gives every free account 5 watched sessions. Until now, the only way to find out how many you had left was to run out.

- Every new session on the trial starts with a quiet one-liner: `VibeDrift trial: 2 of 5 sessions used.` It shows once at session start, never interrupts your work, and paid accounts never see it.
- Your last free session says so up front. And once a session starts recording, it finishes recording, even if the trial runs out mid-session.
- When the trial is spent, the notice shows what VibeDrift actually caught on your machine: `flagged 2 drifts; your agent fixed 1 on the spot, re-verified.` If your local session records show nothing, or there are none, it claims nothing. No estimates, no invented numbers.
- The [dashboard](https://www.vibedrift.ai/dashboard/sessions) shipped the matching upgrades this week: the same trial meter, fixed-and-re-verified counts on every session, all three agent calls (accepted, parked, declined), and your agent's pre-write checks on the session timeline.

## 0.19.0 — 2026-07-29

**Your agent now cleans up after itself.**

[Watch it work (60 seconds)](https://www.vibedrift.ai/native-sessions-demo.mp4).

You let an AI write a lot of your code. It is fast, but it does not know your codebase the way
you do: it re-invents helpers you already have, drifts off the patterns your team settled on,
and leaves all of it for you to catch in review.

Drift Sessions puts VibeDrift inside the agent's decision loop. The moment an edit strays from
how your codebase actually does things, the agent hears about it in its own context, while it
is still working. Most of the time it simply fixes the code and moves on. You see the diff
after it has already been corrected.

Setup is one command, once per repo:

```
vibedrift enable
```

No terminal to keep open. No tool call the agent might skip (the MCP waits to be asked; this
does not wait). Nothing to remember before each session.

### What you get

- **Fewer bad diffs in review.** Off-pattern code is caught and corrected while the agent
  works, not days later in a pull request.
- **An honest record.** Every catch, every fix, every time the agent pushed back and why, on
  your dashboard. A fix only counts when the same check re-runs over the new code and passes.
  Nothing is taken on the agent's word.
- **Your code stays yours.** Sessions are recorded to a local ledger, prompts secrets-masked.
  With hosted sync on, only findings and outcomes reach the dashboard, never your code or your
  prompts. `vibedrift decline` turns it off for a repo, reversible anytime.
- **Running agents across a team?** The session record shows what drifted and what got fixed in
  every agent session, without reading every diff.

### Also in 0.19.0

- In a repo that has never decided, Claude offers to turn it on, once, at session start. Three
  asks ever, then it stays quiet.
- `vibedrift enable --dir <path>` turns on every repo under a folder, with a typed confirmation
  first. Home directories and filesystem roots are refused.
- `watch-session` is now optional: still the live terminal tape, no longer what makes syncing
  work.
- Uploads survive restarts and never double-send.
- Hooks fail open: an error or timeout never interrupts your agent.

Drift Sessions is a Pro feature. The first five sessions are free.

## 0.18.1 — 2026-07-27

### Fixed

- **Signed-in scans no longer upload file contents.** When you are signed in, each scan syncs its
  result to your dashboard. That payload was carrying the full body of every scanned file, plus the
  parsed syntax tree, because the step that strips them was unreachable from the code path that
  builds the upload. Only per-file metadata now leaves your machine: the repo-relative path, the
  line count, and the language. Nothing else about the dashboard changes.
  Run a fresh scan to replace any previously synced results, or use `--local-only` to scan with no
  network at all.

## 0.18.0 — 2026-07-27

### Added

- **Import-style drift now covers Go, Python, and Rust** (previously JS/TS only). The
  `import-consistency` detector is now a language-agnostic, per-axis core with one classifier
  per language: Go import grouping + gofmt ordering; Python absolute-vs-relative paths +
  wildcard imports; Rust glob / intra-crate-path (`crate::` vs `super::`/`self::`) / use-grouping
  conventions. Each axis is voted independently (directory-scoped dominance + entropy gate), so a
  file can be consistent on one dimension and drift on another. JS/TS behavior is unchanged and
  now also reads CommonJS `require()` alongside ES imports. Idiomatic Rust globs (`use super::*;`
  in tests, external `::prelude::*`) are excluded to avoid false positives. Closes #56.

### Changed

- **Go, Python and Rust projects may see their score move in this release.** Import style is a
  scored drift category that applies to every language, but until now only JS/TS could produce
  findings for it, so those projects scored it clean by default. Now that the detector reads them,
  a real import inconsistency counts against the score the same way it always has for JS/TS.
  Nothing about the scoring formula changed, and JS/TS scores are unaffected.
- Because those numbers were produced under different detection coverage, VibeDrift refuses to
  compute a trend across this release rather than reporting a drop your code did not cause. The
  first scan after upgrading establishes the new baseline, and trends resume from there.

## 0.17.1 — 2026-07-25

### Fixed
- `npx @vibedrift/cli` failed with "could not determine executable to run" since 0.17.0: the
  package briefly declared a second executable, which stops `npx` from auto-selecting the CLI.
  The package now declares a single `vibedrift` executable again; the session hook entrypoint is
  unchanged (hooks invoke it by absolute path, and `bin/vibedrift-hook.mjs` remains available).

## 0.17.0 — 2026-07-23

### Added

- **Drift Sessions (preview): `vibedrift watch-session`.** Consent-gated Claude Code
  hooks record the session to a local append-only ledger (`~/.vibedrift/sessions/`):
  prompts (secrets masked), edit metadata, and drift flags, with one-line advisory
  notes fed back into the agent when an edit diverges from the repo's own dominant
  patterns. Local-only, fail-open. `--uninstall` restores your settings byte-for-byte
  when they are unedited since install, otherwise removes only our entries.
- **Drift Sessions: live event tape.** `vibedrift watch-session` now follows the
  session in real time — prompts, edits, and drift flags stream in with a running
  count and an end-of-session summary. When the VibeDrift MCP is enabled, the agent's
  own tool calls join the same tape as ASKS/REPLIES rows. `--no-watch` installs
  without following.
- **Drift Sessions: intent tier + drift gauge.** The tape now captures the task
  from your prompt (files and symbols named), locks it, and conservatively flags an
  edit unrelated to any of them (experimental). A smoothed noisy-OR drift gauge with
  hysteresis rides the footer, and the summary reports how many of the task's target
  files were touched.
- **Drift Sessions: real outcomes.** A finding resolves only when the same finding
  re-runs over the re-edited file and passes (never because an unrelated file changed),
  so resolved/open counts are honest. Repeat flags on an already-open finding are
  deduped, byte-exact reverts are noted, and `watch-session` hints when a repo has no
  baseline yet.
- **Drift Sessions are Pro, with a 5-session free trial.** A free account gets the
  first five sessions full-featured; after that the tape locks behind a summary of what
  the trial caught, with an upgrade CTA. The trial count is server-side (survives
  reinstalls). A locked account captures nothing; the capture hook stays offline and
  reads a local entitlement cache. Recorded local ledgers always remain yours.

## 0.16.3 — 2026-07-22

### Fixed

- **Go multi-module repos no longer get false "imports not in go.mod" errors.** The
  dependency scan now checks each `.go` file against its nearest enclosing `go.mod`
  instead of the repo root, so a package declared in a nested module (a `tools/`
  module, an example module, a `go.work` service) is recognized as declared. Declared
  modules are also matched by import path prefix, so multi-segment module paths like
  `github.com/org/sdk/submodule` and `/vN` major-version suffixes are no longer truncated
  to three segments and mislabeled missing. Imports of a sibling in-repo module, and
  `// indirect` requires, are handled correctly too. Fixes the 2 false errors on go-chi/chi
  and 38 on Terraform reported in issue #48. Single-module repos are unchanged.
- **Honest N/A copy.** A category with no score now says why: "nothing to measure in this
  repo" (e.g. Security Consistency in a repo with no web routes), or "not scored (evidence
  below floor); findings kept as advisory" when the peer floor demoted the findings —
  instead of "no findings in this repo", which read as a clean bill for a check that never
  ran. Terminal and HTML report alike.
- **The security disclaimer names all three sub-conventions** it actually measures: auth,
  validation, and rate-limit patterns.
- **Per-file Drift/Static tallies match the report's sections.** A finding demoted to
  advisory now tallies as Static in the per-file table, the same split the section
  headings use, instead of counting as Drift in one place and listing as Static in another.
- **Concentrated reimplementation is labeled drift everywhere.** When the concentration
  gate fires, the re-tag now reaches every output surface (terminal, HTML, CSV, DOCX,
  context.md), matching the score it already moves.
- **The per-category breakdown no longer credits an unmeasured Security Consistency with
  full health.** When the category is N/A, the breakdown (including the copy uploaded to
  the dashboard) omits it instead of showing a full-score bar next to the N/A.
- Removed a crash risk on extremely large finding sets (whole-array argument spreads
  replaced with loops).
- **Signed-in users no longer see the sign-in nudge.** `vibedrift watch` and any signed-in
  `--format terminal` scan previously ended with "Sign in with `vibedrift login`" even
  though the session was already authenticated. Signed-in state is now resolved locally
  (zero egress — `--local-only` and `watch` are unaffected) and the closing line reads
  "Run `vibedrift . --deep` to reveal them. Your first deep scan each month is free."
- **The "Since last scan" diff no longer calls advisory findings drift.** The diff digest
  and the persisted scan are both built from the scored drift view, so a below-floor
  security finding (or a `@vibedrift-public` suppression) that the report renders as
  advisory can no longer appear as a "new drift finding" in the banner or in
  `.vibedrift/context.md`. Note: the first scan after this upgrade on a repo whose history
  already persisted such findings reports them as "resolved" once, then self-heals.

## 0.16.2 — 2026-07-16

### Fixed

- **Cross-version score deltas are now fully suppressed.** The scan-over-scan diff refuses
  to compare scans scored under different scoring versions: no score delta and no
  resolved/new claims, in the terminal banner and in the committed `.vibedrift/context.md`
  trajectory alike, including when `--since` targets a scan from an older engine.
  Previously the suppression covered the score header, but a cross-version delta could
  still reach the diff surfaces and be committed into `context.md`. The first scan after
  a scoring upgrade simply shows no "since last scan" section; normal diffs resume from
  the very next scan.

## 0.16.1 — 2026-07-16

### Changed

- **Deep-scan results now show in the default output.** The default terminal summary
  surfaces the AI results a deep scan produced — the coherence grade (paid plans), the
  AI summary, the top AI finding, and the AI-validated finding count — instead of only
  under `--format terminal` or in the report. Non-deep scans are unchanged.
- **Scoring refined (recalibration).** Three precision fixes move the score only for
  repos they touch: the Go security auth check now reads routes registered on Fiber and
  Gorilla mux routers, dependency drift no longer counts import-like text sitting inside
  comments or strings, and files with regex special characters in their names classify
  correctly. Affected repos may see their Vibe Drift Score move to reflect drift that was
  always there (or shed false positives); every other repo is unchanged. Saved scores are
  kept as-is, the new method applies to new scans, and the CLI shows a one-time notice.
  CI users gating on `--fail-on-score` for such repos should re-check their threshold.

### Added

- **Go: Fiber and Gorilla mux route coverage.** Routes registered through Fiber and
  Gorilla mux router constructors now enter the security auth-consistency check, so an
  unauthed mutating route in those frameworks is flagged like its Gin and Echo peers.

### Fixed

- **Dependency drift ignores imports in comments and strings.** An import statement
  quoted in a doc comment or a string literal no longer shows up as dependency drift.
- **Filenames with special characters classify correctly.** Code-DNA patterns derived
  from file names now escape regex metacharacters instead of misreading them.

## 0.16.0 — 2026-07-16

### Added

- **Security Consistency now checks Python, Go, and Rust**, not just
  JavaScript/TypeScript. The auth check reads the body of the middleware or hook
  that guards a route and classifies each route as protected, unprotected, or
  **unsure**. It never marks a route authenticated on a name or type alone — only
  when a readable guard verifiably rejects (a 401, or a credential-guarded 403).
  When the guard's body can't be read (imported, opaque, or an extractor type),
  the route is flagged "unsure, double check" and named, rather than guessed
  either way. This holds across Flask/FastAPI/Django (Python), Gin/Echo/stdlib
  (Go), and Axum/Actix/Rocket (Rust).
- **Cross-file auth resolution.** When a route's guard is a hook imported from
  another file, the scanner follows the import to that file and reads the real
  body before deciding, instead of hedging on the name.

### Changed

- **Import graph is now AST-based.** Import and dependency analysis moved from
  regex to a real tree-sitter AST with module resolution, so imports mentioned
  in comments or strings no longer produce false-positive dependency drift.

### Breaking

- **Scoring recalibrated (internal scoring version bumped).** Because the auth
  check now understands Python, Go, and Rust routes, a web repo in those
  languages that carries real auth inconsistency may see its Security Consistency
  (and composite) score move to reflect drift that was always present — a Flask
  app in our testing dropped about 5 points. Repos whose auth is uniform or
  expressed only through extractor types, and repos without those route shapes,
  are unchanged. Saved scores are kept as-is, the new method applies to new
  scans, cross-version score deltas are suppressed, and the CLI shows a one-time
  notice linking to the release notes. CI users gating on `--fail-on-score` for
  an affected repo should re-check their threshold.

## 0.15.0 — 2026-07-09

### Fixed

- **Security Consistency now sees catch-all and Flask routes.** Express
  `.all()` routes and Flask `@app.route(..., methods=[...])` routes were
  excluded from the auth-consistency check, so a repo could carry an unauthed
  state-changing route that produced no finding at all. Routes are now
  classified by their real method: a mutating route with no guard is flagged,
  while read-only routes (a bare Flask `@app.route`, which defaults to GET) are
  left alone, so plain GETs never raise a false alarm. The in-loop
  `validate_change` check shares the same route classification as the batch
  scan, so the two can never disagree.
- **`check_file_drift` no longer reports a file as clean when it has an unauthed
  route.** It now reads the per-convention security votes (auth, validation,
  rate limit) instead of a single collapsed slot, so an auth deviation can't
  hide behind a wider convention.
- **The MCP baseline rebuilds itself after an upgrade** instead of serving votes
  computed under an older version. A security convention drawn from too few
  routes to be reliable is now surfaced as advisory rather than stated as
  established.

### Changed

- **Scoring refined (recalibration).** Because the auth check now counts routes
  it previously missed, repos that use Express `.all()` or Flask `methods=[...]`
  routes may see their Vibe Drift Score move to reflect security drift that was
  always present. Saved scores are kept as-is and the new method applies to new
  scans; the CLI shows a one-time notice linking to the release notes. CI users
  gating on `--fail-on-score` for such a repo should re-check their threshold.
  Every other repo is unchanged.

## 0.14.9 — 2026-07-06

### Fixed

- **Fewer false-positive unused exports.** An export used only through a
  destructured dynamic import (`const { thing } = await import("./module.js")`)
  is now recognized as used. Lazy-loaded modules — common in CLIs and
  code-split apps — are no longer flagged as unused, and the files they load are
  no longer counted as orphaned.

## 0.14.8 — 2026-07-01

### Changed

- **Dependency Health is no longer shown as a scored category.** It has no drift
  check yet, so it always read "N/A"; the dependency signals it does have (unused
  / phantom packages) continue to feed the Hygiene score. The Vibe Drift Score
  now shows four drift dimensions.

## 0.14.7 — 2026-07-01

### Added

- **`--inject-context` flag.** Inlines the context summary into `CLAUDE.md`
  inside an idempotent managed block. Pairs with `--write-context` — run both
  together to refresh `.vibedrift/` files and keep the CLAUDE.md block in sync
  in a single pass.

### Fixed

- **Fewer false-positive duplicates.** Recurring test-fixture helpers, and
  functions that merely share a control-flow shape rather than real duplicated
  logic, are no longer flagged as duplicates — so the duplicates you see are the
  ones actually worth consolidating.
- **Clearer messaging for categories with no signal.** Instead of a bare
  "N/A — not scored", a category with nothing to score now says why: Dependency
  Health reads "not yet measured", and every other category reads "no findings
  in this repo".
- **Cleaner scans of repos with vendored code.** File discovery now skips
  vendored and minified files, so bundled third-party code doesn't skew results.

## 0.14.6 — 2026-06-27

### Changed

- **Scoring version updated.** The deep-scan reimplementation change below is
  recorded as a new scoring version. VibeDrift shows a one-time notice linking the
  release notes and suppresses score comparisons across the version boundary, so
  you never see a misleading delta. Existing scores are kept as they were; the new
  scoring applies to new scans.

## 0.14.5 — 2026-06-27

### Changed

- **Concentrated reimplementation now affects the score on deep scans.** When a
  deep scan finds the same logic redundantly reimplemented across many files at
  high density, that now lowers the Vibe Drift Score. Sparse, incidental
  reimplementation stays informational and does not affect the score, so
  well-structured codebases are never penalized for a stray parallel or legacy
  implementation. Local and signed-out scans are unaffected.

## 0.14.4 — 2026-06-26

### Changed

- **Results appear immediately.** A scan now prints the Vibe Drift Score,
  category breakdown, and fix plan as soon as the scan finishes. The slower
  steps — AI fix prompts (Pro) and the dashboard sync — then run behind labeled
  progress indicators instead of a silent wait.
- **Signed-in scans link to your dashboard.** A signed-in scan links straight
  to its project on the dashboard (full report, history, and trends) instead of
  opening a local HTML file.
- **Signed-out scans get the full report.** Running signed out now gives you the
  complete HTML report too, served locally and opened in your browser, instead
  of a summary-only teaser.

## 0.10.0 — 2026-06-18

### Added

- **Tools API (`@vibedrift/cli/tools`).** The five in-loop checks are now a plain
  import as well as an MCP server. Same engine, plain async functions, your code
  stays local. See `docs/tools-api.md`.
- **Agent Skill.** A self-contained skill at `skills/vibedrift/` runs the same
  checks from the command line, so an agent gets drift prevention with or without
  an MCP server.
- **`vibedrift hook`.** Install a git pre-push hook that blocks a push whose Vibe
  Drift Score is below a threshold. Bypass once with `git push --no-verify`.

### Changed

- The tool logic now lives in a transport-neutral core (`src/tools-core`) with the
  MCP server as a thin adapter over it. No behavior change: the MCP tools and their
  results are identical. A guard test keeps the core free of transport imports.

## 0.9.7 — 2026-06-17

### Fixed

- **Startup on some Linux installs.** The published binary's shebang passed a
  flag that not every `env` implementation accepts, which could stop a global
  install from launching. The flag is gone and the CLI starts the same way
  everywhere.

## 0.9.6 — 2026-06-17

### Added

- **`VIBEDRIFT_TELEMETRY_DISABLED` environment variable.** A new env-var opt-out
  for the anonymous usage beacon and the daily npm update check, alongside
  `vibedrift telemetry disable` and `--local-only`. Convenient for CI and
  automation.

### Changed

- **Plain-language telemetry disclosure.** The README, `--help`, and docs now
  state exactly what the anonymous usage beacon sends (language, file count,
  lines of code, scan time, CLI version, finding count, score; no code, no file
  paths, no identifiers) and that it is on by default for every scan, signed in
  or not. Your code never leaves your machine, and you can opt out anytime. The
  beacon also carries an anonymous signed-in/signed-out boolean (no identifier).

## 0.9.5 — 2026-06-14

### Added

- **Lines of code per scan.** Every scan now reports the total lines of code it
  covered. The count rides along on the anonymous beacon and the dashboard scan
  log, so repo size shows up per project for benchmarking — still no code, no
  file paths, no PII.
- **vibedrift.ai link in committed `.vibedrift/` files.** `context.md`,
  `fix-prompts.md`, `fix-plan.md`, and `patterns.json` now carry a link back to
  vibedrift.ai, so a committed context folder points teammates to the tool.

## Earlier releases (pre-open-source)

Versions before 0.9.5 predate the open-source release of the CLI. Their full
changelog lives in the project's git history; it is omitted here because some of
those notes referenced the closed cloud service's internals.
