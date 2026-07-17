# Output Surfaces

A scan produces one `ScanResult`; everything the user sees is a renderer over that object. The renderers live in `src/output/` and share two rules. First, they only render: no renderer recomputes scores or mutates findings, so every surface shows the same facts. Second, they are honest about scope: when a number covers less than it appears to, the copy says so instead of letting the reader assume.

## Terminal rendering

`renderTerminalOutput` in `src/output/terminal.ts` composes the full authenticated view: update banner, score section, scan-over-scan diff banner, category bars, peer percentile, fix plan, drift findings grouped by category, the hygiene pane, deep-scan sections when present, and closing calls to action. `renderBriefOutput` is the unauthenticated variant, `renderConciseSummary` the authenticated three-fix summary, and `renderJsonOutput` the machine shape for `--json`. On a deep scan the concise summary also carries a short AI block (`renderConciseAiSummary`) showing whichever deep artifacts the scan actually produced: the coherence grade (fetched on paid plans only), the AI summary line, the top AI finding, and the AI-validated finding count (findings tagged `ml`, the same filter as the HTML deep section), plus a pointer to the full analysis. The block is presence-gated per artifact, so a free-tier deep scan surfaces its results too and a non-deep scan renders byte-identically to before.

### The score block

`renderCategoryBars` prints each category as `score/max` with a 20-character block bar, colored green at 80% of max and above, yellow at 50%, red below. A category with no findings and no relevant files renders as "N/A" with an explanation rather than a perfect score, and when any category is N/A the composite line appends a scope note built by `compositeScopeNote`: `(over N of M categories)`. The comment on that function states the invariant: the headline can never silently imply a full verdict over categories that were not measured.

Two other honesty rules render here:

- The Hygiene Score is printed as a separate scalar explicitly labeled as not part of the Vibe Drift Score, keeping the drift-vs-hygiene split visible at the surface.
- Under the Security Consistency bar a permanent disclaimer renders: "consistent ≠ safe: measures how uniformly this repo applies its own auth and validation patterns, not the absence of vulnerabilities". VibeDrift measures drift, and this line stops the security category from being misread as a vulnerability audit.

### Hedged security copy

Some auth findings are produced by body-signature analyzers (Python, Go, Rust) that could not confirm whether an auth hook applies. Those producers append a stable "Double check" hedge to the recommendation naming the unverified mechanism. The terminal renderer detects them with `isHedgedAuthFinding` and swaps the confident consequence line ("Unprotected routes may be exposed in production") for a hedged one parsed back out of the recommendation: "The `<noun>` (`<names>`) may already authenticate some of these routes, double check it before treating them as unprotected". The hedge also renders as an extra yellow line under the finding. Every confident security finding stays byte-identical; only the genuinely unconfirmed ones are softened.

### The security-floor badge

`src/output/floor-badge.ts` implements a render-only warning line: "Security floor: `<reasons>`. Fix before shipping (does not change the score)." It trips on `security-floor` analyzer findings (committed secrets, disabled TLS verification) or on `codedna-taint` findings whose sink is code or command injection (via the `INJECTION_SINK_LABELS` export described in the Code DNA chapter).

> [!IMPORTANT]
> `hasFloorTrip` never touches `compositeScore` or the grade. That is a locked constraint with a dedicated grade-invariance test: the floor is a shipping gate rendered next to the score, not a score input. A repo can be perfectly self-consistent (high drift score) while carrying a committed secret, and the two facts are reported independently.

### The fix plan

The fix plan selects top findings by `consistencyImpact`, the score gain from fixing that finding, and filters out anything below `FIX_PLAN_MIN_IMPACT = 0.05` (`src/output/fix-plan-select.ts`) so no line ever renders as "+0.0pts". In drift-first mode, ordering uses `findingPriority`: security findings weigh 10 times severity, architectural and intent findings 8, duplication 6, dependency and error-handling 5, everything else 2. The plan footer renders a projected score after fixes via `estimateScoreAfterFixes`, rounded to the nearest 5 and phrased as an approximation ("projected ~85/100"), because a point-exact projection would overstate the model's precision.

### The diff banner

When a comparable previous scan exists, a "Since last scan" banner renders the relative age, resolved and new counts split into drift versus hygiene, the top 3 new drift findings, and the score delta. Two suppression rules protect it from lying:

- If the previous scan was produced under a different scoring version, the banner is silently suppressed: both the delta and the resolved/new counts would be artifacts of the methodology change, and the one-time scoring notice (below) explains what happened instead.
- If the previous scan predates the diff-capable history schema, the banner says so and treats this scan as a fresh baseline rather than claiming everything is "new".

## HTML report

`renderHtmlReport` in `src/output/html.ts` builds a fully self-contained document: all CSS and JS inline, no external requests needed to read it. It renders in two modes: `summary` (header, hero score, category breakdown, fix-plan widget, drift concentration, footer) and `detailed` (adds the codebase-intent section, intent-coherence heatmap, the full drift findings library, a per-file ranking accordion, pattern consensus, hygiene, and the deep-scan section when a deep run happened).

The embedded tail script implements a persisted dark/light theme toggle (applied pre-paint so there is no flash), copy-to-clipboard for embedded AI fix prompts (the prompts are embedded only for paid plans via `buildEmbeddedPrompts(result, isPaid)`), client-side CSV export built from the embedded `window.__VIBEDRIFT_DATA`, print-to-PDF, and a sticky mini-header. Grade mapping is the same as everywhere else: A at 90% and above, B at 75, C at 50, D at 25, else F. The same `hasFloorTrip` from the terminal drives an equivalent floor chip.

When the report was generated for a logged-in scan (`opts.scanId` set), the page embeds a one-shot beacon that POSTs `{scan_id, opened_at}` to `/v1/beacon/report-open` on load; the local/cloud boundary chapter covers exactly what that carries.

## CSV

`renderCsvReport` in `src/output/csv.ts` emits a multi-section CSV: metadata, CATEGORY SCORES and DRIFT SCORES, DRIFT FINDINGS, the Code DNA sections (SEMANTIC DUPLICATES, OPERATION SEQUENCE MATCHES, TAINT FLOWS, DEVIATION ANALYSIS, PATTERN DISTRIBUTIONS), ALL FINDINGS, PER-FILE SCORES sorted ascending by score, and DEEP ANALYSIS INSIGHTS. Consistency with the composite is enforced at render time: when the composite shows security as N/A, the security row is suppressed from the score sections so the two surfaces never contradict, and below-floor security findings were already excluded at the scan source.

## DOCX

`renderDocxReport` in `src/output/docx.ts` produces a real OOXML `.docx`. A `.docx` file is a ZIP archive of XML parts, so the renderer includes a minimal hand-rolled ZIP writer: `deflateRawSync` from `node:zlib` for compression, a local CRC32 implementation, and manually assembled local file headers, central directory, and end-of-central-directory records. No document library is pulled in; the writer is about 70 lines and covers exactly the subset OOXML needs. The document sections mirror the CSV: title page, score table, intent, drift, Code DNA, per-file table, findings table, deep insights, footer.

## context.md, patterns.json, and fix plans

`writeContextFiles` in `src/output/context-md.ts`, triggered by `--write-context` (requires a free account), writes committable files into `<repo>/.vibedrift/`:

- **`context.md`**: a human-and-agent-readable digest. Header comment marking it auto-generated and safe to commit, with the refresh command. Then: score and grade, dominant language, file and line counts; a "Dominant patterns in this codebase" section with one bullet per drift category (dominant pattern, `count/total files`, an exemplar path); "Drift items currently open" listing the top 10 by `consistencyImpact` with their point gains; a "Recent trajectory" section (previous-scan age, score delta, resolved/new counts, top new findings) when a comparable diff exists; and an "If you're an AI agent working on this codebase" section that instructs agents to match the dominant patterns and re-run the CLI after changes.
- **`patterns.json`**: the machine shape of the same votes: per category `{dominantPattern, dominantCount, totalRelevantFiles, consistencyScore, dominantFiles, deviatingFiles}` plus generator metadata and the score.
- **`fix-plan.md` and `fix-prompts.md`**: on paid plans, a full fix plan and per-finding prompt blocks; on free, an upsell block explaining what would be there.

The writer warns when `.vibedrift/` is gitignored, since the files exist to be committed and shared with the team and with agents.

## The `--inject-context` managed block

Committing `context.md` only helps agents that go looking for it. `--inject-context` (`src/output/inject-context.ts`) pushes the content into the files agents already read, by default `CLAUDE.md`, inside a managed block:

```markdown
<!-- vibedrift:context:start (auto-generated, do not edit by hand) -->
...context.md content...
<!-- vibedrift:context:end -->
```

`upsertManagedBlock` makes the operation idempotent: when both markers already exist, the block is replaced in place, and the text before and after survives untouched; otherwise the block is appended with correct separators; a missing target file is created. Re-running never duplicates the block or corrupts surrounding content, which is the property that makes it safe to wire into a refresh loop. The injected body is prefixed with a one-line preamble telling agents the block is regenerated by `vibedrift --write-context --inject-context` and should be read before editing code. CLI wiring is in `src/cli/commands/scan.ts`.

## History diffs and trajectory

Scan history lives in `~/.vibedrift/scans/<projectHash>/scan-<timestamp>.json` (`src/core/history.ts`), with retention capped at 10 scans per project. The schema is versioned separately from the scoring methodology:

- `schemaVersion` (`HISTORY_SCHEMA_VERSION = 3`) describes the structural shape. v1 mixed scores, v2 split drift from hygiene, v3 added finding digests, which is what makes diffing possible.
- `scoringVersion` (currently `"v11"`, exported from `src/scoring/engine.ts`) describes the methodology the numbers were computed under.

### Digest stability

A finding digest is `sha256(analyzerId | file | lineBucket | normalizedMessage)` truncated to 16 hex characters. Two normalizations keep digests stable across harmless edits: every integer in the message is replaced with `N`, so "3 occurrences" and "4 occurrences" match, and line numbers are bucketed by `floor(line / 3)`, so a finding survives the surrounding code shifting by a couple of lines. Drift-finding digests are line-less (keyed on detector, category, subcategory, dominant pattern, and normalized text) because drift findings are project-scoped rather than positional. Saves cap digests at 200 generic and 100 drift entries.

### The diff engine

`diffScans(previous, current)` in `src/output/history-diff.ts` classifies digests into resolved (in previous, not current), new, and persistent, independently for generic and drift findings, with deterministic ordering. Score delta is a plain difference; the header documents that the engine deliberately does not attribute the delta to individual findings, because that causal projection is lossy and belongs, if anywhere, in a UI layer that can label it as an estimate. A previous scan below schema v3 is marked `incomparable: true` and everything lands in "new", since without digests nothing can honestly be claimed resolved.

### Cross-version delta suppression and the one-time notice

When `previous.scoringVersion` differs from the current `SCORING_VERSION`, delta computation is refused: the numbers were produced under different formulas and subtracting them yields a misleading result. Instead of a per-scan version banner (an earlier design that was rejected as noise), `src/core/scoring-notice.ts` shows a single one-time notice: "We refined how the Vibe Drift Score is calculated this release. Your existing scores are kept as they were; the update applies to new scans. What changed → https://vibedrift.ai/releases". `shouldShowScoringNotice` shows it once per version change and skips brand-new users entirely (nothing to re-align, so the version is recorded silently). No internal version string is ever shown to the user.
