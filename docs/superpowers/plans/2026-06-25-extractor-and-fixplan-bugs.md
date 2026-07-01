# Function-extractor & Fix-Plan bug fixes

**Status:** Implemented and verified (TDD). 2026-06-25.

**Trigger:** A user (Anishek Kamal) reported that VibeDrift CLI 0.14.0 scored
`github.com/tobias-d/bandcamp-player-extension` unreliably: an "exact semantic
duplicate" finding described code that does not exist, and several "highest
impact" fix-plan items were self-scored at zero impact.

After cloning and scanning the repo, **both complaints were valid** and traced
to two distinct bugs. This document identifies each bug, the failing tests that
capture it, the fix, and the verification.

---

## Bug A — Function bodies truncated to the return-type annotation

**Where:** `src/codedna/function-extractor.ts`

**Symptom:** Functions whose TypeScript return type contains a `{` — e.g. an
inline object type `: { value: string; source: string }`, or
`: Promise<{ ... }>` — had their *body* mis-extracted as the return-type
annotation. Every function sharing a return shape collapsed to an identical
~8-token "body", producing a false **exact semantic duplicate** (and inflating
the LCS `duplicates` pairs and `codedna-opseq` signals that consume the same
extracted bodies).

**Root cause:** the JS/TS `function` pattern encoded the return type inline:

```
/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]*)?\{/g
```

`(?::\s*[^{]*)?` is meant to skip the return type before the body brace, but
`[^{]*` stops at the **first** `{`. For `): { value: string } {`, that first
`{` is the return-type object's brace — so the regex matched the return-type
brace *as if it were the body brace*. `extractBody` then captured
`" value: string; source: string }"` instead of the real body.

Confirmed on the real source: before the fix `readMutationCrumb` extracted **8**
body tokens; after, **518**. `readRootCrumb`: 8 → 162.

**The arrow pattern** (`[^=]*` return type) tolerated inline-object return types
but broke on `=>` inside the return type (function-type returns). Generic
functions (`function f<T>(...)`) were silently skipped entirely.

### Fix

Stop encoding the return type in the regex. Match only up to the parameter `)`,
then locate the real body brace with a small scanner that skips an optional
return-type annotation (balancing `{}`, `<>`, `()`, `[]`) and, for arrows, the
`=>`:

- `skipBraceBlock(content, i)` — balance a `{ ... }` block.
- `skipReturnType(content, i, isArrow)` — scan a TS return type, disambiguating
  a return-type object from the body by peeking at what follows a balanced
  top-level `{ ... }` (`|`/`&` → union member, keep scanning; another `{` or an
  arrow `=>` → the body follows; otherwise the block *was* the body). `=>` only
  terminates the scan for arrows, so a `function` returning a function type
  (`(): () => void { ... }`) does not regress.
- `findBodyOpenBrace(content, fromIndex, isArrow)` — orchestrates the above and
  returns the body `{` index, or -1 for bodiless declarations (overload/ambient
  signatures, expression-bodied arrows).

Patterns now end at `)`; the extraction loop branches on `bodyAfterMatch`
(Go/Rust/Python keep the old "body starts after the match" path; JS/TS use
`findBodyOpenBrace`). Generics support added to the function and arrow patterns.

### Tests (`test/unit/codedna/function-extractor.test.ts`)

Failing before the fix, passing after:
- Inline-object return type → body contains the implementation, > 20 tokens.
- Two functions sharing a return shape but with different bodies → different
  `bodyHash` (the core false-positive).
- `Promise<{...}>` return type.
- Union return type with an inline-object member.
- Generic function with type parameters.
- Arrow function with an inline-object return type.
- End-to-end: `extractAllFunctions → computeSemanticFingerprints →
  findDuplicateGroups` produces **zero** groups for two functions that only
  share a return-type annotation.

Regression guards (passing before and after): simple primitive return type, no
return type, overload signatures not mis-extracted as tiny bodies.

---

## Bug B — Fix-plan items that display as `+0.0pts`

**Where:** `src/output/terminal.ts`, `src/output/html.ts`,
`src/output/context-md.ts` (three independent fix-plan selectors).

**Symptom:** the Fix Plan ("highest-impact drifts to re-align first") listed
items showing `+0.0pts consistency` — telling the user to fix something for no
visible gain.

**Root cause:** the selectors filtered `consistencyImpact > 0`, but
`consistencyImpact` is stored to two decimals while the plan renders it to one
(`+X.Xpts`). A finding with impact 0.01–0.04 passed the `> 0` filter yet
displayed as `+0.0pts`.

### Fix

New shared module `src/output/fix-plan-select.ts`:
- `FIX_PLAN_MIN_IMPACT = 0.05` — the smallest impact that does not render as
  `+0.0pts` at one-decimal display.
- `hasMeaningfulImpact(finding)` — `consistencyImpact >= FIX_PLAN_MIN_IMPACT`.
- `selectFixPlanFindings(findings, limit)` — filter + sort + slice.

All three renderers now filter with `hasMeaningfulImpact`. The full-fix-plan
markdown (`buildFullFixPlanMarkdown`) receives the pre-filtered list and uses
two-decimal display, so it stays consistent.

### Tests (`test/unit/output/fix-plan-select.test.ts`)

Drops findings whose impact rounds to `+0.0pts`; keeps the 0.05 boundary; sorts
descending; respects the limit; returns an empty plan when everything is
display-zero; `hasMeaningfulImpact` boundary; threshold matches one-decimal
rounding.

---

## Verification

- Full suite: **628 tests pass** (612 prior + 16 new). Build + lint clean.
- Re-scanned bandcamp-player-extension with the patched CLI:
  - The false crumb/title duplicate group is **gone**.
  - The 61 remaining `codedna-fingerprint` findings are **genuine** (e.g.
    `clamp01` is defined identically in 6 files, `createAbortError` in 2).
  - Composite moved to **69.9/100** (from ~55), now reflecting real drift
    rather than phantom duplicates.
  - Fix plan now lists only visible-impact items (`+0.7 / +0.4 / +0.3 / +0.2`),
    no `+0.0pts` noise.

## Notes / follow-ups

- Self-scanning vibedrift-public surfaces test-helper duplicates (`mkCtx()`,
  `file()`) at the top of the fix plan. Correct (they are real duplicates), but
  consider down-weighting `test/` fixtures in fix-plan ranking — parked in
  `todo.md`, not part of this fix.
- The extractor still cannot handle a return-type that is a string literal
  containing `{`/`;`/`=>` (e.g. `: "a;b"`). Vanishingly rare for return types;
  documented, not fixed.
