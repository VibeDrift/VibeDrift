<div align="center">

<img src="assets/vibedrift-logo.png" alt="VibeDrift" width="120" height="120" />

# VibeDrift

### Your AI agent gets worse as your project grows.

It forgets your patterns, repeats code, and breaks what worked. **VibeDrift catches the drift before it spreads** — locally, on your machine.

[![Website](https://img.shields.io/badge/vibedrift.ai-FFD000?style=flat&labelColor=1a1a1a)](https://vibedrift.ai) [![npm](https://img.shields.io/npm/v/@vibedrift/cli.svg?color=FFD000)](https://www.npmjs.com/package/@vibedrift/cli) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE) [![Discord](https://img.shields.io/badge/Discord-join-5865F2?style=flat)](https://discord.gg/YVcQ65Jt3Q)

**Free · Open source · Runs on your machine**

</div>

---

Every fresh agent session starts with no memory of the conventions your codebase already settled on. So it makes reasonable choices that just aren't *your* choices. One handler throws a typed error; the next returns a plain object. Eight services use a repository layer; the ninth reaches for raw SQL. Everything compiles, everything passes review, and the codebase slowly stops agreeing with itself.

That gap is **drift** — and it's invisible to linters, because a linter checks one file at a time. VibeDrift checks your codebase *against itself*: it learns the patterns your code already agrees on, then flags every file that deviates, and points you at the exact line.

> Full documentation, the scoring guide, and what each finding means live at **[vibedrift.ai/guide](https://vibedrift.ai/guide)**.

## Quick start

```bash
npx @vibedrift/cli
```

That's it. No install, no signup. Scans the current directory and opens an interactive HTML report. Your code never leaves your machine.

Install globally if you prefer:

```bash
npm i -g @vibedrift/cli
vibedrift                       # scan ./
vibedrift ./path/to/project     # scan a specific path
```

## What it finds

- Architectural inconsistencies (half your handlers use a repository, the rest hit raw SQL)
- Hidden duplicates: two functions doing the same thing under different names
- Convention drift across naming, imports, error handling, async style, and logging
- Security gaps: hardcoded secrets, injection risks, unsanitized input
- Dead code, complexity hotspots, and half-finished or placeholder implementations

Under the hood, VibeDrift learns your repo's dominant patterns by majority vote, fingerprints logic with Code DNA to catch near-duplicates, and rolls findings into a **Vibe Drift Score** and a **Hygiene Score**. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the engine and the [scoring guide](https://vibedrift.ai/guide) for how findings are weighted.

**Supported languages:** JavaScript, TypeScript, Python, Go, Rust.

## From detection to prevention

Catching drift after it ships is a postmortem. The real win is checking *while* the agent writes.

1. **Detect** — `vibedrift` scans your repo, scores it against its own conventions, and shows the evidence. Great for audits and CI gates.
2. **Prevent in the loop** — the [MCP server](#mcp-server) lets your agent ask the codebase about itself *before* it writes a line, so new code matches the first time.
3. **Prevent at the source** — [VibeLang](https://thevibelang.org), where behavioral intent becomes compiler-enforced, so drift can't compile.

Detection tells you, in-loop prevention nudges you, language-level prevention makes it impossible. MCP is the rung that's live today.

## Commands

```
vibedrift [path]            Scan a project (default command)
vibedrift watch [path]      Re-scan on file changes (Pro)
vibedrift mcp               Run the MCP server (Claude Code / Cursor / any MCP client)
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

`vibedrift --deep` adds cloud-powered analysis that local static checks cannot do: semantic duplicate detection, name-versus-behavior intent checks, an in-loop Claude verdict on borderline matches, and a synthesized coherence report graded against your own patterns. Scope it to your change set with `--diff`:

```bash
vibedrift login
vibedrift . --deep              # full-repo deep scan
vibedrift . --deep --diff       # deep-scan only what you changed (fast pre-PR check)
vibedrift . --deep --diff main  # deep-scan everything that differs from a branch
```

Deep scan sends function snippets only (never full files or file paths), processed in memory and not stored. The free tier includes a monthly allowance of deep scans; see [vibedrift.ai](https://vibedrift.ai) for current plans.

## MCP server

VibeDrift ships an MCP server so an AI coding agent can consult your repo's own conventions while it writes — turning drift detection into drift prevention. It exposes five tools:

- `get_intent_hints` reads the conventions your `CLAUDE.md` / `AGENTS.md` / `.cursorrules` declare
- `get_dominant_pattern` returns the repo's majority pattern for a dimension, with examples to copy
- `check_file_drift` checks whether a file matches the repo's patterns
- `find_similar_function` finds an existing near-duplicate so the agent reuses instead of rewriting
- `validate_change` checks whether a proposed function would introduce drift or duplicate something

These tools run on your machine, send no code, and need no login. They build the repo's baseline automatically on first use. (The `validate_change` and `find_similar_function` tools can opt into a deeper semantic pass, which is the only part that's metered.)

### Install in any MCP client

VibeDrift is a standard [MCP](https://modelcontextprotocol.io) server launched over stdio with `npx -y @vibedrift/cli mcp`.

**Claude Code** (writes the config for you):

```bash
claude mcp add vibedrift -- npx -y @vibedrift/cli mcp
```

**Cursor, GitHub Copilot, Windsurf, Antigravity, OpenAI Codex, Kiro, Claude Desktop, VS Code, Zed, and any other MCP client** use the same command in their MCP config:

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

- **Website:** [vibedrift.ai](https://vibedrift.ai)
- **Docs & scoring guide:** [vibedrift.ai/guide](https://vibedrift.ai/guide)
- **Blog:** [vibedrift.ai/blog](https://vibedrift.ai/blog)
- **Releases:** [vibedrift.ai/releases](https://vibedrift.ai/releases)
- **FAQ:** [vibedrift.ai/faq](https://vibedrift.ai/faq)
- **Issues:** [GitHub Issues](https://github.com/VibeDrift/VibeDrift/issues)
- **Community:** [Discord](https://discord.gg/YVcQ65Jt3Q)
