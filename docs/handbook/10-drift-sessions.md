# Drift Sessions: VibeDrift Inside the Coding Loop

A batch scan reports drift after the code exists. The MCP server (chapter 9) moves the same checks earlier, to the moment an agent *asks* a conformance question before writing. Drift Sessions moves them earlier still, to the moment the agent *acts*, without waiting to be asked. It rides inside a Claude Code coding session through the agent's own hooks, watches prompts and edits as they stream by, flags an edit that diverges from the repo's dominant patterns while the agent is still on the task, feeds a one-line advisory back into the agent's context, and records the whole session to a local append-only ledger. Optionally, and only when you opt in, it uploads a derived projection of that ledger to a hosted dashboard.

The whole surface is built local-first and fail-open. Nothing leaves the machine unless you turn on sync, and a hook that errors, times out, or sees a shape it does not understand exits cleanly and never interrupts your agent. This chapter walks the command, the four hooks, the ledger, the live tape, the advisories, the experimental intent tier, the outcome model, and the local/cloud boundary, all grounded in `src/session/`.

> [!NOTE]
> Drift Sessions is labeled **preview**. The command prints that label, the intent tier is marked experimental in the code and on the tape, and the drift gauge ships with weights annotated as initial calibration. Treat the signal as advisory.

## `watch-session` and the four Claude Code hooks

One command drives the feature:

```
vibedrift watch-session [path]
```

The path argument defaults to `.`. Run with no flags, it makes sure the hooks are installed for this repo (asking consent first), then follows the live event tape until you press Ctrl-C. The flags select the other modes:

| Flag | Effect |
|---|---|
| `--status` | Report whether the hooks are installed for this repo, and print the ledger location |
| `--uninstall` | Remove the hooks this command installed |
| `--yes` | Skip the consent prompt |
| `--no-watch` | Install the hooks only, do not follow the live tape |
| `--sync <on\|off>` | Hosted sync (Pro): `on` opts into derived-only upload, `off` disables it |
| `--local-only` | Force hosted sync off for this run, regardless of the saved setting |

Installation writes four marker-tagged hook entries into the project's `.claude/settings.local.json`, the project-local settings file that is conventionally left uncommitted (`src/session/install.ts`). The four events, and the tools each one listens to, are fixed:

| Hook event | Fires when | Matcher |
|---|---|---|
| `SessionStart` | a Claude Code session begins | (all) |
| `UserPromptSubmit` | you submit a prompt | (all) |
| `PostToolUse` | the agent finishes a file-editing tool | `Edit\|Write\|MultiEdit` |
| `Stop` | the session ends | (all) |

Each entry is the absolute command `node <dist>/session/hook-entry.js` with a trailing `#vibedrift-hook` shell comment. That comment does double duty as the idempotency and removal marker: install refuses to add a second copy of an entry that is already present, and uninstall finds our entries by that marker and nothing else.

The installer is deliberately conservative about a file it does not own. It refuses to touch `settings.local.json` at all when it cannot parse the JSON (it returns an `aborted_unparseable` status rather than risk clobbering a hand-edited file), and before it writes it snapshots the pre-install bytes. On `--uninstall`, if you have not edited the settings since install, it restores those exact bytes, and if it created the file and nothing else was added, it removes the file. If you *have* edited the settings, it falls back to surgically stripping only the marked entries and leaves your edits in place. Either way the recorded ledgers are never touched: they remain yours.

## Consent, fail-open, and local-first

The first time you install for a repo, `watch-session` prints exactly what it will do and asks you to confirm (unless you passed `--yes`). The consent copy states the contract plainly: the hooks record your prompts (with secrets masked) and edit metadata to a local ledger, send one-line advisory notes into the agent when an edit diverges from the repo's own dominant patterns, never read the agent's transcript file, and fail open so that a hook error or timeout never interrupts your agent. It also names the uninstall command. Consent gates *installing* the hooks; once installed, following an existing session's tape does not re-prompt.

Fail-open is enforced in the hook entrypoint itself (`src/session/hook-entry.ts`). Before it imports any of its working modules it arms a self-timeout, and its contract is to exit `0` in every circumstance except one: malformed input, an unknown event, a missing baseline, an internal error, or a timeout all exit `0`. The single exception is a live advisory on an edit, described below, which exits `2` so that the note reaches the agent. The entry avoids the heavier CLI machinery and imports only Node built-ins statically, so the fail-open guard is in place before any real work begins.

## The local append-only ledger

Every session is recorded to one JSONL file:

```
~/.vibedrift/sessions/<projectHash>/<sessionId>.jsonl
```

The project hash keys the directory (the raw project path never appears in it), and the session id, which comes from the hook payload, is confined to a single safe path segment so an untrusted id can never escape the sessions directory (`src/session/ledger.ts`). The file is written one event per line with a single append per event, the directory is created mode `0700` and the file mode `0600`, and readers tolerate a corrupt line so an interrupted write can never take the reader or the tape down.

Each line is one `SessionEvent` (`src/session/types.ts`). The event types cover the whole dialogue: `session_start` and `session_end`, `user_prompt`, `intent_lock`, `edit`, `flag`, the paired `mcp_ask` and `mcp_verdict`, `decision`, and the outcome events `recheck` and `resolve` (a `hold` type is also defined, reserved for a future blocking mode that the passive-only preview never emits). The ledger is strictly append-only: an outcome is recorded by appending a `resolve` or `recheck` line, never by rewriting an earlier one. A hard per-line byte cap keeps a pathological prompt from bloating the file, and when a line would exceed it the prompt text is progressively trimmed and marked truncated while the rest of the event is preserved.

What is recorded is metadata and masked text, never code. An edit event carries the repo-relative file path and a diffstat, not the diff. A prompt event carries the prompt text after secret masking. One privacy detail is worth calling out: when an edit lands *outside* the repo, the hook records only the file's basename, never a machine path, and skips the inline check, because a file outside the repo is not in this repo's baseline (`src/session/hook-entry.ts`).

### Secret masking

Prompt text is masked before every ledger write by a dedicated prompt-text masker (`src/session/mask.ts`). Its design bias is stated in the code: it is tuned for high-confidence secret shapes and deliberately leaves short or ambiguous values alone, because over-masking ordinary prose would degrade the tape more than it protects. It replaces three families of value:

- **Known credential shapes**, wholesale: PEM private key blocks, AWS access key ids, provider API keys in the `sk-` / `pk-` / `rk-` families, `Bearer` tokens, GitHub tokens, JWTs, Slack tokens, Google API keys, and granular npm tokens.
- **Connection-string passwords.** In a `postgres://user:PASS@host` style URL it masks only the password and preserves the scheme and user, so the trace stays useful without leaking the secret.
- **Keyed values.** A `key = value` or `key: value` whose identifier ends in `password`, `secret`, `token`, `api_key`, or `access_key` (including a `SNAKE_CASE` prefix like `OPENAI_API_KEY`) has its value masked while the key is preserved.

> [!IMPORTANT]
> Recorded local ledgers always remain yours, including for a free or locked account. Uninstalling the hooks does not delete them, and nothing in the local ledger is uploaded unless you explicitly turn on hosted sync.

## The live event tape

By default `watch-session` follows the active session in real time. Each new ledger event is rendered as a single tape line by a pure formatter (`src/session/tape.ts`), and a one-line status footer is repainted below the stream with a running event count, the flagged and open counts, and the drift gauge. When the session ends, a summary block is printed (`src/session/live.ts`, `src/session/summary.ts`). Every line is stamped with a wall-clock `HH:MM:SS` time that matches the dashboard's decision-log timestamps.

The tape's vocabulary is observational: prompts show as `USER`, the agent's edits as `AGENT`, VibeDrift's own flags and outcomes as `VIBEDRIFT`. When the VibeDrift MCP server is also enabled, the agent's tool calls join the same tape: an `mcp_ask` renders as an `[ASKS]` row and the tool's verdict as a `[REPLIES]` row, correlated into the most-recently-active session for the repo (`src/session/mcp-tee.ts`), so the agent asking VibeDrift and VibeDrift flagging the agent read as one dialogue. An illustrative slice:

```
10:02:14  SESSION    capture started
10:02:20  USER       add an order lookup helper to the order service
10:02:20  INTENT     contract locked · add an order lookup helper to the order service
10:02:41  AGENT      edits src/services/order-service.ts +18
10:02:41  VIBEDRIFT  [FLAGGED] DF-1 [PASSIVE] async_patterns: repo uses async/await, this uses .then() chains
10:02:52  AGENT      [ASKS] validate order-service.ts
10:02:52  VIBEDRIFT  [REPLIES] 1 drift
10:02:55  AGENT      [ACCEPT] DF-1 will switch to async/await
10:03:10  AGENT      edits src/services/order-service.ts +16
10:03:10  VIBEDRIFT  [RESOLVED] DF-1 src/services/order-service.ts

session summary  2 edits · 1 flagged · 1 resolved · 0 open · agent said: 1 accepted · 1/1 task files touched
```

The footer that rides under the stream reads like this, repainted on every batch:

```
⟳ watching · 9 events · 1 flagged · 0 open · ● drift 0.07 · Ctrl-C to stop
```

If you would rather wire the hooks now and watch later, `--no-watch` installs without following. A later `vibedrift watch-session` in the same repo picks up and tails the next session.

## Advisories use the same classifiers as the batch scan and MCP

When a `PostToolUse` edit lands inside the repo, the hook runs the inline drift check (`src/session/check.ts`). This is not separate logic. The check calls `validateChangeAgainstBaseline` from `tools-core` (`src/session/detect.ts`), the same pure projection the MCP `validate_change` tool runs, and for each dimension it judges it reuses the very classifier that dimension's batch detector uses (`classifyAsyncStyle`, `classifyReturnShapeLabel`, `classifyDataAccessLabel`). Because the in-loop classification of a given dimension goes through that shared classifier, it can never disagree with that detector on how the change is labeled. The check is deliberately narrower than a full scan, though: it covers only those few single-body dimensions plus the duplicate check, judges them against a frozen baseline vote, and hedges to low confidence when that vote is thin, so it is not a stand-in for everything a `vibedrift scan` reports across every dimension. A convention conflict becomes a `flag` event with the dimension, the repo's dominant pattern, and the pattern the edit used; a near-duplicate becomes a `redundancy` flag naming the function it duplicates and the similarity.

When there is an un-cooled advisory to deliver, the hook prints one line to stderr and exits `2`. That exit code is deliberate: a `PostToolUse` hook that exits `2` feeds its stderr into the agent's context without blocking the tool, so the note reaches the agent as an FYI while the edit still lands. Two throttles keep the channel quiet. A per-message cooldown suppresses re-messaging the same file-and-dimension advisory within a window, and an already-open finding is deduped so a flag whose file and category are already open is not re-appended or re-messaged (`src/session/hook-entry.ts`). The inline check is also size-gated: it runs against baselines at or under a fixed index size, and a larger repo records the edit but stays quiet on the inline path.

## The experimental intent tier and the drift gauge

Alongside the convention and redundancy checks, Drift Sessions runs an experimental, deterministic intent tier that computes entirely locally and adds no metered cost (`src/session/scope.ts`, `src/session/intent-state.ts`). It reads the task from your prompt, extracting the files, symbols, and tokens you named, and locks that as the session's intent on the first prompt that actually says something. A follow-up prompt that names more files expands the locked intent. When a later edit relates to none of the task's anchors, the tier can flag it as scope drift, but it is conservative by construction: it flags only the second-and-later unrelated edit, and each file at most once, so a genuinely new one-file subtask never trips it. Scope flags are marked experimental, are shown on the tape with an `[EXPERIMENTAL]` tag, and are counted apart from the confirmed-flag headline in the summary.

A smoothed drift gauge rides the tape footer (`src/session/gauge.ts`). It combines the three per-edit signals, scope, convention, and redundancy, over a sliding window using the same noisy-OR family as the v11 scoring engine, so no single signal dominates, and it applies zone hysteresis so a value hovering on a green/yellow/red boundary does not flap. Its weights and boundaries ship labeled initial calibration and are expected to move once there are real opt-in ledgers to calibrate against.

At session end, the summary reports intent coverage when the task named any files: how many of the task's target files actually got an edit, out of the total (`src/session/summary.ts`). The summary is careful with its language, counting "edits" rather than "edits checked" because an edit outside the repo or above the inline size gate is recorded but not drift-checked.

> [!NOTE]
> The intent tier is experimental, and the gauge ships with initial-calibration weights and boundaries. Scope drift is a hint to verify a change belongs, not a verdict.

## Real outcomes

Drift Sessions distinguishes what actually happened from what the agent said it would do. A flagged finding resolves only when its own signal is genuinely gone. After an edit, the hook re-runs the drift detection over the file's *current full content* read from disk, not the edit hunk, and resolves a finding only when that same re-check no longer produces it (`src/session/hook-entry.ts`, `src/session/outcomes.ts`). A finding never resolves because some unrelated file changed. The re-check queries the whole body plus each extracted function body for exactly this reason: a single whole-body query can dilute a duplicate below threshold or misclassify a mixed body, which would let a still-present finding falsely read as resolved (`src/session/detect.ts`).

Two smaller behaviors round out the outcome model. A repeat flag on an already-open finding is deduped rather than re-raised, and a best-effort byte-exact revert (the file restored to an earlier state seen this session) is noted as a subtle `recheck`, kept out of the resolution rate because it is not a fix. When a repo has no baseline yet, `watch-session` hints that convention and duplicate checks need one built by `vibedrift scan`, while noting that scope drift still works without a baseline.

## Decisions: `respond_to_flag`, the seventh MCP tool

The MCP server now registers seven tools (chapter 9 covered the first six): `init`, `get_intent_hints`, `get_dominant_pattern`, `check_file_drift`, `find_similar_function`, `validate_change`, and `respond_to_flag` (`src/mcp/server.ts`). The seventh, `respond_to_flag`, closes the loop back into the session ledger. When a hook advisory flags one of the agent's changes (the message carries a `DF-<n>` id), the agent can record its own call on that flag: `accept` (agree and will fix), `park` (defer to a human reviewer), or `decline` (judge the flag wrong or unnecessary here), each with a one-line reason. The tool is local and free: it writes a `decision` event to the session ledger and sends zero bytes over the network (`src/mcp/tools/respond-to-flag.ts`, `src/session/decision.ts`). The reason is secret-masked and capped before it is written.

A decision is orthogonal to an outcome, and the code refuses to conflate them. Accepting `DF-3` is a stated intent, not a verified resolution: it does not mark `DF-3` resolved. Only the finding-scoped re-check does that. The summary reflects this by counting decisions on a separate axis and prefixing them "agent said:" so a reader can never mistake "accepted" for "fixed" (`src/session/summary.ts`). The adapter is fail-open in a specific way: it always returns status `ok` with a `recorded` boolean, so a decision it could not correlate to an active session comes back as a soft "not recorded" the agent can act on, never a thrown tool error.

## The local/cloud boundary

Nothing about Drift Sessions leaves the machine unless you run `vibedrift watch-session --sync on`. The ledger, the tape, the advisories, and the outcome model all work fully offline, and `--local-only` forces sync off for a run even when it is enabled in config. This is the same honest-disclosure posture as the rest of the CLI (chapter 12), narrowed to sessions.

When sync is on, what uploads is a derived projection, never the raw ledger. The upload schema enforces this by construction (`src/session/upload-schema.ts`): `toUploadEvent` builds a fresh event from an explicit allow-list of fields and never spreads the ledger event, so a field that is not named in the allow-list has no landing spot and cannot leak. What that allow-list permits is findings, scores, outcomes, decisions, and metadata:

| Leaves the machine (derived) | Never leaves the machine |
|---|---|
| Finding ids, categories, and pattern **labels** (for example `async/await` versus `.then() chains`) | Prompt text |
| Scores, similarity numbers, outcomes (resolved / open / held), decision (accept / park / decline) | Source code, function bodies, and diffs |
| The `+N` added-line count of an edit | The advisory message text delivered to the agent |
| A salted per-repo hash of each file path | The raw file path |
| The count of task target files | The task's file paths |

File paths cross the wire only as a salted hash: the SHA-256 of the project hash and the relative path (NUL-separated), truncated to sixteen hex characters. The code is honest about what that is. It is a per-repo grouping pseudonym, so the same file groups together within one project, while salting by the repo hash defeats a global path lookup table that an unsalted path hash would be vulnerable to. Pattern labels are a bounded detector vocabulary and are additionally secret-masked as defense in depth. The MCP `ASKS` row (whose text can carry a path) uploads its ids and type only, and the `REPLIES` row uploads a bounded derived verdict label.

Two free-text fields are the exception, and they ship only under an explicit team opt-in: the decision `reason` and a derived intent `taskLabel`. Both are secret-masked and capped even then, and the schema notes the honest caveat that opt-in relaxes the path guarantee for these two fields, since an agent's own reasoning text might reference a path. With opt-in off, the default, conclusions leave and analysis stays local.

The upload itself runs off the hook's critical path. A resident reader tails the ledger, maps each new event to its derived projection, batches them, and posts them (`src/session/uploader.ts`). It is fail-open in the strong sense: a failed flush never throws and never loses the batch (the events are retried on the next tick, under a hard buffer cap), and when sync is off, `--local-only`, or you are logged out, the uploader is simply never started, so local behavior is byte-identical. The projections land on the hosted dashboard at [vibedrift.ai/dashboard/sessions](https://vibedrift.ai/dashboard/sessions), which shows you your own session data.

## Entitlement

Drift Sessions is a **Pro** feature with a **5-session free trial**. A free account gets its first five sessions full-featured; after the trial the live tape locks behind a summary of what the trial caught on this repo, with an upgrade CTA. The recorded local ledgers remain yours regardless. Pricing is unchanged across the product: Free $0, Pro $15 per month, Enterprise custom.