---
name: setup
description: "One-time VibeDrift setup for this repo: configure excludes, build the drift baseline, write repo context into CLAUDE.md, and optionally enable Drift Sessions. Run once per repo after installing the vibedrift plugin."
disable-model-invocation: true
---

# VibeDrift setup

Run once per repo. Four steps: excludes, baseline + context, Drift Sessions,
wrap-up. Almost all of it is local. The exceptions, so you can answer honestly
if the user asks:

- `npx -y @vibedrift/cli` fetches the package from the npm registry.
- The step 3 scan sends an anonymous beacon (language, file count, LOC, score;
  no paths, no code) unless the user opted out with `vibedrift telemetry
  disable` or `VIBEDRIFT_TELEMETRY_DISABLED=1`.
- If the user is logged in, that same scan also uploads its findings to
  `/v1/scans/log`, and findings keep `locations[].snippet`, which is a real
  line of source. The telemetry opt out does not stop this. Only
  `--local-only`, or staying logged out, does.
- Drift Sessions, once enabled, refresh entitlement from the server when a
  session starts (the `enable` call itself is local).

**Rules for this skill:**

- Do one section at a time. Report, recommend, ask, then act.
- Lead with the recommended answer so the user can say "yes" and move on.
- Never write a file, install a hook, or apply an exclusion the user did not confirm.
- The MCP tools are namespaced by the plugin: `mcp__plugin_vibedrift_vibedrift__init`
  and `..._enable`. If they are not connected, say so and stop — do not hand-write
  `.vibedrift/config.json` or hook entries yourself.

## 1. Survey first — never assume

First determine the repo root: run `git rev-parse --show-toplevel` once and use
that absolute path as `rootDir` for **every** `init` and `enable` call and as the
explicit path argument to the step 3 scan — do not pass `.` or re-derive it per
step (in a monorepo subdirectory, mixing cwd-relative and derived roots splits
the config across different directories). If this is not a git repository, use
the project's top-level directory, and skip the "Commit" half of step 5.

Then check all five, and present one short summary. Do not act on anything yet.

1. `.vibedrift/config.json` — does it exist? (repo already initialized)
2. `.vibedriftignore` — does it exist, and what is in it?
3. `CLAUDE.md` (and `AGENTS.md`) — does either already contain
   `<!-- vibedrift:context:start` ? That is the managed context block.
4. `.claude/settings.local.json` — does any hook command contain `#vibedrift-hook`?
   That means a repo-local Drift Sessions install is here (it takes precedence
   over the plugin's own hooks, which this plugin also ships).
5. Run `claude mcp list` (skip this check if the `claude` CLI is not on PATH or
   the command errors). If it lists a second `vibedrift` server besides the
   plugin's (from the older `claude mcp add vibedrift -- npx -y @vibedrift/cli mcp`),
   tell the user to run `claude mcp remove vibedrift` — the plugin already
   bundles the server, and two copies means duplicate tools in every session.

Summarize as "already done / still to do", then run only the undone steps: skip
step 3 if the managed block already exists (offer a re-run only if the user wants
it refreshed), and skip step 4's offer if the `#vibedrift-hook` entries are
already installed.

## 2. Excludes

Skip if `.vibedrift/config.json` already exists — say so, and only re-run if the
user wants to change the excludes.

Call `init` with `detectOnly: true` and `rootDir` set to the absolute repo root.
This writes nothing. The result's `detected` gives `count` (files that look like
fixtures or generated code) and `globs` (the suggested patterns).

Show the globs, recommend applying them, and ask the user to confirm or edit the
list. Excluded paths stop counting toward the drift score in both the CLI and the
MCP tools, so this is the step that keeps fixtures and generated code from
polluting the baseline.

Then call `init` again to write:

- confirmed the detected list as-is → `applyDetectedExcludes: true`
- edited the list → `exclude: ["<glob>", ...]` (pass exactly what they agreed to)
- wants none → call with neither, which still writes `.vibedrift/config.json`

Optionally pass `failOnScore` (CI score floor) and `format` (default report
format) if the user asks. Report `excludesAdded` and the two file paths.

## 3. Baseline and repo context

Recommend yes — this is what puts the repo's dominant patterns in front of every
future session.

```bash
npx -y @vibedrift/cli <repo-root> --format terminal --write-context --inject-context
```

(`<repo-root>` is the absolute path from step 1 — the same one passed to `init`.)

- `--write-context` writes `.vibedrift/context.md`, `fix-plan.md`,
  `fix-prompts.md`, and `patterns.json`. **It requires a free account.** If the
  command exits with "requires a free account", the default is to re-run with
  `--inject-context` alone — the CLAUDE.md injection is not gated and nothing is
  uploaded. If the user wants the full context files, they can run
  `vibedrift login` (30 seconds, free) — but say at that moment, before they
  log in, that a signed-in scan also uploads its findings, including real
  source-line snippets, to the dashboard (the header's third bullet), and that
  adding `--local-only` keeps a signed-in scan fully offline.
- `--inject-context` upserts a managed block into `CLAUDE.md`, between
  `<!-- vibedrift:context:start ... -->` and `<!-- vibedrift:context:end -->`.
  It targets `CLAUDE.md` only, not `AGENTS.md`. It is idempotent: re-running
  replaces the block in place and never touches the surrounding text.

Tell the user the block is auto-managed — regenerate it by re-running the
command, and do not hand-edit inside it.

## 4. Drift Sessions (offer, never default-on)

Offer it; do not assume yes. Explain honestly, in a few lines:

- The plugin already ships the Claude Code hooks (session start, each prompt,
  after each edit, after each Bash command, session stop); they capture nothing
  until the repo is activated. `enable` records the activation and, because the
  plugin is installed, writes no repo-local hook copy (`hooksVia: "plugin"` in
  the result); a repo-local install that already exists is kept and owns
  capture. Either way the ledger is local and append-only, at
  `~/.vibedrift/sessions/<projectHash>/<sessionId>.jsonl`.
- Recorded: prompts with secrets masked, edit metadata (repo-relative path plus a
  diffstat), drift flags and their outcomes. Never recorded: source code, the diff
  body, the agent's transcript file.
- Sync is off by default. Turning it on later (`vibedrift watch-session --sync on`)
  uploads a derived projection only — findings, outcomes, metadata — never code or
  prompts, with file paths hashed.
- It is a Pro feature with a one-time 5-session free trial; a free account starts it.
- In return, the agent gets a one-line drift advisory in its context the moment an
  edit diverges from the repo's patterns.

**If yes:** call `enable` with `rootDir` and `confirm` set to the user's literal
affirmative. Claude Code will raise its own Allow/Deny prompt — that native prompt
is the real consent gate, so let the user answer it. The result's `action` will be
`enabled`; `hooksInstalled` says whether the hooks landed. (`needs_confirmation`
means `confirm` was missing — ask again, do not retry with invented text.)

**If no:** ask whether to record the decline. `enable` with `decline: true` (no
`confirm` needed) records it so this repo is never asked again, and it is
reversible later. Otherwise just skip — the nudge will come back.

## 5. Wrap up

List what actually changed, then:

- **Commit:** `.vibedriftignore`, `.vibedrift/config.json`, the CLAUDE.md managed
  block, and optionally `.vibedrift/context.md` and the other context files — they
  are meant to be shared so the whole team scans against the same baseline.
- **Do not commit:** `.claude/settings.local.json` (project-local by convention).
  The session ledger lives in `~/.vibedrift/`, outside the repo, so nothing to do
  there.

Close by noting that re-running `/vibedrift:setup` is safe and idempotent — it is
only needed to change these settings, not before each session.
