# P0.0 Paid-Deep Value Test — Results (2026-06-29)

**Verdict: NO-GO — confirmed across two repo populations (clean OSS + messy low-star). Pending Sami's final spot-check. Combined: 43 deep-only findings across 6 real repos, 0 kept by a blind 2-judge panel.**

## What we ran
Three real, multi-author OSS repos, deep scan vs free local scan:
remeda (TS, `c9feae9f`), yt-dlp (Py, `5678b282`), rustdesk (Rust, `04978140`).
Cross-check held: local-only produced **0** `ml-` findings on all three, so the 24 `ml-`
findings are genuinely deep-only. Spend: ~$0.60 (3 Pro deep-scan allowances).

## Deep-only findings and how the blind panel judged them
Two independent blind judges per finding (a pragmatic senior engineer and a skeptic), each
reading the real code, never shown VibeDrift's own verdict. "Kept" = both judges agree it is a
real, actionable problem a maintainer would fix.

| repo | deep-only | dup/reimpl | intent | anomaly | kept (both) | kept (either) |
|---|---|---|---|---|---|---|
| remeda | 8 | 3 | 1 | 4 | 0 | 0 |
| yt-dlp | 11 | 0 | 2 | 9 | 0 | 1 |
| rustdesk | 5 | 0 | 1 | 4 | 0 | 0 |
| **total** | **24** | **3** | **4** | **17** | **0** | **1** |

Median kept per repo: **0** (both conservative and optimistic). Gate (GO if median >= 3 or keep
rate >= 40%; NO-GO if median < 1): **NO-GO**.

## Why every finding was discarded (the pattern)
- **Duplicates / reimplementation (3):** all were intentionally-parallel APIs that share a small
  internal helper by design (drop vs take, difference vs intersection, dropFirstBy vs takeFirstBy).
  Consolidating them is not what a maintainer would do.
- **Intent "name does not match behavior" (4):** the names were defensible and accurate
  (`ie_key` returns the IE key, `is_elevated`, `incrementalLoad` vs `cleanLoad`). The one
  borderline case (`raise_login_required` has a conditional non-raising path) split the panel.
- **Pattern-outlier anomalies (17):** being structurally unlike peers is not a defect. These were
  legitimately distinct code (a complex core lazy-eval algorithm, a third-party DocSearch wrapper,
  platform-specific Windows API helpers). Not actionable drift.

The damning part is not that deep found nothing. It shipped 24 high-confidence findings and **0**
were actionable on these repos: a precision problem a paying user would feel.

## The big caveat (threat to this conclusion)
All three repos are **mature, human-curated OSS libraries** — arguably the least favorable
population for a drift tool whose real target is **messy, AI-generated** code. This NO-GO is robust
for clean OSS, but the fair confirmatory test is on messy / AI-built repos (VibeDrift's actual
buyer). If deep scan is also near-zero there, NO-GO is locked. If it surfaces real findings there,
the value is population-dependent (keep deep, but target it).

Also: n=3 is a directional gate, not a powered estimate; and the judges are LLMs that can share
blind spots, so the numbers stand on human-validated labels (Sami to spot-check).

## Confirmatory run — messy / low-star repos (2026-06-29)
To answer the "clean OSS may be unfair" caveat, the same test ran on 3 messy low-star OSS
app/service repos (the closest available proxy to AI-built code; the corpus has no labeled
AI-generated set). Picked as the messiest substantial candidates from an 11-repo free triage.

| repo | files | composite | deep-only | kept (both) | kept (either) |
|---|---|---|---|---|---|
| malware-analysis (Py) | 311 | 64.1 | 0 | 0 | 0 |
| JSONSchemaDiscovery (TS) | 110 | 74 | 3 | 0 | 0 |
| frontend-service (TS) | 506 | 85 | 16 | 0 | 0 |
| **total** | | | **19** | **0** | **0** |

Median kept per repo: 0. Verdict: **NO-GO** (unanimous discards, no splits). Notes:
- The messiest repo (malware-analysis) produced **zero** deep-only findings.
- 16 of 19 were `ml-anomaly` "pattern outliers" inside **vendored, minified third-party files**
  (`jquery-3.2.1.min.js`, the Ace editor `ace.js`). That is a precision bug: VibeDrift scanned
  bundled libraries it should ignore.
- The one 100%-identical duplicate (`end()` in two files) was judged idiomatic stream boilerplate
  not worth extracting.

## Combined verdict
Across **both** populations: **43 deep-only findings on 6 real repos, 0 kept** by the blind panel.
Median kept per repo = 0 in each population. Conservative and optimistic gates both = **NO-GO**.
This empirically confirms the 2026-06-19 audit's read that deep scan, as built, is not pay-worthy.

## Two concrete product bugs this surfaced (independent of the strategy call)
1. **Deep scan scans vendored/minified files.** `ml-anomaly` flagged minified jQuery/Ace as
   "pattern outliers." Deep (and ideally all layers) must skip `*.min.js`, bundled vendor libs,
   and `assets/`/`vendor/` third-party code. 16 of 19 messy-run findings were this.
2. **`ml-anomaly` "pattern outlier" is overwhelmingly noise.** 33 of 43 deep-only findings were
   anomalies and the panel kept 0. As a paid signal it is net-negative (it makes deep look worse).
   Suppress it from paid output, or gate it far harder.

## Honest limitations of this test
n=6 repos (directional, not statistically powered); "messy low-star OSS" is a proxy, not verified
AI-generated code; judges are LLMs (consistent and code-grounded, but Sami should spot-check).

## Consequence if confirmed
Per the roadmap's honest fork: drop the deep-scan-headline items (P0.1 visible value, P1.1
recurring audit, P1.2 deep-diff habit as a paid hook), and lead monetization with packaging
(P0.2), retention perks (P2), and the free in-loop moat, treating deep scan as a light add-on.
