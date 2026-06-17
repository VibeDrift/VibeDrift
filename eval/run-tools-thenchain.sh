#!/usr/bin/env bash
# Tools-arm cells on then-chain (the locally-measurable cells): does live
# in-loop tool access recover the cap=2/4 cells where context-injection
# flatlined to 0? Metered. Manual only.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then echo "ERROR: ANTHROPIC_API_KEY is not set in the environment"; exit 1; fi

LOGDIR=eval/reports/_tools
mkdir -p "$LOGDIR"
find eval/reports -maxdepth 1 -name '*.json' | sort > "$LOGDIR/before.txt"

run_cell() {
  EVAL_TASKS=tasks-then.json EVAL_SAMPLE_CAP="$2" EVAL_TRIALS=6 \
    EVAL_CONTROL=none EVAL_TREATMENT=tools EVAL_LABEL="$1" \
    npm run eval > "$3" 2>&1
  echo "[done] $1"
}

echo "Launching then-chain tools cells (cap=4, cap=2) in parallel…"
run_cell "then-chain cap=4 tools" 4 "$LOGDIR/cap4.log" &
run_cell "then-chain cap=2 tools" 2 "$LOGDIR/cap2.log" &
wait
echo "Cells finished."

find eval/reports -maxdepth 1 -name '*.json' | sort > "$LOGDIR/after.txt"
NEW=$(comm -13 "$LOGDIR/before.txt" "$LOGDIR/after.txt")
if [ -z "$NEW" ]; then echo "ERROR: no new reports — check $LOGDIR/*.log"; exit 1; fi
echo "New reports:"; echo "$NEW"
# shellcheck disable=SC2086
npm run eval:analyze -- $NEW 2>&1 | tee "$LOGDIR/summary.txt"
echo "TOOLS-THENCHAIN COMPLETE"
