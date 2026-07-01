# VibeDrift backlog

Parking lot for enhancements discussed in conversation but not yet
executed. New items go at the top; items that get done move to
`git log` (delete the bullet). Keep each item scoped to a couple of
sentences — enough to pick it up cold, not a full spec.

(Canonical CLI backlog. Historical items still live in the deprecated
`vibe-drift/todo.md`; migrate them here if/when useful.)

## Agent token reduction via the Codebase Brain (repo-map + localization) — 2026-06-29

From the MCP token pilot (remeda hasProp, C-vs-T, n=3): the with-MCP arm ran ~9% fewer tokens but it was noisy (paired diffs -22% / +17% / -15%, mostly one expensive control outlier), so Sami parked the "MCP saves tokens" claim — not worth a blog below a clear ~50% reduction. KEY DATUM worth keeping: ~95% of an agent's run tokens are CACHE-READ (code pulled into context and re-read each turn); model output is tiny (~30-40k). So the only big lever on agent token cost is cutting EXPLORATION, not tool overhead. Idea: have VibeDrift's engine precompute a compact, pattern-aware artifact the agent reads ONCE instead of grepping/opening dozens of files — a repo map (module boundaries, public API signatures w/o bodies, dominant convention per dimension), targeted symbol/definition retrieval (return the 30-line function + types + callers, not the 800-line file), and task localization (given the task, name the 2-3 files/functions to edit). VibeDrift already has the index for this (tree-sitter, function fingerprints, the embedding model). CAVEATS before investing: 50% is ambitious vs already-efficient frontier agents and cheap cache-read ($0.50/MTok); the win SCALES WITH REPO SIZE (remeda is tiny -> low ceiling, hence ~10%), so validate on LARGE repos with localization-heavy tasks; strong prior art to beat (aider repomap, Cursor index, Claude Code's own context mgmt); and token reduction is OFF the drift mission unless folded INTO the Codebase Brain so the same artifact enforces patterns AND displaces exploration — judge it primarily on pattern adherence, with token savings as a bonus. Rig to reuse if revisited: `eval/context-token-benchmark/` (C/P/T arms, blinded diff capture, `--strict-mcp-config` isolation, drift judge, analyzer) + `DRIFT-EXPERIMENT-STATUS.md`.
