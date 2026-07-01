# P0.0 Paid-Deep Value Test — raw results

Date: 2026-06-29T15:58:24.175Z
Mode: DEEP (metered)

Honesty note: `droppedCount` is the PRE-LLM embedding-confidence/quota drop
(src/cli/commands/scan.ts:338), NOT the count of false alarms the LLM suppressed.
The true LLM-suppression count is only in the API server logs.

```
repo         deepOnly  dup intent anom dropped localComp deepComp
malware-analysis        0    0      0    0       0      64.1     75.6
JSONSchemaDiscovery        3    1      1    1       0        74     75.6
frontend-service       16    0      0   16       0        85     84.8
```

Cross-check: localMlFindings should be 0 for every repo. Actual: malware-analysis=0, JSONSchemaDiscovery=0, frontend-service=0

Labeling sheet: /Users/samiahmadkhan/workspace/Vibestack/vibedrift-public/eval/deep-value/out/labeling-sheet-messy3.jsonl (19 deep-only findings to label keep/discard).
Next: blind keep/discard pass, then the go/no-go is computed on KEPT counts.
GO if median kept deep-only >= 3/repo or median keep rate >= 40%; NO-GO if median < 1.
