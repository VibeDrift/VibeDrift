# Tools API (`@vibedrift/cli/tools`)

VibeDrift's five in-loop tools are also available as a plain importable API, not
just over MCP. Same engine, same verdicts; you choose the channel.

```ts
import {
  getIntentHints,
  getDominantPattern,
  checkFileDrift,
  findSimilarFunction,
  validateChange,
} from "@vibedrift/cli/tools";
```

Every function takes a plain args object and returns plain data. None of them
imports a transport, so they drop into a code-mode host, an Agent Skill, a git
hook, or a native editor plugin the same way they drop into the MCP server (which
is itself just one adapter over these functions). A drift baseline is built lazily
on the first call per repo (one-time, then cached); local checks make no network
calls and your code never leaves your machine.

## Functions

| Function | Args | Returns |
| --- | --- | --- |
| `getIntentHints` | `{ rootDir }` | declared conventions from `CLAUDE.md` / `AGENTS.md` / `.cursorrules` |
| `getDominantPattern` | `{ rootDir, dimension }` | the repo's majority pattern for a dimension + example files |
| `checkFileDrift` | `{ rootDir, filePath }` | whether a file fits the repo's patterns, with deviations |
| `findSimilarFunction` | `{ rootDir, body, deep? }` | existing functions that already do the same thing |
| `validateChange` | `{ rootDir, targetPath, body, deep? }` | whether a proposed function would drift or duplicate |

`dimension` is one of: `error_handling`, `imports`, `exports`, `async`, `naming`,
`data_access`, `logging`, `auth` (exported as `DIMENSIONS`).

Every result carries a `status` (`ok` / `partial` / `stale` / `no_baseline` /
`degraded`). Tools never throw to signal "no data"; on a fresh repo with no
baseline yet they return `status: "no_baseline"` with a message telling you to run
`vibedrift` once. The optional `deep: true` checks are metered and degrade
gracefully (`status: "degraded"`) when offline or signed out, so they never error
the caller.

## Example: prevent a duplicate before writing it

```ts
import { findSimilarFunction, validateChange } from "@vibedrift/cli/tools";

const rootDir = process.cwd();

// Before writing a new function:
const similar = await findSimilarFunction({ rootDir, body: proposedBody });
if (similar.found) {
  // reuse/extend similar.matches[0] instead of writing a third copy
}

// After writing it, before committing:
const verdict = await validateChange({ rootDir, targetPath: "src/handlers/order.ts", body: proposedBody });
if (!verdict.ok) {
  // verdict.conflicts[] = new drift; verdict.duplicateOf[] = near-clones
}
```

## The deep-scan nudge as data

Write-time results can carry an optional `nudge` (a deep-scan offer) when a lot
has changed since the last AI deep scan. It is plain data, so any channel surfaces
it its own way. Run the channel-neutral finalize to attach it:

```ts
import { validateChange, finalizeResult } from "@vibedrift/cli/tools";

const out = await finalizeResult(
  await validateChange({ rootDir, targetPath, body }),
  { nudge: true },
);
if (out.nudge) {
  // relay out.nudge.message to the user as a yes/no offer
}
```

The nudge is gated (signed in, sustained activity, cooldown), so it is rare by
design. The billing for a deep scan is owned by the API and the `--deep` CLI flag;
this is only the in-loop offer surface.

## Types and stability

The functions are stable. Type declarations are not yet published in the package
(the build emits JavaScript only); for now, treat the args/returns above as the
contract. TypeScript callers get full inference when importing from source.

This is the same API the MCP server, the Agent Skill, and the git hook all use. If
you are building a new integration channel, import this rather than re-implementing
any of the analysis.
