---
name: vibedrift-drift-check
description: Use when writing or changing code in an existing repository to keep new code consistent with the repo's own conventions and avoid duplicating code that already exists. Checks a proposed function against the repo's dominant patterns and existing functions BEFORE it lands, turning drift detection into drift prevention. Works with or without the VibeDrift MCP server.
---

# VibeDrift drift check

Keep new code coherent with the codebase it is joining. Before a function is
written or finalized, check it against the repo's *own* conventions and its
existing functions, so the new code matches the first time instead of being
flagged in a later review.

This is the same engine as the VibeDrift MCP server, reached through a small
command so it works even when no MCP server is connected.

## When to run each check

- **At the start of a task** in an unfamiliar repo: load the declared conventions
  and the dominant patterns, then write code that matches them.
  - `intent` — the team's declared rules (`CLAUDE.md` / `AGENTS.md` / `.cursorrules`).
  - `dominant --dimension <name>` — the repo's majority pattern for a dimension
    (`async`, `imports`, `exports`, `naming`, `error_handling`, `data_access`,
    `logging`, `auth`).
- **Before writing a new function**: `find-similar` — if the repo already has one
  that does the same thing, extend or reuse it instead of writing a duplicate.
- **After writing a function, before committing it**: `validate-change` — does it
  introduce drift (wrong async style, wrong data-access pattern, ...) or duplicate
  an existing function? If `ok` is false, fix it now.
- **Before editing an existing file**: `check-file` — see where that file already
  deviates so you do not copy a non-dominant pattern.

## How to run it

Prefer the VibeDrift MCP tools if they are connected (`get_intent_hints`,
`get_dominant_pattern`, `find_similar_function`, `validate_change`,
`check_file_drift`). Otherwise run the bundled command. The function body is read
from stdin, so multi-line source pipes in cleanly:

```bash
# Before writing a new function — is there already one like it?
printf '%s' "$PROPOSED_BODY" | node scripts/vibedrift-tools.mjs find-similar --root .

# After writing it — would it drift or duplicate?
printf '%s' "$PROPOSED_BODY" | node scripts/vibedrift-tools.mjs validate-change --root . --file src/handlers/order.ts

# Learn the repo's convention for a dimension before you start
node scripts/vibedrift-tools.mjs dominant --root . --dimension async
```

(If `@vibedrift/cli` is installed globally you can also run the same checks with
`npx @vibedrift/cli` over MCP; the command above uses the local runner so the
skill is self-contained.)

## Reading the result

The command prints JSON.

- `validate-change`: act when `ok` is `false`. `conflicts[]` lists each dimension
  where the change deviates, with `dominantPattern` (what the repo does),
  `yourPattern` (what the change does), and a `fixHint`. `duplicateOf[]` lists
  existing functions the change would clone — reuse one instead.
- `find-similar`: act when `found` is `true`; `matches[]` are the existing
  functions, with file, name, line, and similarity.
- `check-file`: act when `fits` is `false`; `deviations[]` shows where the file
  departs from the repo's dominant pattern.
- `status: "no_baseline"` means the repo has not been indexed yet. Run `vibedrift`
  once in the repo (one-time, then cached), or just call again — the first call
  builds the baseline automatically.

If the result includes a `nudge`, relay its `message` to the user as a simple
yes/no offer (it is an occasional suggestion to run a deeper AI scan; never block
on it).

## Notes

- Local and free: the base checks run on the machine and send no code. The
  optional `--deep` flag on `find-similar` / `validate-change` adds an AI pass and
  requires `vibedrift login`; it degrades gracefully when offline.
- Only flag real deviations from the repo's *own* dominant pattern. A file is not
  wrong for using raw SQL; it is *drifting* when the rest of its siblings use a
  repository and it does not.
