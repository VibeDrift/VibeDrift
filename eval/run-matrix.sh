#!/usr/bin/env bash
# Hardened drift-delta matrix — runs all conditions in parallel, then analyzes.
# Metered: makes real Opus calls. Manual only (never CI).
#   bash eval/run-matrix.sh
set -uo pipefail
cd "$(dirname "$0")/.."   # vibe-drift root

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "ERROR: ANTHROPIC_API_KEY is not set in the environment"; exit 1; fi

LOGDIR=eval/reports/_matrix
mkdir -p "$LOGDIR"
find eval/reports -maxdepth 1 -name '*.json' | sort > "$LOGDIR/before.txt"

run_cond() {
  EVAL_TASKS="$2" EVAL_SAMPLE_CAP="$3" EVAL_TRIALS="$4" EVAL_LABEL="$1" \
    npm run eval > "$5" 2>&1
  echo "[done] $1"
}

echo "Launching 5 conditions in parallel (≈620 Opus calls)…"
run_cond "then-chain cap=0" tasks-then.json 0 10 "$LOGDIR/A.log" &
run_cond "then-chain cap=2" tasks-then.json 2 10 "$LOGDIR/B.log" &
run_cond "then-chain cap=4" tasks-then.json 4 10 "$LOGDIR/C.log" &
run_cond "default cap=0"    tasks.json      0 8  "$LOGDIR/D.log" &
run_cond "default cap=3"    tasks.json      3 8  "$LOGDIR/E.log" &
wait
echo "All conditions finished."

find eval/reports -maxdepth 1 -name '*.json' | sort > "$LOGDIR/after.txt"
NEW=$(comm -13 "$LOGDIR/before.txt" "$LOGDIR/after.txt")
if [ -z "$NEW" ]; then echo "ERROR: no new reports produced — check $LOGDIR/*.log"; exit 1; fi
echo "New reports:"; echo "$NEW"
# shellcheck disable=SC2086
npm run eval:analyze -- $NEW 2>&1 | tee "$LOGDIR/matrix-summary.txt"
echo "MATRIX COMPLETE"
