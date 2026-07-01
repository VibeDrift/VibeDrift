# P0.0 Paid-Deep Value Test — raw results

Date: 2026-06-29T15:53:29.788Z
Mode: NO-DEEP (free plumbing check)

Honesty note: `droppedCount` is the PRE-LLM embedding-confidence/quota drop
(src/cli/commands/scan.ts:338), NOT the count of false alarms the LLM suppressed.
The true LLM-suppression count is only in the API server logs.

```
repo        commit     composite findings ml(expect 0)
frontend-servicedb8b97c3          85      141            0
PlaylistGo  3dbc3084        93.4       34            0
obd-node    c8ca76bf        87.5       14            0
JSONSchemaDiscovery7a683cf7          74       12            0
spaceguard  75092596        97.1       19            0
mondo-api   0be89263        89.8        7            0
todo-ember  7bafcb83        67.3        9            0
malware-analysis3bbd8d52        64.1      785            0
Splithunter 436db7c1        95.7       36            0
Py16        8179a182          92       87            0
kfs         e89035c3        90.4       12            0
```
