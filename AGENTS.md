# VibeDrift — Agent & Contributor Guide

VibeDrift detects **drift** in AI-generated codebases. Published as `@vibedrift/cli`. This repository is the open client: the local analysis pipeline, the MCP server, and the client for the optional cloud deep-scan service.

## Core identity (read this first)

VibeDrift measures **drift**: the gap between the patterns a codebase started with and the patterns new code is introducing. The output is the **Vibe Drift Score** — how consistent a codebase is with itself, not how "good" it is.

Every detector, optimization, or feature must answer one question:

> Does this make us measure drift **more accurately** or **more confidently**?

Anti-patterns to avoid:

- Reporting issues that are not deviations from the codebase's own dominant pattern. SonarQube, Semgrep, and CodeQL already exist; we are not trying to become them.
- Raising a finding without a baseline it deviates from. Drift requires a peer group.
- Calling the composite a "debt score" or "quality score" in copy, docs, or code. The product's language is **Vibe Drift Score**.

Good signals we chase:

- Cross-file dominance voting — "8 of 10 files do X, 2 do Y" (the 2 are drift).
- Semantic similarity with evidence — MinHash/LSH, embeddings, token LCS.
- Pattern classification with confidence bands.
- Taint flows grounded in source-to-sink propagation.
- Entropy gates that distinguish "drift from a norm" vs "no norm exists".

When in doubt, ask: what is the baseline, and how confidently is this deviating from it?

## Stack

- Node.js >= 20, TypeScript (ESM, strict).
- CLI: Commander.js.
- AST: web-tree-sitter (WASM) + tree-sitter-wasms.
- Build: tsup. Test: vitest. Lint: eslint.

## Commands

```bash
npm ci            # install
npm run build     # build to dist/
npm test          # run the vitest suite
npm run lint      # eslint
npm run typecheck # tsc --noEmit
```

Run from source against any project:

```bash
npx tsx src/cli/index.ts /path/to/a/project
```

## Architecture

| Layer | Where | Cost |
| --- | --- | --- |
| **Layer 1** (static + drift) | `src/analyzers/` (12 static analyzers) + `src/drift/` (8 cross-file drift detectors) | local, free |
| **Layer 1.7** (Code DNA) | `src/codedna/` — fingerprinting, op sequences, pattern classification, taint, deviation | local, free |
| **Layer 2** (deep scan) | `src/deep/` + `src/ml-client/` — client that talks to the hosted cloud service; embeddings and LLM validation run server-side | cloud, metered |

Supporting modules: `src/scoring/` turns findings into 5 categories of 0-20 into a composite of 0-100; `src/output/` renders reports (HTML, terminal, JSON, CSV, DOCX); `src/mcp/` is the MCP server (5 local tools plus the in-editor deep-scan client); `src/cli/` holds the Commander.js commands.

## Conventions

- ESM throughout (`"type": "module"`). Path alias `@/*` maps to `src/*`.
- camelCase for variables and functions, PascalCase for classes and types.
- Named exports only; avoid default exports.
- async/await throughout; no `.then()` chains in new code.
- Throw on error; do not return null or an error-shaped object from functions that can fail.
- Tests use describe/it with vitest and `vi.fn` / `vi.mock`.

## Adding an analyzer or a drift detector

- **Analyzer:** add a file in `src/analyzers/` and register it in `src/analyzers/index.ts`; map its id to a scoring category in `src/scoring/`.
- **Drift detector:** add a file in `src/drift/`, add the `DriftCategory` to `src/drift/types.ts`, and register it in `src/drift/index.ts`. A detector must be grounded in a dominance or similarity signal, never a raw heuristic on its own.

## Commits

- Format: `feat|fix|docs(scope): description` (for example `fix(drift): handle empty directories in the dominance vote`).
- New behavior needs tests; bug fixes need a regression test.
- Update `README.md` whenever you add or change a CLI flag, command, or feature.

## What does not belong here

This is the open client. No secrets, API keys, pricing or strategy, internal roadmaps, or private cloud-service code. Product strategy and the hosted service live in private repositories. See `CONTRIBUTING.md` for the full contributor guide and `SECURITY.md` for reporting vulnerabilities.
