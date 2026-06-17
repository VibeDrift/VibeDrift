# Contributing to VibeDrift

Thanks for your interest in improving VibeDrift. This repository is the
open-source **VibeDrift CLI**: the local analysis pipeline, the MCP server, and
the client that talks to the optional cloud deep-scan service. The hosted
deep-scan service, the dashboard, and billing are separate products and are not
part of this repo.

## What VibeDrift is (read this first)

VibeDrift measures **drift**: the gap between the patterns a codebase started
with and the patterns new code is introducing. The output is a **Vibe Drift
Score**, which is how consistent a codebase is with itself, not how "good" it
is. Every detector, optimization, or feature should answer one question:

> Does this make us measure drift **more accurately** or **more confidently**?

Things we deliberately avoid:

- Reporting issues that are not deviations from the codebase's own dominant
  pattern. (SonarQube, Semgrep, and CodeQL already exist; we are not trying to
  become them.)
- Raising a finding without a baseline it deviates from. Drift requires a peer
  group.
- Calling the composite a "debt score" or "quality score" in UI copy, docs, or
  code. The product's language is **Vibe Drift Score**.

When in doubt, ask: what is the baseline, and how confidently is this deviating
from it?

## Getting set up

Prerequisites: Node.js >= 20.

```bash
git clone https://github.com/VibeDrift/VibeDrift.git
cd VibeDrift
npm ci
npm run build
npm test
```

Run the CLI from source against any project:

```bash
npx tsx src/cli/index.ts /path/to/a/project
```

## Project layout

| Path | What lives here |
| --- | --- |
| `src/analyzers/` | Layer 1: per-file static analyzers (naming, imports, complexity, security, etc.) |
| `src/drift/` | Layer 1: cross-file drift detectors (architectural, naming, import, export, async, etc.) |
| `src/codedna/` | Layer 1.7: the Code DNA engine (fingerprinting, op sequences, taint, deviation) |
| `src/deep/`, `src/ml-client/` | Layer 2 client: talks to the cloud deep-scan service |
| `src/mcp/` | MCP server: the five local tools plus the in-editor deep-scan client |
| `src/scoring/` | findings into 5 categories of 0-20 into a composite of 0-100 |
| `src/output/` | report renderers (HTML, terminal, JSON, CSV, DOCX) |
| `src/cli/` | Commander.js commands |
| `eval/` | the evaluation harness used to measure VibeDrift's own efficacy |
| `test/` | vitest unit, integration, and calibration suites |
| `docs/algorithms.md` | how the scoring and detectors work |

## Adding an analyzer or a drift detector

- **Analyzer:** add a file in `src/analyzers/` and register it in
  `src/analyzers/index.ts`.
- **Drift detector:** add a file in `src/drift/`, add the `DriftCategory` to
  `src/drift/types.ts`, and register it in `src/drift/index.ts`. A detector
  should produce a finding grounded in a dominance or similarity signal, never a
  raw heuristic on its own.

## Code style

- ESM throughout (`"type": "module"`), strict TypeScript.
- Path alias `@/*` maps to `src/*`.
- camelCase for variables and functions, PascalCase for classes and types.
- Named exports only; avoid default exports.
- async/await throughout; no `.then()` chains in new code.
- Throw on error; do not return null or an error-shaped object from functions
  that can fail.
- Tests use describe/it (bdd-style) with vitest and `vi.fn` / `vi.mock`.

Before opening a pull request, make sure all of these pass:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Commits and pull requests

- Commit format: `feat|fix|docs(scope): description`
  (for example `fix(drift): handle empty directories in the dominance vote`).
- Keep pull requests focused. One change per PR is easier to review.
- New behavior needs tests. Bug fixes should include a regression test.
- Update `README.md` whenever you add or change a CLI flag, command, or feature.

## What does not belong here

This is the open client. Product strategy, pricing, cloud-service code, and
internal planning live in private repositories, not here. Please do not add
secrets, API keys, internal roadmaps, or scan artifacts to the repo.

## Licensing of contributions

By submitting a contribution, you agree that it is licensed under the
[MIT License](./LICENSE) that covers this project.
