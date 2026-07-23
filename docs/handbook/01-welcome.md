# Welcome

VibeDrift is a drift scanner for AI-assisted codebases. It measures one thing: how far a repository has drifted from its own dominant conventions. It learns the patterns a codebase already agrees on (by majority vote, with evidence), then flags the files that deviate and reports the result as a **Vibe Drift Score**.

That identity is the most important sentence in this handbook, because it rules out two things people expect from a code scanner:

- **VibeDrift is not a generic code-quality tool.** SonarQube, Semgrep, and CodeQL already exist. A finding here needs a baseline it deviates from; a peer group is a precondition, not a nice-to-have. `CONTRIBUTING.md` states the test every change must pass: does this make us measure drift more accurately or more confidently?
- **VibeDrift is not a vulnerability scanner.** The Security Consistency category measures how uniformly a repo applies its *own* auth, validation, and rate-limit patterns, not the absence of vulnerabilities. The terminal report renders that disclaimer permanently under the security bar (`src/output/terminal.ts`): consistent does not mean safe.

The distinction is enforced in code, not just in copy. Every signal is classified as either **drift-kind** (grounded in a dominance vote, similarity signal, or taint flow) or **hygiene-kind** (classic linter territory: empty catches, dead code, generic security rules). Only drift-kind findings feed the headline Vibe Drift Score; hygiene findings render in their own pane with their own parallel score (`src/scoring/categories.ts`). Chapter 08 covers the mechanics.

Concretely, the product in this repo is a TypeScript CLI (`npx @vibedrift/cli`) and an MCP server, published as `@vibedrift/cli`. It analyzes JavaScript, TypeScript, Python, Go, and Rust and runs its analysis locally; the hosted service is used only for the optional metered deep scan, the dashboard sync for signed-in users, a disclosed opt-out anonymous beacon, and a daily update check (chapter 12 walks the exact boundary).

## Who this handbook is for

A developer who is new to this codebase and wants to change it: add an analyzer or a drift detector, extend a language, fix a scoring behavior, or embed the in-loop tools somewhere new. It assumes you are a competent engineer and assumes nothing about this repo. Chapter 2 is the map; the rest of the chapters walk the actual code paths, constants, and invariants, and say why they are the way they are.

## Reading map

Each chapter answers one question. Read 01 through 03 in order; after that, chapters stand alone.

| Chapter | The question it answers |
| --- | --- |
| 02 System Architecture | What are the layers, what runs locally versus in the cloud, and what lives in each `src/` directory? |
| 03 The Scan Pipeline | What happens, step by step, when `vibedrift scan .` runs? |
| 04 Layer 1: Static Analyzers | What does each of the 13 per-file analyzers detect, and how? |
| 05 Cross-File Drift Detection | How does the dominance vote work, and what do the 14 cross-file detectors flag? |
| 06 Security Consistency: Auth Drift Across Languages | How is auth drift detected per language, and what does never-false-bless mean? |
| 07 Layer 1.7: Code DNA | How are functions fingerprinted and near-duplicates found, all locally? |
| 08 Scoring: From Findings to the Vibe Drift Score | How do findings become the composite score and the Hygiene Score? |
| 09 The MCP Server: Drift Checks in the Agent Loop | How does an AI agent query the repo's conventions while writing code? |
| 10 Drift Sessions | How does VibeDrift ride inside a coding session and flag drift while the agent works? |
| 11 Output Surfaces | How do results render: terminal, HTML, JSON, CSV, DOCX, and the committable context files? |
| 12 The Local/Cloud Boundary | Exactly what does the optional deep scan send, receive, and refuse to send? |
| 13 Testing, Calibration, and CI | How is correctness enforced: unit suites, fixtures, and the calibration gates? |
| 14 Extending VibeDrift | Step-by-step recipes: new analyzer, new detector, new language, new output format. |
| 15 Glossary | Every term of art in the handbook, one definition each. |

## How to update this handbook

The handbook is built from the markdown in this directory. The HTML at the repo root is a build artifact; never edit it by hand.

1. Edit the relevant chapter in `docs/handbook/NN-*.md` (or add a new `NN-*.md` file; chapters compile in filename order).
2. Rebuild with `npm run handbook` (which runs `node scripts/build-handbook.mjs`; the build has zero dependencies and runs on Node 20+, the repo's engines floor).
3. Commit the changed markdown together with the regenerated HTML.

The full conventions (supported markdown subset, SVG diagram palette, writing rules) live in `docs/handbook/README.md`. Two rules from there worth repeating: every claim about the code must be verified against the actual source before it lands, and when a code change makes a chapter stale, fix the chapter in the same PR.
