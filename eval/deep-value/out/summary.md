# P0.0 Paid-Deep Value Test — raw results

Date: 2026-06-29T15:39:09.388Z
Mode: DEEP (metered)

Honesty note: `droppedCount` is the PRE-LLM embedding-confidence/quota drop
(src/cli/commands/scan.ts:338), NOT the count of false alarms the LLM suppressed.
The true LLM-suppression count is only in the API server logs.

```
repo         deepOnly  dup intent anom dropped localComp deepComp
remeda              8    3      1    4       0      76.2     75.9
yt-dlp             11    0      2    9       0      59.8     71.5
rustdesk            5    0      1    4       3      83.4     89.9
```

Cross-check: localMlFindings should be 0 for every repo. Actual: remeda=0, yt-dlp=0, rustdesk=0

Labeling sheet: /Users/samiahmadkhan/workspace/Vibestack/vibedrift-public/eval/deep-value/out/labeling-sheet.jsonl (24 deep-only findings to label keep/discard).
Next: blind keep/discard pass, then the go/no-go is computed on KEPT counts.
GO if median kept deep-only >= 3/repo or median keep rate >= 40%; NO-GO if median < 1.
