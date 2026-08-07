# CLI backlog

- **[DESIGN-READY, GATED] Multi-host native sessions — Phase 0 contract freeze + adapter program.**
  Full narrative in workspace LOGBOOK 2026-08-03. Six hosts verified to have Claude-style hook
  surfaces (Cursor 21 events / Codex 11 stable-default-on / Gemini 11 GA / Copilot 14 / Windsurf-Devin
  / Cline record-only; Zed+Aider none). Panel verdict: wrong next build while adoption is 1 uploader;
  ship Phase 0 now INSIDE Claude Code (HostId union at types.ts:70 server-first, ULID aid, lane field,
  delivery-tier stamps, writer-side masking choke point in appendEvent closing the promptText-only
  byte-cap hole and the single-destructure body strip, ledger concurrency measurement, derived
  get_pending_flags, liveness + trial-fuse cause attribution in doctor) and gate all adapters behind a
  WRITTEN adoption trigger (suggested ~10 weekly uploaders or a named mixed-host team deal). Second
  host default: Codex CLI. Cursor needs a runtime probe first (afterFileEdit batch-edit reports) plus
  committed-config consent machinery (.cursor/hooks.json commits to VCS — one teammate must never
  enable capture on another's machine; consent gate is the first line of every adapter). Killed ideas
  (do not re-propose): seq write-time ordering field (no ledger lock exists), pre-opt-in funnel
  beacons (consent violation), standalone advisory queue store (ledger is the store), git-status
  sweep edits (human edits on the agent tape), committed hooks.json as default distribution,
  first-session flag KPI. 11 founder decisions pending, 1-4 block Phase 0: gate values, delivery tier
  on the wire, lane ordinals on the wire, trial-fuse enforcement point (currently UNDEFINED and is
  itself a scheduled silent-capture-stop).

- **[PARKED] opencode.ai host adapter (verified in source 2026-08-03, not started).** opencode is an
  MIT agent (org `anomalyco`, Bun-compiled binary + Electron desktop host) with a JS plugin API, not
  shell hooks. A 34-agent adversarial pass over the real source confirmed the port is viable and the
  advisory channel is actually stronger than Claude Code's: throwing inside `tool.execute.before`
  aborts the tool body, leaves the session alive, and delivers the raw `Error.message` to the model
  verbatim as a tool-error, so the guardrail fires at the moment of the decision rather than at the
  start of the turn. Context injection also works on the non-experimental `chat.message` hook
  (push onto `output.parts`). Shape if built: a thin `@vibedrift/opencode-plugin` that only
  translates into the existing `vibedrift` CLI, so the ledger/masking/canonicalization stay in one
  place. Must-nots discovered, each a silent failure: (1) never key capture on a tool NAME, because
  on GPT models opencode ships `apply_patch` and removes `edit`/`write`, so an `edit`-keyed hook
  records zero file mutations while looking healthy; (2) never use the `$` shell helper, it is
  `Bun.$` and is `undefined` on the Node/Electron host despite being typed non-optional, so use
  `child_process` and pass `directory` explicitly; (3) `output.parts` must be mutated in place, and
  a pushed part needs a full valid shape or the prompt dies with zero LLM calls; (4) a throw stops
  every later plugin's hook on that trigger, and one of the seven call sites (`prompt.ts:308`,
  subtask path) is outside the containment that makes throwing safe. Blocking prerequisite: a
  capability self-check, because opencode's own `permission.ask` hook has been exported, typed and
  dead for ~19 months with no apiVersion and no error on unknown hook keys, which is exactly the
  failure that would leave the dashboard reporting healthy numbers from a channel that stopped
  arriving. Open lead: opencode's V2 plugin API (`packages/plugin/src/v2/`) may expose a queryable
  registration surface, which would upgrade the self-check from a behavioural canary to a handshake.
  Do NOT start before the current-state audit of native sessions across Claude Code / Codex / Cursor
  is settled.

- **ORM false positives: the remaining class (#87 partially fixed in #92).** The `ent.` boundary,
  the substring path gate, and the route-registration collision all shipped. What survives, measured
  across 11 repos: 10 of 13 remaining ORM-naming findings come from the two *other* ORM regexes in
  `src/codedna/pattern-classifier.ts`. `/\.Where\(/i` fires on numpy's `np.where(` (seen at
  `vibe-drift-api api/models/anomaly.py:61`) and `/\.create\(.*{/` fires on
  `stripe.customers.create({` (seen at `vibedrift-landing-page src/app/api/billing/portal/route.ts:68`).
  The other 3 are trpc files that genuinely use Prisma, so those labels are correct: do not count
  them as defects. Same shape of fix as the Ent one, a receiver or argument-shape discriminator
  rather than a bare verb, and it needs the same before/after on real repos. Also still open from
  #87: `routes.findOne(pattern)` in `architectural-contradiction.ts` passes an identifier rather
  than a route-path literal, so it is indistinguishable from `Model.findOne(id)` without receiver
  knowledge; pinned deliberately in the golden corpus with a comment.

- **[P0] `findSimilarToBody` has no query normalization and no token floor (#81 + #82 part 1).** One
  function, three surfaces (`find_similar_function` at 0.6, `validate_change` at 0.8, and the live
  session hook). (a) The index is body-only (`baseline.ts` over `fn.rawBody`) while the query
  tokenizes whatever the caller pasted, so a verbatim clone submitted with its declaration line
  deflates LCS: across all 1003 functions in `src` an exact self-clone scores under 0.8 56.8% of the
  time (median 0.784), and `validate_change` returns `ok:true, duplicateOf:[], confidence:high`. An
  affirmative false bless on the one question that tool exists to answer. (b) No floor on either
  side, so a 15-slot / 7-distinct-token predicate matches any other one-liner: `isPaidPlan` and
  `isNewInteractiveSource` score 1.00, and the session hook PUSHES "prefer importing it" into an
  agent's context unprompted. Fix all three surfaces index-side in one change: token floor ~25-30 on
  index entries (flooring only the query is insufficient, `lcsSimilarity`'s own minLen/maxLen >= 0.5
  guard lets a 30-token query reach 0.667 against a 15-token entry), a distinct-token gate, and score
  both raw and signature-stripped query keeping the max (monotone, cannot add a false positive). Do
  NOT re-index signature-inclusive tokens: changes the session redundancy path and invalidates every
  cached baseline. Also fix `test/unit/mcp/tools/find-similar-function.test.ts`, whose fixture builds
  index entries from signature-included strings and is structurally incapable of catching (a).

- **Unguarded reads of readdir-derived paths, five sites (#83).** `trial-recap.ts`,
  `watch-session.ts` (no stat and no size cap at all, foreground, no timeout), `upload-follower.ts`,
  `session/follow.ts`, and `core/history.ts` `loadLatestScan` all hand a readdir result straight to a
  read with no file-type check. A FIFO reports size 0, passes any byte-size gate, and blocks a sync
  syscall no in-process timer can preempt. NOT a locked-account problem despite how it was filed:
  `loadLatestScan` is on the ordinary previous-scan delta path. Fix: one shared guarded read helper
  (stat, reject non-regular, reject oversized, null on failure) plus an async sibling, preserving
  trial-recap's `complete:false` honesty semantics. Keep `statSync` rather than `readdirSync`
  `withFileTypes`, because a Dirent for a symlink to a real ledger reports `isSymbolicLink` not
  `isFile` and that rewrite would silently drop symlinked ledgers. Low urgency (needs a deliberately
  planted non-regular file in a 0o700 dir), cheap whenever someone is next in that area.

- **`duplicates` vs `semantic-duplication` have drifted into one detector with two extractors (#88).**
  `src/analyzers/duplicates.ts` carries a private regex requiring `)` immediately before `{`, so it
  cannot match a return-type annotation OR generics, while `semantic-duplication.ts` uses the shared
  extractor with byte-identical thresholds (0.7 flag, 15 min tokens, cross-file, 0.6 length ratio).
  Do NOT just swap the extractor in: measured on this repo that takes 31 pairs to 281, but the 281 is
  248 test/fixture pairs and 33 non-test, and all 33 non-test are ALREADY detected by
  semantic-duplication. Net: +220 scaffolding pairs, zero new real detections, composite unmoved
  (duplicates is hygiene kind). The real defect is that all 20 emitted locations on this repo are
  throwaway test helpers (`getUser`, `f`, `feature`) while the interesting ones (`escapeRegex` across
  2 files, `nameSegments` across 3) surface only under semantic-duplication. So this is a scoping
  decision: narrow `duplicates` to the test/fixture ground it uniquely covers, or retire it into the
  drift detector. Bump `duplicatesAnalyzer.version` either way so the S1 cache does not mask it.

- **`upload-state.ts` docstrings promise a guarantee the code does not provide (#85).** The module
  header says racing uploaders "can only ever move offsets forward" and `commit`'s docstring says "a
  racing slower uploader can never rewind a faster one". Both are false: the read-merge-write is not
  atomic as a whole and a racing writer drops the other's entry (reproduced across two independently
  spawned processes; 60/60 under `UV_THREADPOOL_SIZE=1`). The RACE is deliberate and fine, and
  `test/unit/session/upload-state.test.ts` says so outright ("we do NOT assert both survive the
  race") because offsets only move backward to a legitimately-held value, replays carry `activityId`,
  the server dedupes, and "duplicate" is committable so the watermark re-advances. Do NOT add a lock:
  a stranded lockfile from a SIGKILLed detached flush child wedges the hook, which is worse than the
  benign race. Fix the two docstrings only. Open design question: is watch-session running
  concurrently with the native Stop hooks a supported configuration?

- **Session re-check follow-ups from #94 (shipped: containment OR whole-file query).** The #86/#84
  false-resolve classes are fixed, but nothing binds the containment arm of the OR: delete it and
  every shipped test still passes, because #93's signature strip lets the query catch the
  whole-file wrap fixtures on its own. Needed regression test: a class-wrapped clone plus a few
  unrelated top-level functions in the re-check content (the strip cannot peel that shape and the
  query dilutes; only containment holds it open, measured 0.778 against the 0.6 threshold). Also
  scrub the "skhan's case" comment in `test/unit/session/outcome-anchors.test.ts` (cite #86
  instead). Correction to the earlier version of this bullet: "containment is one-sided safe" was
  refuted by execution during the #94 review — containment alone false-resolves all-identifier
  renames, tiny (single-window) anchors, capped-prefix damage, and repeated-line bodies; only the
  OR of containment with the query is one-sided safe.

- **Root fix: `extractAllFunctions` does not index class or object-literal methods.** The JS/TS
  patterns in `src/codedna/function-extractor.ts` match only `function name(` and
  `const name = (`, so a method inside `class Foo { bar() {} }` or `const foo = { bar() {} }` is
  invisible to every consumer of the extractor. The session re-check works around this with a
  token-sequence containment test on the finding anchor (`src/session/finding-anchor.ts`), which
  keeps a wrapped construct's finding open, but the underlying blindness is still there: a
  class-heavy file contributes far fewer indexed functions than it has. Widening the extractor is
  the proper fix and it is NOT a local change: the same function feeds Code DNA fingerprinting,
  op-sequence analysis, the duplicate index, and therefore the composite score for every user, so
  new methods would appear as new index entries and shift duplicate counts and scores across the
  board. Needs a corpus before/after on score movement, and probably a `SCORING_VERSION` bump,
  before it can ship.

- **`hasDataAccessPattern` / `classifyDataAccessLabel` hard-code language "typescript".** Both
  entry points in `src/drift/architectural-contradiction.ts` build a synthetic `DriftFile` with
  `language: "typescript"` for every path, including .py/.go/.rs. Inert today (the data-access
  detector reads only content and relative path, and the two lie identically so they stay
  symmetric), but `hasDataAccessPattern` now sits on the session re-check's resolution path, where
  a missed pattern reads as "the flagged code is gone". Thread the real `detectLanguage(path)`
  result through both, and add a non-TS case to the drift tests so the symmetry is pinned.

- **In-session drift covers only three dimensions.** `DIM_CHECKS`
  (`src/tools-core/tools/validate-change.ts:108-133`) has async_patterns, return_shape_consistency and
  architectural_consistency; plus `redundancy` (`src/session/check.ts`) and experimental `scope`
  (`src/session/scope.ts`). The scan has 13 `DriftCategory` values. Widening the in-loop set is higher
  leverage than any dashboard metric work, because it raises the ceiling on what a session can
  possibly report at all: with three dimensions live, the honest ceiling of the sessions dashboard is
  "here are the few things we noticed". Security and auth are notably unreachable in-session today, so
  any compliance-flavoured session metric is not just unbuilt, it has no signal to build on.

- **Native-sessions nudge: auto-detect headless (currently env-override only).** The SessionStart
  nudge suppresses asks/budget-burn in non-interactive contexts via an explicit
  `VIBEDRIFT_HOOK_NONINTERACTIVE=1` override (`src/session/nudge.ts`), which the N2 plugin/CI sets.
  Auto-detecting headless `claude -p` from the hook payload/env (e.g. `CLAUDE_CODE_ENTRYPOINT`) was
  deferred — the exact value needs one confirming payload capture (small metered `claude -p` run).
  Until then a raw `claude -p` outside the plugin can burn the 3-ask budget to an implicit decline;
  low harm (a headless-only repo has no human to nudge). Confirm the entrypoint value, then key
  `isNonInteractive()` off it too.

- **DOCX sections are still tag/kind-mixed for analyzer findings.** The per-file
  Drift/Static tally is now kind-based (matching terminal/HTML and the composite), but
  DOCX's "STATIC ANALYSIS FINDINGS" section lists drift-kind analyzer findings (naming,
  imports, ml-*) because they lack "drift" tags and DOCX has no analyzer-findings drift
  section to hold them. Within one DOCX a naming finding tallies Drift but lists under
  Static. Proper fix is structural (a dedicated analyzer-drift section), not a filter
  tweak — a kind-based filter alone would make those findings vanish from DOCX entirely.

- **One-time diff churn when the reimpl concentration gate fires post-upgrade.** Finding
  digests key on analyzerId, so the first scan after the gate-propagation fix reports the
  re-tagged findings as N resolved + N new (same finding, new id). Deep-scan-only, only
  repos where the gate fires, self-heals on the next scan. If it warrants suppression,
  fold into the next SCORING_VERSION bump so diffScans refuses the pair.

- **Rust auth recall gaps (all fail-safe — a miss, never a false-bless).** From
  the real-repo spot check: (1) a `MethodRouter::route_layer(...)` nested inside
  `arg1` of `.route(path, mr)` is invisible to the ancestor-layer coverage walk,
  so a genuinely-protected Axum route gets neither bless nor hedge; (2)
  parenthesized/macro-wrapped rejects (`return (Err(FORBIDDEN))`, `forbidden!()`)
  don't bless because `rustProducesReject` has no `parenthesized_expression` /
  `macro_invocation` case (symmetric across 401/403 — fix both at once); (3) an
  Actix `ErrorForbidden(..)` ctor isn't recognized for the guarded-403 lane.
- **Rust v1.1: in-file `FromRequest`/`FromRequestParts` impl bless.** Today an
  extractor-typed param resolves to `unsure`; reading the impl body to verify a
  reject would let it bless. Same idea for multi-statement middleware bodies
  (e.g. Echo `JWTWithConfig`, Go) and cross-function group wiring.
- **Cross-file resolution extensions.** Python absolute imports; multi-module Go
  (multiple `go.mod`). Current resolver is single-module / relative-import only.
- **Minor cross-language hedge asymmetry.** A Python hook with an opaque body and
  a NON-auth-flavored name resolves `unsure`; Go/Rust resolve the same shape
  `not-auth`. Both are safe (never a bless). Decide whether to align Python to
  `not-auth` for uniformity, or keep the more cautious hedge.
- **Optional: language-aware hedge noun.** The auth "double check" hedge now says
  a neutral "an auth hook (X)" for all languages (was the Flask-specific "a
  before_request hook"). A nicety would be language-specific nouns (Python
  "before_request hook / dependency", Go "middleware", Rust "extractor / layer"),
  which needs threading the finding's language into `hedgeRecommendationSuffix`
  and the terminal read-back regex in lockstep. Low priority.
- **No per-call logging in the MCP server (tool calls are invisible).** The stdio
  server (`src/mcp/server.ts`) only writes startup (`vibedrift-mcp running on
  stdio`), a one-time baseline-index line, and `Fatal:` to stderr — never a line
  per tool call. So there is no way to watch which in-loop tools fire, when, or
  with what outcome. Add an env-gated per-call stderr log (e.g.
  `VIBEDRIFT_MCP_LOG=1`): tool name, repo, and a one-word result
  (`fits` / `ok` / `no_baseline` / …). Because MCP clients capture server stderr
  into their logs (Claude Code: `mcp-logs-<server>/*.jsonl`; also streamed by
  `claude --debug`), this makes tool usage `tail -f`-able without touching the
  JSON-RPC channel on stdout. Parked.

- **No first-class "MCP is active / being used" signal.** After enabling the
  server a user cannot tell it is doing anything: the tools are pull-based (they
  fire only when the agent chooses to call them), `/mcp` shows "connected" but not
  "used", and the `indexing … for the first time` line fires once per repo per
  session, not per call. Consider a lightweight liveness/usage signal (pairs with
  the per-call log above) so "connected" is distinguishable from "actually
  invoked." Parked.

- **Terminal hedge detection is a prose-regex.** The terminal decides a security
  finding is hedged by testing its recommendation text with `/Double check/`
  (`src/output/terminal.ts`), which is brittle copy coupling: a wording change to
  the hedge sentence silently drops the hedge from the terminal. A dedicated
  finding-metadata flag (a boolean the renderers read instead of the prose) would
  be more robust. Parked.

- **Python hook body: `Depends`-target body DEMOTION.** The additive Depends
  same-file body path (`callsWithAuthDependency`, `security-ast-python.ts`) only
  ever ADDS a bless when a boring-named dependency's visible body raises a
  verified reject; it never DEMOTES a name-hit dependency whose visible body is
  plainly non-enforcing (the mirror of the `verify_user_email` fix on the hook
  path). Symmetry with the before_request path would close a residual name-only
  bless for Depends. Left additive-only for now (demotion could hide a real
  reject reached via a shape the scanner does not model).

- **`add_middleware` class-body analysis.** `app.add_middleware(X)` blesses on
  the CLASS NAME segments only (`MIDDLEWARE_AUTH_SEGMENTS`); it does not read the
  middleware class body (its `__call__`/`dispatch`) to confirm or deny auth. A
  body-first pass (as done for before_request hooks) would let a boring-named
  middleware whose dispatch 401s bless, and stop an auth-named one whose body is
  visibly non-enforcing. Out of scope for this addendum.

- **`@api_view(SOME_VAR)` same-file methods resolution.** Upgrade 2 resolves a
  Flask `methods=VAR` kwarg through a same-file literal (`collectMethodsVars` +
  `methodFromLiteral`), but `asApiViewDecorator` deliberately does NOT: an
  `@api_view(METHODS)` list behind a variable stays ALL even when METHODS has a
  same-file literal assignment. Flipping it is a two-line owner-gated change
  (reuse `methodFromLiteral` against the same census); scoped out because the
  approved Upgrade 2 names the `methods=` kwarg only.

- **Poison-census residual: `match`/`case` capture rebinding a `methods=` var.**
  `collectPoisonedMethodsNames` covers augmented/subscript/slice/pattern-unpack/
  `global`/walrus/for-target/`with-as`/mutating-call writes, but a `case`
  capture pattern that rebinds a module-level name used as `methods=VAR`
  (`match x:\n    case [*ALLOWED]:`) is not in the census. Astronomically rare
  (a match capture reusing a route's methods variable name) and only ever
  under-poisons toward a false GET-drop in that one shape; out of scope, safe to
  defer.

- **`context-md.ts` does not surface the auth hedge.** `buildContextMarkdown`
  renders only the neutral aggregate headline (`Auth middleware missing on N of
  M routes`), never the per-route deviator copy or the recommendation, so an
  UNSURE (hedged) route is not named in the committed `.vibedrift/context.md`.
  Safe today because context-md makes no confident per-route claim (see
  `test/unit/output/security-hedge-surfaces.test.ts`); a follow-up could add a
  short "N routes could not be confirmed (hooks: ...)" line so the AI-agent
  context file carries the same hedge the report surfaces do.

- **Security floor precision gate only covers `private-key`.** The calibration
  floor-precision gate (`test/calibration/precision-recall.ts`) exercises only the
  `private-key` floor rule, because `injectSecurityFloor` (`injectors.ts`) plants a
  private key into `src/handlers/*Handler.ts` and nothing else. The corpus does now
  carry Go/Python/Rust security fixtures, but those drive the AUTH vote, not the floor
  rules, so `go-tls-skip-verify`'s false-positive rate is still unmeasured (not just
  under-weighted). Extend the floor injector to plant a Go TLS skip-verify so the
  "floor precision >= 0.95" claim covers all five floor rules, not one. (The composite
  `calibrate:monotonic` non-responsiveness at low injection rates is pre-existing and
  tracked with the scoring-formula responsiveness work, not here.)

- **Security suppression: regex-fallback over-suppression on unterminated strings.**
  In `src/drift/security-suppression.ts`, the AST comment-node path is immune, but
  the textual regex fallback's `stripStringLiterals` only blanks CLOSED quote spans.
  An unterminated string containing `// @vibedrift-public` therefore survives and is
  read as a comment, dropping the route from the security denominator (over-suppression
  hides a route). Only reachable in a global no-parser degraded mode (tree-sitter WASM
  fails to init), so low risk. Two fixes: (1) correct the inverted safe-direction code
  comment at `security-suppression.ts:55-58` (it wrongly says under-strip is safe);
  (2) strip an unterminated quote to end-of-line before scanning for a comment marker,
  so the fallback fails to the safe under-match side. Never-over-suppress is the
  dominating invariant.

- **Mounted-router middleware resolution needs proper module resolution.** The
  Security Consistency detector should resolve `app.use('/api', apiRouter)`
  cross-file so a router-level guard propagates to the mounted routes. A
  basename-matching approach (resolving an import by its last path segment via
  the import graph) is unsafe for a security check: it is directory-blind, so a
  workspace-alias or partially-scanned import (`@shared/router`) plus a single
  generically-named file (`router.ts`) resolves uniquely to an unrelated file
  and silently attributes a guard to routes that are actually unauthed. Do it
  with real relative-path resolution: resolve a relative specifier against the
  importing file's directory to an exact path, refuse bare/aliased specifiers,
  and attribute a guard only on a single exact-path match. Security-critical (a
  false attribution is a missed vulnerability) — design deliberately.

- **Security calibration: exercise the primary dominance vote.** The `security`
  calibration injector strips auth at the shared `INJECT_RATE` (0.34), which puts
  the authed ratio below the 0.75 dominance-vote gate, so calibration only
  measures the uniform-auth-gap fallback. Add a per-injector rate (strip ~1/8) so
  a group lands just above 0.75 with one deviator, calibrating the primary path
  the AST upgrade centers on. (The dominance vote is already unit-tested; this is
  the precision/recall measurement of it.)

- **scan-over-scan diff still tracks the RAW drift representation**: `result.diff`
  / the persisted history digests read `driftResult.driftFindings` (raw), so a
  below-floor route-consistency security finding participates in the drift diff.
  If such a finding is newly introduced between two same-version scans, the
  terminal diff banner (`renderDiffBanner` top-new-drift) could momentarily call
  it a "new drift finding" even though the report body renders it as advisory.
  The same raw-digest diff source also feeds `## Recent trajectory` in
  `src/output/context-md.ts`, so `--write-context` could commit that raw finding
  text into the committed `.vibedrift/context.md` in the same scenario (a more
  durable surface than the ephemeral terminal line).
  This is deliberate for now: the baseline (`assembleBaseline`) and diff track
  the raw representation for continuity. (The CROSS-VERSION case is FIXED as of
  2026-07-16: `diffScans` now takes the current scan's `scoringVersion` and
  refuses comparison when the pair spans versions — `versionMismatch: true`
  zeroes deltas, empties the resolved set, and both the terminal banner and the
  committed `context.md` trajectory stay silent, `--since` included. What
  remains here is the SAME-VERSION raw-vs-rendered concern only.) If we
  want the diff to match the rendered (scored) view, feed `scoredDriftView(...).driftFindings` to
  both the diff digest (buildScanResult) and `saveScanResult` together (keep the
  two sources identical or a spurious per-scan diff reappears).
  Same root cause covers the suppression-audit finding (subCategory
  `SECURITY_SUPPRESSION_SUBCATEGORY`, `security-suppression.ts`): the diff
  digest also reads raw `driftFindings`, so adding or removing a
  `@vibedrift-public` annotation or allowlist entry can show up as a "new" or
  "resolved" drift finding in the diff banner and get committed into
  `.vibedrift/context.md`. The same fix (feed the diff digest source from
  `scoredDriftView(...).driftFindings`) would exclude it too.
