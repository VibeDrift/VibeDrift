<div align="center">

<img src="assets/vibedrift-logo.png" alt="VibeDrift" width="120" height="120" />

# VibeDrift

**Ship agentic. Stay coherent.**

[![Website](https://img.shields.io/badge/vibedrift.ai-f0c000?style=flat&labelColor=1a1a1a)](https://vibedrift.ai) [![npm](https://img.shields.io/npm/v/@vibedrift/cli.svg?color=f0c000)](https://www.npmjs.com/package/@vibedrift/cli) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

VibeDrift detects drift in AI-generated code: where new code diverges from the patterns the rest of your codebase already follows. It runs locally, scores your repo against its own conventions, and points you at the exact files. Your code never leaves your machine.

The fastest way to stay coherent is to check drift *while* the agent writes. The [MCP server](#mcp-server) gives Claude Code and Cursor live, in-loop access to your repo's conventions, so new code matches the first time.

> Full documentation, the scoring guide, and what each finding means live at **[vibedrift.ai/guide](https://vibedrift.ai/guide)**.

## Quick start

```bash
npx @vibedrift/cli
```

That's it. No install, no signup. Scans the current directory and opens an interactive HTML report.

Install globally if you prefer:

```bash
npm i -g @vibedrift/cli
vibedrift                       # scan ./
vibedrift ./path/to/project     # scan a specific path
```

## Supported languages

JavaScript, TypeScript, Python, Go, Rust.

## What it finds

- Architectural inconsistencies (half your handlers use a repository, the rest hit raw SQL)
- Hidden duplicates: two functions doing the same thing under different names
- Convention drift across naming, imports, error handling, async style, and logging
- Security gaps: hardcoded secrets, injection risks, unsanitized input
- Dead code, complexity hotspots, and half-finished or placeholder implementations

VibeDrift learns your codebase's dominant patterns and flags the deviators. See the [scoring guide](https://vibedrift.ai/guide) for how findings roll up into a score.

## Commands

```
vibedrift [path]            Scan a project (default command)
vibedrift watch [path]      Re-scan on file changes (requires login)
vibedrift mcp               Run the MCP server (Claude Code / Cursor)
vibedrift login / logout    Account auth
vibedrift status            Account, plan, and token
vibedrift hook <action>     Install or remove a git pre-push drift gate
vibedrift doctor            Diagnose install, auth, and API
vibedrift update            Update to the latest version
```

Common scan options:

```
--format <html|terminal|json|csv|docx>   output format (html is the default)
--fail-on-score <n>                       exit 1 if the score is below n (CI gate)
--diff [ref]                              scan only files changed in git (vs HEAD, or vs a ref/branch)
--deep                                    AI-powered deep analysis (requires login)
--include / --exclude <glob>              filter the files scanned (repeatable)
--write-context                           write committable .vibedrift/ context files
--local-only                              skip every network call (fully offline)
```

Run `vibedrift --help` for the complete list.

## Deep scan

`vibedrift --deep` adds cloud-powered analysis that local static checks cannot do: semantic duplicate detection, name-versus-behavior intent checks, and a synthesized coherence report. Scope it to your change set with `--diff`:

```bash
vibedrift login
vibedrift . --deep              # full-repo deep scan
vibedrift . --deep --diff       # deep-scan only what you changed (fast pre-PR check)
vibedrift . --deep --diff main  # deep-scan everything that differs from a branch
```

Deep scan sends function snippets only (never full files or file paths), processed in memory and not stored. It requires a free account. See [vibedrift.ai](https://vibedrift.ai) for what deep scan includes.

## MCP server

VibeDrift ships an MCP server so an AI coding agent can consult your repo's own conventions while it writes, turning drift detection into drift prevention. It exposes five tools:

- `get_intent_hints` reads the conventions your `CLAUDE.md` / `AGENTS.md` / `.cursorrules` declare
- `get_dominant_pattern` returns the repo's majority pattern for a dimension, with examples to copy
- `check_file_drift` checks whether a file matches the repo's patterns
- `find_similar_function` finds an existing near-duplicate so the agent reuses instead of rewriting
- `validate_change` checks whether a proposed function would introduce drift or duplicate something

These tools run on your machine, send no code, and need no login. They build the repo's baseline automatically on first use.

### Install in any MCP client

VibeDrift is a standard [MCP](https://modelcontextprotocol.io) server launched over stdio with `npx -y @vibedrift/cli mcp`.

**Claude Code** (writes the config for you):

```bash
claude mcp add vibedrift -- npx -y @vibedrift/cli mcp
```

**Cursor, Claude Desktop, Windsurf, Cline, VS Code, Zed, and others** use the same command in their MCP config:

```json
{
  "mcpServers": {
    "vibedrift": { "command": "npx", "args": ["-y", "@vibedrift/cli", "mcp"] }
  }
}
```

If a tool returns `no_baseline`, run `vibedrift` once in that repo to build it.

### Without MCP

The same five tools are also a plain import and an Agent Skill over the same engine, for agents that do not speak MCP:

- **Import:** `import { validateChange, findSimilarFunction } from "@vibedrift/cli/tools"` (see [docs/tools-api.md](./docs/tools-api.md))
- **Agent Skill:** a self-contained skill at [`skills/vibedrift/`](./skills/vibedrift/SKILL.md)

## CI integration

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
          fail-on-score: 70
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

See the [Action repository](https://github.com/skhan75/vibedrift-actions) for all inputs and outputs.

## Privacy

- **Your code never leaves your machine.** No source, file contents, or file paths are ever sent.
- **Anonymous scan beacon, on by default for everyone.** After each scan VibeDrift sends a small anonymous beacon: language, file count, lines of code, scan time, CLI version, finding count, and score. No code, no paths, no identifiers. Turn it off with `vibedrift telemetry disable`, `VIBEDRIFT_TELEMETRY_DISABLED=1`, or `--local-only`.
- **Update check.** Once a day, scans check the npm registry for a newer version (cached, fails silently, skipped under `--local-only`).
- **`--local-only`** skips every network call, even when logged in.
- Auth state lives at `~/.vibedrift/config.json` (mode 0600); scan history at `~/.vibedrift/scans/`, never in your project tree.

### Environment variables

| Variable | Purpose |
|---|---|
| `VIBEDRIFT_TOKEN` | Bearer token for CI / non-interactive use |
| `VIBEDRIFT_API_URL` | Override the API base URL |
| `VIBEDRIFT_TELEMETRY_DISABLED` | Set to `1` to turn off the beacon and update check |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and how to add an analyzer, [AGENTS.md](./AGENTS.md) for codebase conventions, and [SECURITY.md](./SECURITY.md) for reporting security issues.

## License

MIT. See [LICENSE](./LICENSE). The CLI runs entirely on your machine; the optional cloud deep-scan service it talks to is a separate hosted product.

## Links

- **Docs & scoring guide:** [vibedrift.ai/guide](https://vibedrift.ai/guide)
- **Website:** [vibedrift.ai](https://vibedrift.ai)
- **Issues:** [GitHub Issues](https://github.com/VibeDrift/VibeDrift/issues)
- **Community:** [Discord](https://discord.gg/YVcQ65Jt3Q)
