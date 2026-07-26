#!/usr/bin/env bash
#
# Native Drift Sessions — end-to-end sandbox self-test.
#
# Drives the WHOLE native pipeline against the local dev stack, with zero risk
# to production (VIBEDRIFT_HOME + VIBEDRIFT_API_URL are redirected to the
# sandbox), and verifies the round-trip:
#
#   vibedrift enable  ->  hooks installed + activation recorded
#   SessionStart hook ->  activation nudge injected
#   edit hooks        ->  events captured to the local ledger
#   Stop hook         ->  detached session-flush uploads to the local API
#   GET /v1/sessions  ->  the session shows up on the (dashboard) read path
#   GET /v1/sessions/rollup -> engaged / self_corrected metrics present
#
# Prereqs: the local stack is up (API on :8000 on feat/native-sessions-api, its
# Supabase, and the seeded dev tokens). Run `npm run build` first (this script
# will build if dist/ is missing).
#
# Usage:
#   bash scripts/native-sessions-e2e.sh
#   VD_API_URL=http://localhost:8000 VD_TOKEN=vd_live_dev_pro_0000000000000000000 bash scripts/native-sessions-e2e.sh
set -euo pipefail

API_URL="${VD_API_URL:-http://localhost:8000}"
TOKEN="${VD_TOKEN:-vd_live_dev_pro_0000000000000000000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/cli/index.js"
HOOK="$ROOT/dist/session/hook-entry.js"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---- preflight -------------------------------------------------------------
step "Preflight"
[ -f "$HOOK" ] || { echo "  building dist…"; (cd "$ROOT" && npm run build >/dev/null); }
[ -f "$HOOK" ] || fail "dist not built"
code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$API_URL/health" || true)
[ "$code" = "200" ] || fail "local API not healthy at $API_URL (got $code) — bring the dev stack up first"
code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' -X POST "$API_URL/v1/sessions/ingest" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"events":[]}' || true)
[ "$code" = "200" ] || fail "seeded token rejected by ingest (got $code) — reseed the dev stack"
pass "local stack healthy, token accepts ingest"

# ---- isolated sandbox ------------------------------------------------------
SB="$(mktemp -d)"; REPO="$(mktemp -d)"
export VIBEDRIFT_HOME="$SB"
export VIBEDRIFT_API_URL="$API_URL"
trap 'rm -rf "$SB" "$REPO"' EXIT
mkdir -p "$REPO/.git" "$REPO/.claude" "$SB"
printf '{"token":"%s","plan":"pro","apiUrl":"%s","sessionsSyncEnabled":true}\n' "$TOKEN" "$API_URL" > "$SB/config.json"
SID="e2e-$$-$(date +%s)"
pass "sandbox home=$SB  repo=$REPO  session=$SID"

hook() { echo "$1" | node "$HOOK" 2>/dev/null || true; }

# Build + fire a PostToolUse Write edit; content is passed as argv so quotes in
# the code never break the JSON payload.
edit_hook() {
  python3 -c "import json,sys;print(json.dumps({'session_id':'$SID','cwd':'$REPO','hook_event_name':'PostToolUse','tool_name':'Write','tool_input':{'file_path':sys.argv[1],'content':sys.argv[2]}}))" "$1" "$2" \
    | node "$HOOK" 2>/dev/null || true
}

# ---- enable ----------------------------------------------------------------
step "1. vibedrift enable (typed consent = active + hooks)"
node "$CLI" enable "$REPO" >/dev/null 2>&1 || fail "enable failed"
[ -f "$REPO/.claude/settings.local.json" ] || fail "hooks not installed"
grep -q '"state": "active"' "$SB/activation.json" || grep -q '"state":"active"' "$SB/activation.json" || fail "activation not recorded active"
pass "hooks installed, activation = active"

# ---- SessionStart nudge (an already-active repo stays silent) --------------
step "2. SessionStart nudge"
NEWREPO="$(mktemp -d)"; mkdir -p "$NEWREPO/.git"
out="$(hook "{\"session_id\":\"$SID-x\",\"cwd\":\"$NEWREPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")"
echo "$out" | grep -q "NOT active" || fail "un-activated repo did not get the nudge"
pass "un-activated repo nudged"
out="$(hook "{\"session_id\":\"$SID\",\"cwd\":\"$REPO\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")"
[ -z "$out" ] || fail "activated repo should stay silent, got: $out"
pass "activated repo silent"
rm -rf "$NEWREPO"

# ---- capture a turn: prompt + a diverging edit + a fixing edit -------------
step "3. Capture a turn (prompt, flagged edit, resolving edit)"
printf -- '- Async: use async/await throughout. No .then() chains.\n' > "$REPO/CLAUDE.md"
mkdir -p "$REPO/src"
for n in a b c; do printf 'export async function %s(){ return await fetch("/%s"); }\n' "$n" "$n" > "$REPO/src/$n.ts"; done
# build a baseline so the drift check has something to compare against
node "$CLI" "$REPO" --local-only --format terminal >/dev/null 2>&1 || true
hook "{\"session_id\":\"$SID\",\"cwd\":\"$REPO\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"add a report loader\"}"
# a .then() edit trips the async-consistency flag
edit_hook "$REPO/src/report.ts" 'export function loadReport(id){ return fetch("/r/"+id).then(r=>r.json()).then(d=>d.rows); }'
# fix it to async/await -> resolves
edit_hook "$REPO/src/report.ts" 'export async function loadReport(id){ const r = await fetch("/r/"+id); const d = await r.json(); return d.rows; }'
LEDGER="$(find "$SB/sessions" -name "$SID.jsonl" 2>/dev/null | head -1)"
[ -n "$LEDGER" ] && [ -f "$LEDGER" ] || fail "no ledger written"
grep -q '"type":"edit"' "$LEDGER" || fail "no edit event captured"
pass "ledger captured $(wc -l < "$LEDGER" | tr -d ' ') events (prompt, edits, flags/resolves)"
grep -q 'loadReport' "$LEDGER" && fail "edit BODY leaked into the ledger (privacy)" || pass "no edit body in the ledger"

# ---- Stop hook -> detached flush -> upload ---------------------------------
step "4. Stop hook spawns the flush -> upload to the local API"
hook "{\"session_id\":\"$SID\",\"cwd\":\"$REPO\",\"hook_event_name\":\"Stop\"}"
found=""
for i in $(seq 1 40); do
  sleep 0.25
  resp="$(curl -s -m 3 "$API_URL/v1/sessions?limit=200" -H "Authorization: Bearer $TOKEN" || true)"
  if echo "$resp" | grep -q "$SID"; then found=1; break; fi
done
[ -n "$found" ] || fail "session $SID never appeared on GET /v1/sessions (flush/upload failed)"
pass "session reached the API read path (dashboard would see it)"

# ---- rollup metrics --------------------------------------------------------
step "5. Rollup KPIs (engaged / self_corrected split)"
roll="$(curl -s -m 3 "$API_URL/v1/sessions/rollup" -H "Authorization: Bearer $TOKEN" || true)"
echo "$roll" | grep -q '"engaged"' || fail "rollup missing engaged metric"
echo "$roll" | grep -q '"self_corrected"' || fail "rollup missing self_corrected metric"
pass "rollup carries the engaged + self_corrected split"
echo "  rollup: $roll"

step "E2E PASSED — native capture → flush → API → dashboard read path is live."
