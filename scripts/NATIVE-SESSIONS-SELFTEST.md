# Native Drift Sessions self-test

Everything runs against the **local dev stack** in a throwaway sandbox
(`VIBEDRIFT_HOME` + `VIBEDRIFT_API_URL` are redirected), so nothing touches
production, your real `~/.vibedrift`, or the real dashboard.

## 0. Prereqs

- Local API up on `:8000` (a dev API with the sessions endpoints) + its Supabase +
  seeded dev tokens. (`GET http://localhost:8000/health` → `{"status":"ok"}`.)
- `npm run build` in this repo (the scripts use `dist/`).

## 1. One-command round-trip proof

```bash
npm run build
bash scripts/native-sessions-e2e.sh
```

This drives the whole native pipeline and self-verifies each stage:

1. `vibedrift enable` → hooks installed + activation recorded `active`
2. `SessionStart` hook → activation **nudge** injected in an un-activated repo,
   **silent** in the activated one
3. edit hooks → events captured to the **local ledger** (asserts **no edit body
   leaks** into the ledger)
4. `Stop` hook → detached `session-flush` uploads to the local API
5. `GET /v1/sessions` → the session shows up on the dashboard read path
6. `GET /v1/sessions/rollup` → `engaged` / `self_corrected` split present

Ends in `E2E PASSED`. Any failure prints the exact stage.

## 2. Try it on YOUR OWN repo (interactive)

Point a real sandbox at the local stack, then use Claude Code normally:

```bash
export VIBEDRIFT_HOME="$HOME/.vibedrift-dev"      # sandbox, not the real store
export VIBEDRIFT_API_URL="http://localhost:8000"
mkdir -p "$VIBEDRIFT_HOME"
cat > "$VIBEDRIFT_HOME/config.json" <<EOF
{"token":"vd_live_dev_pro_0000000000000000000","plan":"pro",
 "apiUrl":"http://localhost:8000","sessionsSyncEnabled":true}
EOF

cd /path/to/your/repo
node /path/to/vibedrift-public/dist/cli/index.js enable .   # typed consent
```

Now open Claude Code in that repo and work. Each **turn end** (Stop) flushes to
the dashboard within a couple of seconds, no `watch-session` window needed.
Watch the live tape too if you want: `… dist/cli/index.js watch-session`.

**Seeing it in the dashboard.** The uploaded turns land in the local Supabase
(`session_meta` / `session_events`), confirmed by step-1's `GET /v1/sessions`.
The dashboard reads those tables directly, so to view them run the
`landing-native-sessions` worktree pointed at the **local** Supabase and sign in
as the seeded pro user (dashboard env/auth setup is its own step, outside this
CLI sandbox).

To see the nudge flow instead of pre-enabling: **don't** run `enable`; start a
Claude Code session and the SessionStart hook injects the ask (the model relays
it, you answer yes → it calls the `enable` MCP tool → native Allow/Deny prompt).

## 3. Turn it off

```bash
node …/dist/cli/index.js decline .                  # this repo, permanent
node …/dist/cli/index.js watch-session --uninstall  # remove the hooks entirely
```

Everything above is sandbox-scoped: delete `$VIBEDRIFT_HOME` to reset.
No production surface (npm/Fly/Vercel) is touched by any of this.
