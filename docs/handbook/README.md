# Developer Handbook

How VibeDrift is engineered, chapter by chapter. These files render as normal
markdown right here on GitHub, so you can read the whole handbook without
leaving the repo. For the styled single-page version, see
[vibedrift.ai/handbook](https://vibedrift.ai/handbook) or open
[`DEVELOPER_HANDBOOK_OSS.html`](./DEVELOPER_HANDBOOK_OSS.html) in this
directory.

## Chapters

1. [Welcome](./01-welcome.md) — what VibeDrift is (and is not), and how to read this handbook
2. [System Architecture](./02-architecture.md) — the layered pipeline and the repo map
3. [The Scan Pipeline](./03-scan-pipeline.md) — what happens when you run a scan, and the CLI surface
4. [Layer 1: Static Analyzers](./04-static-analyzers.md) — the per-file checks and what each one flags
5. [Cross-File Drift Detection](./05-drift-detection.md) — the dominance vote and the drift detectors
6. [Security Consistency](./06-security-consistency.md) — auth drift across languages, and never-false-bless
7. [Layer 1.7: Code DNA](./07-code-dna.md) — fingerprinting, MinHash, op sequences, taint
8. [Scoring](./08-scoring.md) — from findings to the Vibe Drift Score
9. [The MCP Server](./09-mcp-tools.md) — drift checks in the agent loop
10. [Output Surfaces](./10-outputs.md) — terminal, HTML, CSV, DOCX, and the generated context block
11. [The Local/Cloud Boundary](./11-cloud-boundary.md) — every byte that can leave your machine, and how to opt out
12. [Testing, Calibration, and CI](./12-testing-and-calibration.md) — how a detector change is proven safe
13. [Extending VibeDrift](./13-extending.md) — recipes for adding analyzers, detectors, languages, and formats
14. [Glossary](./14-glossary.md) — every term of art, defined

## Source of truth

This directory is the source of truth for `DEVELOPER_HANDBOOK_OSS.html`, which
is built into this same directory. The HTML is a build artifact. Never edit it
by hand.

## Updating the handbook

1. Edit the relevant `NN-*.md` chapter (or add a new one; chapters compile in
   filename order, so pick a number that slots it where it belongs).
2. Rebuild: `npm run handbook` (or `node scripts/build-handbook.mjs`).
3. Commit the changed markdown together with the regenerated HTML.

The build has zero dependencies. Any Node 18+ runs it without an install step.

## Layout

```
docs/handbook/
  handbook.json     title, badge, output path
  NN-chapter.md     one file per chapter, compiled in filename order
  assets/*.svg      diagrams, inlined into the HTML at build time
scripts/build-handbook.mjs
```

## Markdown subset

Chapters are GitHub-flavored markdown, so they also render normally on GitHub.
The build supports: ATX headings (`#` to `####`), fenced code blocks with a
language tag, pipe tables, nested lists, blockquotes, GitHub admonitions
(`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`), bold, italic,
strikethrough, inline code, links, horizontal rules, and images.

Diagrams are standard image references to local SVG files:

```markdown
![Caption text shown under the diagram](assets/scan-flow.svg)
```

The build inlines the SVG into the HTML (so the file stays portable) and
GitHub renders the same line as a normal image.

## Diagram conventions

Diagrams are hand-authored SVGs on a transparent background, so they sit on
the handbook's dark theme. Palette: `#eab308` (yellow) for primary boxes and
emphasis, `#9aa3af` for arrows and secondary strokes, `#e8eaed` for text,
`#34d399` (green) and `#f87171` (red) reserved for good/bad annotations.
Use `font-family="ui-monospace, Menlo, monospace"` and `font-size="12"`.
Keep diagrams under ~900px wide; the container scrolls horizontally if wider.

## Writing rules

- Accuracy is non-negotiable. Every claim about the code must be verified
  against the actual source before it lands. Cite the file
  (`src/scoring/engine.ts`) when you state behavior; if you are not sure,
  do not write it.
- When code changes make a chapter stale, fix the chapter in the same PR as
  the code change whenever practical.
- Plain flowing prose. No em-dashes.
- Keep examples short, real, and runnable where possible.
