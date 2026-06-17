<div align="center">

<img src="assets/vibedrift-logo.png" alt="VibeDrift" width="120" height="120" />

# VibeDrift

**Ship agentic. Stay coherent.**

[![Website](https://img.shields.io/badge/vibedrift.ai-f0c000?style=flat&labelColor=1a1a1a)](https://vibedrift.ai) [![npm](https://img.shields.io/npm/v/@vibedrift/cli.svg?color=f0c000)](https://www.npmjs.com/package/@vibedrift/cli) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

Your AI coding agent doesn't remember what it built yesterday. VibeDrift scans your project for the contradictions, hidden duplicates, and security gaps that creep in when AI writes code across multiple sessions, and gives you a single score with concrete file-level evidence.

VibeDrift is open source (MIT) and runs entirely on your machine. The core CLI, every local analyzer, and the MCP server need no account, and your code never leaves your machine. VibeDrift does send a small anonymous usage beacon after each scan (language, file count, lines of code, scan time, CLI version, finding count, and score; no code, no file paths, no identifiers), on by default for everyone whether signed in or not. Turn it off with `vibedrift telemetry disable` (or set `VIBEDRIFT_TELEMETRY_DISABLED=1`), or run `--local-only` for a fully offline scan. An optional hosted deep-scan service adds AI-powered analysis on top.

> **🆕 Use VibeDrift inside your AI coding agent.** The [MCP server](#mcp-server) lets Claude Code / Cursor check drift *while it writes code*, so new code matches your repo's conventions the first time. Drift **prevention**, not just detection. Free, local, your code never leaves your machine. [Set it up ↓](#mcp-server)

---

## Quick Start

```bash
npx @vibedrift/cli
```

That's it. No install, no signup, no config. Produces an interactive HTML report and opens it in your browser.

## Supported Languages

**JavaScript · TypeScript · Python · Go · Rust**

## What It Finds

- **Architectural inconsistencies** — half your handlers use a repository, the other half hit raw SQL
- **Hidden duplicates** — two functions doing the same thing under different names
- **Security gaps** — hardcoded secrets, injection risks, unsanitized input reaching sensitive calls
- **Dead code** — orphan files never imported, exports never used, unreachable paths
- **Complexity hotspots** — functions so deeply nested they've become unmaintainable
- **Convention drift** — naming, imports, error handling, logging — any pattern that's inconsistent across the codebase
- **Implementation gaps** — functions that return placeholder strings like `"unvalidated"` or `"not implemented"`, `raise NotImplementedError`, `panic("not implemented")`, `unimplemented!()`. Catches half-finished code that slipped into production

VibeDrift learns the dominant patterns in your code and flags the deviators. A file isn't wrong because it uses raw SQL — it's *drifting* because 8 of its 10 siblings use a repository and 2 don't.

## Example Output

```
╭─────────────────────╮
│  VibeDrift          │
╰─────────────────────╯

Scanning: /path/to/my-project
Files: 9 (TS: 9) | Lines: 262 | Time: 0.0s

  📘 Declared conventions (from CLAUDE.md)
     repository pattern · named exports · async/await

  📈 Since last scan (2h ago)
     ✓ Resolved: 3 drift findings
     ✗ New: 1 drift finding
     ▲ Vibe Drift Score: +2.3

── Vibe Drift Score ────────────────────────────────
  Architectural Consistency    12/20  ████████████░░░░░░░░
  Redundancy                    8/20  ████████░░░░░░░░░░░░
  Dependency Health              N/A
  Security Posture             18/20  ██████████████████░░
  Intent Clarity               16/20  ████████████████░░░░
  ──────────────────────────────────
  Vibe Drift Score:            68/100
  Hygiene Score:               82/100

  Vibe Drift Score — how consistent your code is with its own dominant patterns.
  Hygiene Score — generic quality checks (complexity, dead code, TODOs, …). Independent of drift.

── Fix Plan ──────────────────────────────────────
  1. Pattern drift: src/handlers/order.ts uses raw SQL while 7/8 files use repository
     src/handlers/order.ts:15  +0.8pts consistency
  2. 3 pair(s) of near-duplicate functions detected
     src/handlers/payment.ts:9  +0.6pts consistency
```

The default run produces the interactive HTML report and serves it locally so you can click through every finding with line-level evidence.

## Scoring (drift-only composite, out of 100)

VibeDrift reports **two independent scores**:

**Vibe Drift Score** — how consistent your code is with its own dominant patterns, **out of 100**. (Internally it's 4 applicable categories × 20 = 80 raw points, normalized to /100 at the headline.) Grades: **A** ≥ 90% · **B** ≥ 75% · **C** ≥ 50% · **D** ≥ 25% · **F** < 25%.

**Hygiene Score** — generic code findings (complexity, dead code, TODOs, outdated dependencies, empty catches, generic OWASP regex, language idioms). Out of 100. **Does not affect** the Vibe Drift Score.

The split is deliberate: VibeDrift measures *drift* (pattern deviation) separately from generic lint-style issues. That keeps the headline number honest about what the tool actually detects.

The Vibe Drift Score counts **all** cross-file drift signals — semantic duplication, naming, async, import and export conventions, phantom scaffolding, architectural and security drift, and commit archaeology — so a drifted codebase scores lower and more discerningly.

| Category | What counts (Drift) | What counts (Hygiene) |
|---|---|---|
| **Architectural Consistency** | Naming, import/export style, async patterns, return-shape/logging/state/test conventions, cross-file architectural drift, commit archaeology | Empty catches, unhandled async, language idioms |
| **Redundancy** | Semantic duplication, phantom scaffolding, fingerprint & opseq duplicates, ML duplicates | Static text duplicates, dead code, TODO density |
| **Dependency Health** | _(no drift signals here — drops out of composite)_ | Phantom/missing deps, undocumented env vars |
| **Security Posture** | Cross-file auth/validation drift, taint flows | Hardcoded secrets, generic OWASP regex |
| **Intent Clarity** | ML intent-mismatch, comment-style drift | Complexity, unclear naming, commented-out code |

> **Scoring stays comparable across upgrades.** When the scoring changes between releases, VibeDrift recomputes your past scans under the new scoring automatically, so trend lines compare like-with-like. Scans are also fully deterministic: the same commit produces the same score on every machine and in CI.

## Deep Scan (optional, AI-powered)

VibeDrift's local analysis is free and offline. An optional **deep scan** adds cloud-powered analysis that local static analysis can't do:

- **Semantic duplicates** via code embeddings + cosine similarity
- **Intent mismatches** — functions whose name doesn't match their behavior
- **Anomaly detection** via clustering on function embeddings
- **Surgical LLM validation** — medium-confidence ML findings are reviewed by an LLM

```bash
vibedrift login          # one-time browser sign-in
vibedrift . --deep       # run a deep scan
```

Deep scan sends function snippets (not full files) to the hosted VibeDrift service, which processes them in memory and does not store them. It requires a free account. See [vibedrift.ai](https://vibedrift.ai) for what the hosted service includes.

## MCP server

VibeDrift ships an MCP server so an AI coding agent (Claude Code, Cursor) can consult your repo's own conventions **while it writes code** — turning drift detection into drift *prevention*. It exposes five tools:

- `get_intent_hints` — the conventions your `CLAUDE.md` / `AGENTS.md` / `.cursorrules` declare
- `get_dominant_pattern` — the repo's majority pattern for a dimension (async, imports, naming, …) + examples to copy
- `check_file_drift` — does a file match the repo's patterns?
- `find_similar_function` — does a near-duplicate already exist? (so the agent reuses instead of re-writing)
- `validate_change` — would a proposed function introduce drift or duplicate something?

The five local tools are **free for everyone** — they run on your machine and never send your code, so there's no login and nothing to pay for. The tools build the repo's drift *baseline* automatically on first use, so there's no setup beyond adding the server.

### Deep mode — in-loop AI checks

`validate_change` and `find_similar_function` accept an opt-in **`deep: true`** that runs VibeDrift's deep scan on the single function being checked (intent-mismatch detection + LLM-validated semantic duplicates, the same engine as `vibedrift . --deep`). The agent catches a misleading name or a semantic clone *before the code lands*, not in a later review.

Deep mode sends **only that one function** to the hosted service; the five tools above stay 100% local. It requires sign-in and degrades gracefully: if you're offline it returns `status: "degraded"` with the local result intact, so it never errors the agent.

```bash
vibedrift login        # optional — enables deep: true
```

### Install in any MCP client

VibeDrift is a standard [MCP](https://modelcontextprotocol.io) server — there's no marketplace to publish to or extension to install. Any MCP-compatible client launches it with the same command. The universal spec is:

- **command:** `npx`  ·  **args:** `["-y", "@vibedrift/cli", "mcp"]`  ·  **transport:** stdio

**Claude Code** (writes the config for you):

```bash
claude mcp add vibedrift -- npx -y @vibedrift/cli mcp
```

**Cursor, Claude Desktop, Windsurf, Cline, VS Code, Zed, …** — paste the same block into that client's MCP config (Cursor: `~/.cursor/mcp.json` or project `.cursor/mcp.json`; others use their own config file / "Add MCP server" UI):

```json
{
  "mcpServers": {
    "vibedrift": { "command": "npx", "args": ["-y", "@vibedrift/cli", "mcp"] }
  }
}
```

The command never changes between clients — only where you paste it does.

If a tool returns `no_baseline`, run `vibedrift` once in that repo to build it. If a `deep: true` check returns `status: "degraded"`, the local result still comes back.

## CI Integration

A GitHub Action runs VibeDrift on pull requests, posts a score-delta comment, and can fail the check:

```yaml
# .github/workflows/vibedrift.yml
name: VibeDrift
on: [pull_request]

permissions:
  pull-requests: write

jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: skhan75/vibedrift-actions@v1
        with:
          token: ${{ secrets.VIBEDRIFT_TOKEN }}
          fail-on-score: 70
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

See the [Action repository](https://github.com/skhan75/vibedrift-actions) for all inputs, outputs, and token setup.

## Privacy & Telemetry

- **Your code never leaves your machine.** No source code, file contents, or file paths are ever sent.
- **Anonymous scan beacon, on by default for everyone.** After each scan VibeDrift sends a small anonymous beacon whether you are signed in or not. The payload is exactly: `language, file_count, loc, scan_time_ms, cli_version, is_deep, has_git, has_intent_hints, finding_count, score` (no code, no file paths, no identifiers, no account). It helps us improve the tool. Turn it off anytime with `vibedrift telemetry disable` (or set `VIBEDRIFT_TELEMETRY_DISABLED=1`), or run `--local-only` for a fully offline scan.
- **Update check (v0.6.1+)** — once every 24 hours, scans query the public npm registry to see whether a newer `@vibedrift/cli` is available. Cached locally. Fails silently on network errors. Respects `--local-only` and `vibedrift telemetry disable` — both skip the check entirely.
- **`--local-only`** — skip ALL network calls even when logged in. No scan log, no beacon, no update check, no deep analysis. Use this in air-gapped environments or on sensitive codebases.
- **`--deep`** sends function snippets (not full files) to the hosted service, processed in memory and not stored.
- **Auth state** lives at `~/.vibedrift/config.json` (mode 0600); revocable from `vibedrift logout` or the dashboard.
- **Scan history** lives at `~/.vibedrift/scans/` — never inside your project tree.

## Usage Reference

```
vibedrift [command] [path] [options]

Commands:
  scan [path]          Scan a project for vibe drift (default)
  watch [path]         Re-scan on file changes and refresh .vibedrift/ (requires `vibedrift login`, local, no network)
  login / logout       Account auth
  status               Show current account, plan, and token
  usage                Show this period's scan usage
  doctor               Diagnose CLI installation, auth, and API
  update               Update the CLI to the latest version
  feedback [message]   Send feedback, bug reports, or feature requests
  telemetry <action>   Enable or disable anonymous scan telemetry

Scan options:
  --format <type>       html (default), terminal, json, csv, docx
  --output <path>       Write report to a file
  --json                Shorthand for --format json
  --fail-on-score <n>   Exit with code 1 if Vibe Drift Score is below threshold
  --no-codedna          Skip Code DNA semantic analysis
  --no-cache            Disable the per-analyzer findings cache
  --deep                Enable AI-powered deep analysis (requires login)
  --local-only          Skip ALL network calls (offline / air-gapped mode)
  --write-context       Write .vibedrift/ context files (requires `vibedrift login`; safe to commit)
  --compare / --no-compare   Enable / disable the scan-over-scan diff banner (on by default when history exists)
  --since <scanId>      Diff against a specific saved scan rather than the most recent
  --project-name <name> Override the auto-detected project name
  --private             Anonymize project name (uses privXXXXXXXXXXXX)
  --include <pattern>   Only scan files matching this glob (repeatable)
  --exclude <pattern>   Exclude files matching this glob (repeatable)
  --verbose             Show timing breakdown and analyzer details

Watch options:
  --interval <seconds>  Debounce between rescans (default 10, min 2, max 600)
  --include, --exclude  Same semantics as scan
  --verbose             Print each file-change event

  Note: watch mode requires a signed-in account (free). It emits full
  finding details and refreshes the .vibedrift/ context files on every
  change — the equivalent gate as the one-shot scan. Run
  `vibedrift login` once, then `vibedrift watch`.
```

### Intent-hint files

VibeDrift reads team-declared conventions from these files in the scan root and uses them to seed the dominance vote (a declared pattern outweighs close raw votes, and deviations become high-confidence findings):

- `CLAUDE.md`
- `AGENTS.md` / `AGENT.md`
- `.cursorrules`
- `.claude/instructions.md`

Supported categories: architectural, naming, async, export, import, return-shape, logging, state-management, test-structure.

### Environment

| Variable | Purpose |
|---|---|
| `VIBEDRIFT_TOKEN` | Bearer token for CI / non-interactive use |
| `VIBEDRIFT_API_URL` | Override API base URL (staging / self-hosted) |
| `VIBEDRIFT_NO_BROWSER` | Set to `1` to never auto-open the browser |
| `VIBEDRIFT_DISABLE_CACHE` | Set to `1` to disable the findings cache |
| `VIBEDRIFT_TELEMETRY_DISABLED` | Set to `1` to turn off the anonymous scan beacon and update check (same effect as `vibedrift telemetry disable`) |

### Output Formats

- `html` (default) — interactive report with charts and foldable findings
- `terminal` — color-coded terminal output
- `json` — full scan result for CI pipelines
- `csv` — multi-section tabular export
- `docx` — Word document with AI summary and formatted findings

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, project layout, and how to add an analyzer or drift detector, and [AGENTS.md](./AGENTS.md) for the conventions this codebase follows. Please also read our [Code of Conduct](./CODE_OF_CONDUCT.md). Security issues: see [SECURITY.md](./SECURITY.md).

## License

The VibeDrift CLI is open source under the [MIT License](./LICENSE), so you are free to use, modify, and redistribute it. The CLI runs entirely on your machine; the optional cloud deep-scan service it talks to is a separate hosted product.

## Links

- **Website & docs:** [vibedrift.ai](https://vibedrift.ai)
- **Issues:** [GitHub Issues](https://github.com/VibeDrift/VibeDrift/issues)
- **Community:** [Discord](https://discord.gg/YVcQ65Jt3Q)
- **Feedback:** `vibedrift feedback "your message"`
