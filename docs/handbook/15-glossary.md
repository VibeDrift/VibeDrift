# Glossary

Every term of art used across this handbook, alphabetized. Each entry names the primary source file where the concept lives.

**baseline**: two related senses. (1) The peer-group norm a detector measures deviation against: the dominant pattern in a project or directory. Drift requires a baseline; no baseline, no finding. (2) The `RepoDriftBaseline`: a persisted per-repo snapshot (`~/.vibedrift/baseline-cache/`) of the dominance votes, security sub-votes, intent hints, and a MinHash function index, built as a scan side effect or lazily on first tool call, so the MCP tools answer in milliseconds instead of re-scanning (`src/core/baseline.ts`, `BASELINE_VERSION = 3`).

**beacon**: the anonymous telemetry POST sent after a scan to `/v1/beacon/scan`, carrying only aggregate fields (language, file count, lines, scan time, CLI version, deep flag, git and intent-hint booleans, finding count, score, and an `authed` boolean); no code, paths, tokens, or identifiers. Opt-out via `vibedrift telemetry disable`, `VIBEDRIFT_TELEMETRY_DISABLED`, or `--local-only` (`src/telemetry/beacon.ts`). A second, separate report-open beacon fires from logged-in HTML reports.

**blessing**: marking a route as carrying a security property, most often authentication, so it joins the dominant side of the security vote instead of being flagged. Blessing is deliberately hard to earn: in Python, Go, and Rust only a verifiably rejecting body (or a curated per-route decorator) blesses; a name alone never does (`src/drift/security-ast-*.ts`).

**Code DNA**: Layer 1.7 (`src/codedna/`). Local semantic analysis over extracted function bodies: semantic fingerprints for exact duplicates, the MinHash/LSH near-duplicate engine, operation sequences, pattern classification, taint analysis, and deviation heuristics.

**composite score**: the 0 to 100 headline produced by the scoring engine as a geometric mean of per-category health over the applicable categories. Computed per track; the drift track's composite is the Vibe Drift Score (`src/scoring/engine.ts`).

**consistency score**: per drift finding, `(dominantCount / totalRelevantFiles) × 100`: the share of relevant files (or routes) on the dominant side of the vote (`src/drift/types.ts`).

**consistencyImpact**: the expected gain in a finding's category score if that one finding were resolved, computed by exact recompute under the scoring model. Populated on the drift track by `computeScores` and used to rank the Fix Plan (`src/core/types.ts`, `src/scoring/engine.ts`).

**count-based finding**: a `DriftFinding` with `countBased: true`, meaning it measures a count phenomenon (duplicate pairs, phantom exports) rather than a peer ratio. The scoring engine routes it through a size-normalized density branch instead of reading its `consistencyScore` as a deviation rate (`src/drift/types.ts`).

**deep scan**: the optional, metered Layer 2. `--deep` (or an in-loop `deep: true` check) sends sampled function snippets, at most 30 functions of at most 60 lines each and never full files, to the hosted `/v1/analyze` service for embedding-based duplicate, intent, and anomaly detection with server-side LLM validation. Duplicate, intent, and anomaly results merge locally only at confidence 0.85 or higher; panel-confirmed reimplementations merge as returned (their confidence is the server panel's vote ratio). Any failure degrades to the local result (`src/ml-client/`).

**deviating file**: a file whose detected pattern differs from its vote group's dominant pattern. Carries the `detectedPattern` and line-level evidence, and may be reclassified as `legacy` by pivot detection (`src/drift/types.ts`).

**digest**: a stable 16-hex-character SHA-256 key for a finding, built from the analyzer id, file, line bucket (`floor(line/3)`), and a number-normalized message. Digests make scan-over-scan diffs survive small edits (`src/core/history.ts`).

**dominance vote**: the core drift mechanism: reduce each file (or route) to one pattern, count weighted votes within a peer group (project- or directory-scoped), require a minimum group size (3) and a dominant share (0.7), then flag the minority as deviators (`src/drift/utils.ts`).

**dominant pattern**: the winning pattern of a dominance vote; the convention the repo has de facto settled on for one dimension.

**drift**: deviation from the codebase's own dominant conventions. The product's unit of measurement, deliberately distinct from "quality": drift is always relative to a baseline the repo itself established.

**drift-kind / hygiene-kind**: the routing split declared in `src/scoring/categories.ts`. Drift-kind analyzer ids (grounded in dominance, similarity, or taint signals) feed the Vibe Drift Score; hygiene-kind ids (classic linter signals with no repo baseline) feed only the Hygiene Score. Unknown ids default to hygiene.

**entropy gate**: normalized Shannon entropy over a vote's pattern counts (`H / log2(k)`). Above 0.8 the vote emits a single "no dominant convention" finding instead of flagging deviators, because drift needs a norm to deviate from (`src/drift/utils.ts`).

**Finding**: the universal output record every analyzer and detector produces (`src/core/types.ts`): `analyzerId` (the routing key), `severity`, `confidence`, `message`, `locations`, `tags`, plus optional `consistencyImpact`, `driftSignal`, `dupGroupSize`, and renderer `metadata`.

**fingerprint**: a hash of a normalized function body (comments stripped, local variables renamed positionally, literal values preserved verbatim) used to group exact semantic duplicates. Groups are formed by a two-pass FNV-1a hash and verified with SHA-256 (`src/codedna/semantic-fingerprint.ts`).

**hedge (unsure)**: the third security outcome besides authed and not-authed. An `unsure` hook never blesses; the route stays flagged, but the copy softens to "auth not confirmed, double check hook '<name>'", naming the hook that could not be verified (`src/drift/security-consistency.ts`).

**Hygiene Score**: the parallel 0 to 100 score computed from hygiene-kind findings only. Rendered separately and never mixed into the Vibe Drift Score (`src/scoring/engine.ts`).

**intent hint**: a team-declared convention parsed from `CLAUDE.md`, `AGENTS.md`, or `.cursorrules` (`src/intent/parser.ts`). Hints at confidence 0.6 or higher seed the dominance vote (the declared pattern's weight is boosted 1.5x), and a vote that contradicts a declaration is stamped with intent-divergence provenance.

**LSH**: locality-sensitive hashing. MinHash signatures are split into 16 bands of 8 rows; any pair colliding in at least one band becomes a candidate pair, which is then verified with token LCS similarity (`src/codedna/minhash.ts`).

**managed block**: the delimited region `--inject-context` maintains inside `CLAUDE.md` or another AI-rules file, fenced by `<!-- vibedrift:context:start (auto-generated, do not edit by hand) -->` and `<!-- vibedrift:context:end -->` markers and upserted idempotently in place (`src/output/inject-context.ts`).

**MinHash**: a similarity sketch: 128 seeded hash permutations over a function's token shingles produce a compact signature whose agreement rate estimates Jaccard similarity between functions (`src/codedna/minhash.ts`).

**mutating route**: a route registered for POST, PUT, PATCH, DELETE, or ALL. The auth dominance vote runs over mutating routes only (intentionally public GETs would poison the denominator), and unresolvable methods resolve to ALL precisely so they stay in this vote (`src/drift/security-consistency.ts`).

**never-false-bless**: the strongest honesty invariant in the codebase, governing the security extractors: the analysis may under-report auth (an over-flag, softened by hedged copy) but must never mark an unauthenticated route as authenticated. Enforced by body-first classification, produce-position gating, refuse-on-ambiguity cross-file resolution, and the rule that `unsure` never blesses (`src/drift/security-ast-*.ts`).

**noisy-OR damage**: the scoring aggregation model. Each detector group deals damage of at most 0.85, computed from severity, confidence, file importance, deviation magnitude, and sample confidence; a category's health is the product of `(1 - damage)` across its detector groups, so overlapping evidence saturates instead of stacking linearly (`src/scoring/engine.ts`).

**non-shippable path**: generated, fixture, mock, snapshot, test, or example paths (`src/codedna/nonshippable.ts`). A duplicate group is dropped only when every member is non-shippable, and the scoring engine down-weights findings in such paths.

**op sequence**: a function body reduced to a sequence of 22 abstract operation codes (INPUT, AUTH, VALIDATE, QUERY, and so on). LCS similarity over op sequences measures workflow-shape overlap; the data feeds drift signals and the deep-scan tease but is deliberately not surfaced as standalone findings (`src/codedna/operation-sequence.ts`).

**peer floor**: `MIN_SECURITY_PEERS = 4`. A security-consistency finding whose vote saw fewer than four relevant routes is re-tagged to the advisory hygiene id `security_posture-advisory`: it still renders, but a thin sample never dents the composite (`src/scoring/engine.ts`).

**phantom scaffolding**: exported CRUD-named handlers that are never imported and never appear in any route table; the "complete" endpoints an AI session generated that nothing ever wired up (`src/drift/phantom-scaffolding.ts`).

**pivot**: a temporal majority shift detected within a drift category: the recent dominant pattern differs from the legacy one. Deviators aligned with the old majority are reclassified as `legacy` (migration candidates) rather than drift (`src/drift/pivot-detector.ts`).

**produce-position**: the Rust-specific hardening of "verified reject": a 401 counts only where it is produced as a value (a return, a `?` operand, a block tail, `Err(...)`, `.ok_or(...)`, or a match/if branch tail). A 401 mentioned in a comparison, call argument, or discarded binding is a mention, not a reject, and never blesses (`src/drift/security-ast-rust.ts`).

**SCORING_VERSION**: the scoring methodology tag (currently `"v11"`), persisted with every scan. When the stored version differs from the current one, score deltas are refused rather than computed, and the user sees a single one-time "scoring refined" notice instead of per-scan banners (`src/scoring/engine.ts`, `src/core/scoring-notice.ts`).

**security floor**: the small set of highest-precision security rules (committed secrets, cloud keys, disabled TLS verification) emitted under the distinct analyzer id `security-floor`. They drive a render-only "fix before shipping" badge that never changes the score, and they carry an enforced calibration gate of at least 0.95 precision (`src/analyzers/security.ts`, `src/output/floor-badge.ts`).

**shingle**: a run of k consecutive normalized tokens (k = 5) from a function body; the unit over which MinHash similarity is computed (`src/codedna/minhash.ts`).

**suppression annotation**: the inline `// @vibedrift-public` comment on a route registration (or a `security.allowlist` glob in `.vibedrift/config.json`) that removes a deliberately public route from both sides of the security vote. Every suppression emits a counted hygiene-kind audit finding, so exclusions are always visible but can never move the composite (`src/drift/security-suppression.ts`).

**taint**: Layer 1.7 dataflow analysis: request-derived sources (params, query, body) are tracked to dangerous sinks (SQL, command execution, path traversal, XSS, code injection, SSRF), sanitizer-aware, intraprocedurally plus one interprocedural hop via function summaries (`src/codedna/taint-analysis.ts`).

**temporal weighting**: `2 × e^(-ln2 × daysAgo / 90)`: a just-touched file's vote counts double, a 90-day-old file's counts once, and a year-old file's barely registers. Active only when git metadata is available (`src/drift/utils.ts`).

**tools-core**: the channel-neutral implementation of the in-loop tools, six including `init` (`src/tools-core/`); the `@vibedrift/cli/tools` barrel exports the five query/validate tools. MCP, the `@vibedrift/cli/tools` import, and the Agent Skill are thin adapters over it; nothing in it imports the MCP SDK.

**uniform auth gap**: the fallback vote for a route group that is uniformly unauthenticated, where the primary ratio vote goes silent at 0%. It fires only with a baseline reason to expect auth (auth machinery elsewhere in the repo, or a declared `auth_required` hint); with neither, it stays silent because the group could be an intentionally public API (`src/drift/security-consistency.ts`).

**Vibe Drift Score**: the headline 0 to 100 composite computed from drift-kind findings only: a measure of how consistent a codebase is with itself, not how good it is. The product's only sanctioned name for the number.
