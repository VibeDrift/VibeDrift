# The Local/Cloud Boundary

VibeDrift makes network calls by default. This chapter is the precise inventory: every endpoint the CLI can talk to, exactly what crosses the wire in each case, when it fires, and how to turn each of them off. The posture throughout the codebase is honest disclosure rather than a blanket "we never phone home" claim, because the latter would be false: there is an anonymous usage beacon and a daily update check, both on by default, both documented to the user on first run, and both switchable off.

## What never leaves the machine

Regardless of plan or sign-in state, the following stay local, always:

- **Full source files.** No code path uploads a whole file. The deep scan sends bounded function snippets (detailed below); everything else sends metadata or nothing.
- **Absolute paths.** Payloads carry paths relative to the scan root; the scan root itself is represented only as a SHA-256 hash. The sanitizer that prepares scan uploads (`src/ml-client/sanitize-result.ts`) strips `context.rootDir` and rewrites any absolute path relative.
- **Embedding vectors.** `/v1/embed` returns vectors that are persisted only locally, in `~/.vibedrift/embedding-index/` (directory mode 0700). The client documentation in `src/core/embedding-index.ts` states it directly: your code's vectors never sit on the server.
- **The baseline, scan history, and findings cache**, all under `~/.vibedrift/`, keyed by path hash.
- **Everything, when you ask for it.** `--local-only` gates all network calls. The comment in `src/cli/commands/scan.ts` enumerates what that covers: the auth banner, deep analysis, the scan log, fix-prompt synthesis, and the anonymous beacon. Zero egress.

Nothing scan-related is written inside the user's project except the opt-in `.vibedrift/` files, `.vibedriftignore`, and the managed block the opt-in `--inject-context` flag writes into `CLAUDE.md` (or the target file you name).

## Device auth flow

Signing in uses an OAuth-style device flow against the API (default `https://vibedrift-api.fly.dev`, overridable by flag, `VIBEDRIFT_API_URL`, or config). Implemented in `src/auth/api.ts`:

1. `POST /auth/device` with body `{client_id: "vibedrift-cli"}`. The response carries `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, and `interval`.
2. The CLI opens the verification URL in a browser (refusing in CI and non-TTY environments, honoring `$BROWSER` and `VIBEDRIFT_NO_BROWSER=1`) while polling `POST /auth/poll` with `{device_code}` until the response is `authorized` (carrying `access_token`, `email`, `plan`, `expires_at`), `denied`, or `expired`.
3. The token lands in `~/.vibedrift/config.json` with file mode 0600 in a 0700 directory, and the mode is re-asserted on every write (`src/auth/config.ts`), so a shared machine's other users cannot read it.

Token resolution priority is explicit flag, then the `VIBEDRIFT_TOKEN` environment variable, then the config file. `GET /auth/validate` checks a token, `POST /auth/revoke` is logout. When the CLI displays a token it shows only the first 12 characters.

## Deep scan wire format

A deep scan (`--deep`) POSTs one `MlAnalyzeRequest` to `/v1/analyze` (`src/ml-client/client.ts`, 90-second timeout to absorb model cold starts). What is actually in it, per `runMlAnalysis` in `src/ml-client/index.ts`:

- **At most 30 function snippets, each truncated to 60 lines.** `sampleFunctionsForMl` (`src/ml-client/sampler.ts`) scores every extracted function and takes the top 30: members of the ambiguous similarity band get +100 (guaranteeing the pairs the cloud judge exists to resolve survive the cap), entry-point files +10, +3 per existing finding on the file, up to +5 by size, +3 for handler/service paths. Bodies beyond 60 lines are cut with a truncation marker. Each payload carries `{id, name, file, body, line_start, line_end, language}` where `file` is the relative path.
- **At most 20 deviation payloads**, built from Code DNA deviation justifications and architectural drift findings, each with the pattern mapped into the API's trained deviation types and its snippet capped at 200 characters.
- **Project identity, hashed.** `project_hash` is the SHA-256 of the absolute root directory, computed client-side so the server never sees the path itself (`src/ml-client/project-name.ts`). `project_name` is a human label autodetected from package.json, Cargo.toml, go.mod, or pyproject.toml, falling back to the directory basename; `--project-name` overrides it and `--private` replaces it with an anonymized `priv<hash>` label.
- **Metadata**: language, file count, optional local score and grade hints so the dashboard can render history without re-scoring, and `defer_persist`. The schema also defines an optional `source` field, sent as `"mcp"` by the in-loop deep check; a full `--deep` scan omits it (only the embedding endpoint tags requests `"cli"`).

The verbose log states the boundary in one line: no full files transmitted, only function snippets and structural metadata. The in-loop MCP deep path is bounded even tighter: the candidate feeder caps at 29 candidates plus the query, and the embedding-index path sends at most 8 borderline candidates for LLM confirmation.

## /v1/embed keeps vectors local

The embedding endpoint receives, per function, only `{id, body, language}` plus a `source` tag, chunked 48 functions per request (`src/ml-client/embed-client.ts`). The client-side contract documented in the code: the server computes embeddings transiently and stores nothing; the returned vectors are written to the local index under `~/.vibedrift/embedding-index/<hash>.json` and invalidated by baseline-key mismatch. Bodies sent for embedding are truncated to the same 60 lines the deep scan uses.

## Authenticated scan logging and report upload

When signed in (and not `--local-only`), every scan is logged to `POST /v1/scans/log` after the local pipeline finishes, silently skipping on any failure. The payload contains metadata counts, optionally the rendered HTML report (dropped entirely if over 1.5MB), and `result_json`: the sanitized `ScanResult` described above (root dir stripped, paths relativized, raw file contents and AST nodes dropped, the files list reduced to `{relativePath, lineCount, language}`, per-file scores summarized to histograms). Oversized payloads are progressively trimmed toward a 9MB target by dropping the heaviest sections first (Code DNA functions, then location snippets, then capped deviating-file lists, and so on), and the upload is aborted outright above 24MB.

Two paid synthesis endpoints exist at the interface level: `POST /v1/fix-prompts` (sends up to 10 findings, each with the deviating snippet and up to 3 reference snippets of at most 60 lines) and `POST /v1/coherence` (sends drift findings, dominant patterns, and confirmed deep findings for the deep-scan report). Both fail soft. `PUT /v1/scans/{id}/report` uploads the rendered HTML (at most 1MB) for dashboard display.

## The telemetry beacon

`src/telemetry/beacon.ts` sends one anonymous POST to `/v1/beacon/scan` after every scan, signed in or not, fire-and-forget with a 3-second timeout; all failures are silently ignored. The payload is exactly these 11 fields, defined in `ScanBeaconPayload`:

| Field | Content |
|---|---|
| `language` | dominant language string, or null |
| `file_count` | number of files scanned |
| `loc` | total lines scanned |
| `scan_time_ms` | scan duration |
| `cli_version` | CLI version string |
| `is_deep` | whether `--deep` was requested |
| `has_git` | whether git metadata was available |
| `has_intent_hints` | whether any CLAUDE.md/AGENTS.md hints were parsed |
| `finding_count` | number of findings |
| `score` | composite score |
| `authed` | whether a token was present, as a derived boolean only |

No code, no file paths, no identifiers, no user id, no token. The `authed` docstring is explicit that the boolean carries no token and no identifier, so the event stays anonymous; it exists so the dashboard can split signed-in from signed-out usage.

There are three ways to turn it off (`isTelemetryEnabled`):

1. `vibedrift telemetry disable`, which persists `telemetryEnabled: false` in `~/.vibedrift/config.json`.
2. The `VIBEDRIFT_TELEMETRY_DISABLED` environment variable, any non-empty value.
3. `--local-only`, which as noted gates every network call, the beacon included.

The same toggle also governs the once-daily npm update check, so disabling telemetry disables both.

> [!NOTE]
> The beacon is disclosed, not hidden. On the first scan, a notice prints to stderr (skipped under `--local-only` and `--json`) stating that VibeDrift sends an anonymous usage beacon after each scan, listing the field categories, noting the daily npm update check, naming all three opt-outs, and linking https://vibedrift.ai/privacy. The acknowledgment is persisted so the notice shows once.

A second, narrower beacon exists for report analytics: the HTML report generated for a logged-in scan embeds a script that POSTs `{scan_id, opened_at}` to `/v1/beacon/report-open` once on load. It only exists when the report carries a `scan_id`, meaning logged-in scans; a report from an anonymous scan embeds nothing.

## Endpoint summary

| Endpoint | When | Carries | Off switch |
|---|---|---|---|
| `POST /v1/beacon/scan` | after every scan | the 11 anonymous fields above | telemetry disable, env var, `--local-only` |
| npm registry (update check) | at most daily | standard npm metadata request | same toggle as the beacon |
| `POST /auth/device`, `/auth/poll`, `GET /auth/validate`, `POST /auth/revoke` | explicit sign-in/out | client id, device code, token | do not sign in |
| `POST /v1/analyze` | `--deep`, or MCP deep checks | ≤30 function snippets x 60 lines, ≤20 deviations, hashed project identity, metadata | do not use deep features; `--local-only` |
| `POST /v1/embed` | building/querying the local embedding index | `{id, body, language}` per function, 48 per chunk | same |
| `POST /v1/scans/log`, `PUT /v1/scans/{id}/report` | authenticated scans | sanitized result, optional HTML report | sign out or `--local-only` |
| `POST /v1/fix-prompts`, `/v1/coherence` | paid synthesis features | finding snippets, dominant patterns | do not enable those features; `--local-only` |
| `POST /v1/beacon/report-open` | opening a logged-in scan's HTML report | `{scan_id, opened_at}` | reports from anonymous scans embed nothing |

Server-side behavior (what the API stores, billing enforcement) is implemented in the separate API service and is outside this repo; the claims in this chapter are scoped to what the client sends and expects, which is fully auditable in the paths cited above.
