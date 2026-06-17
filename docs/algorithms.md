# Algorithm audit

Per-algorithm sign-off for every heuristic that contributes to the Vibe
Drift Score. Each section answers four questions:

1. **What it does** — the concrete operation.
2. **Why it's correct** — the guarantee we rely on.
3. **Known limitations** — the cases where it's silent or wrong.
4. **Test coverage** — the files that exercise it.

Reviewers should be able to challenge any threshold or math choice by
starting from this doc. If a claim here is falsified (the guarantee
fails on a new corpus, the limitation bites a real user), update this
doc alongside the fix.

---

## MinHash + LSH similarity

**Where:** `src/codedna/minhash.ts`.
**Used by:** semantic-duplication drift detector, Code DNA duplicate group clustering.

### What it does

Estimates Jaccard similarity between two tokenized, normalized function
bodies without paying the O(n²·m) cost of exact comparison.

Pipeline:

1. **Tokenize** the body. Strip comments. Replace string literals with
   a placeholder. Emit identifier and operator tokens.
2. **Normalize** identifiers. Declared local variables and parameters
   become `ID0`, `ID1`, ... in first-seen order. Call-target chains
   (`db.query(...)`) keep their literal names because the API a
   function calls is architectural signal.
3. **Shingle** the normalized token stream into overlapping k-grams
   (default k=5). The set of shingles is the function's fingerprint.
4. **MinHash** the shingle set: for each of 128 seeded FNV-1a hash
   families, take the minimum hash across all shingles. The 128-element
   signature approximates the shingle set.
5. **LSH banding** (16 bands × 8 rows) for candidate generation. Pairs
   that agree in at least one band become candidates.
6. **LCS verification** on candidates. Exact token-LCS similarity is
   `2·LCS / (|a| + |b|)`, computed in O(|a|·|b|).

### Why it's correct

- **MinHash Jaccard estimate.** For 128 independent hash families,
  `E[estimate] = J(A, B)` and `StdDev ≤ 1/(2·√128) ≈ 0.044`. So the
  estimate is within ~0.09 of true Jaccard 95% of the time. Verified
  empirically in `test/unit/codedna/minhash.test.ts` — the property
  test runs 100 random pairs and fails if more than 5 exceed the bound.
- **LSH collision probability.** For 16 bands × 8 rows, pairs at true
  similarity `s` collide with probability `1 - (1 - s^8)^16`. At
  s = 0.9, catch rate is 99.999%. At s = 0.3, catch rate is 0.02% —
  good rejection of unrelated pairs.
- **LCS verification** is exact. False positives from LSH are removed
  by the O(|a|·|b|) verification step.

### Known limitations

- **Hash family isn't perfectly independent.** Seeded FNV-1a is a
  universal hash family in practice but not theoretically — the
  deviation from ideal is < 1% for our shingle input distribution.
- **Normalization doesn't understand semantics.** Two functions that
  compute the same result via different APIs (e.g. `Array.map` vs a
  for-loop) have different shingle sets and will miss. Deep scan
  catches these via UniXcoder embeddings.
- **Shingle window (k=5) is fixed.** Very short functions (< 5 tokens
  post-normalization) fall back to a single "whole-body" shingle,
  which can over-match trivial snippets.

### Test coverage

- `test/unit/codedna/minhash.test.ts` — 19 tests including the Jaccard
  property test and LSH catch-rate tests.

---

## Semantic fingerprint (FNV-1a + SHA-256 two-pass)

**Where:** `src/codedna/semantic-fingerprint.ts`.
**Used by:** exact-duplicate detection ("these two functions are the
same after normalization").

### What it does

Computes a stable 16-char hex fingerprint for a normalized function
body. First pass is a two-direction FNV-1a over the normalized string
(fast, good distribution, some collisions expected). Second pass is
SHA-256 over the same input, used only to verify groupings produced by
the FNV hash collision check.

### Why it's correct

- **Normalization is deterministic.** Comments stripped, literals
  replaced, whitespace collapsed, variable names mapped to placeholders.
  Empirically verified in the unit tests (20+ cases).
- **Two-pass collision elimination.** FNV's theoretical collision rate
  is ~2^-32 per hash; two-direction combined approaches ~2^-64. On
  1000 structurally-unique synthetic bodies, we observe zero
  cross-group collisions. Verified in
  `test/unit/codedna/semantic-fingerprint.test.ts`.
- **SHA-256 verification** eliminates any surviving FNV collisions.

### Known limitations

- **Cross-language matches can false-positive.** A Python and a Go
  function with identical token counts and nesting shape could produce
  matching fingerprints. Mitigated by: fingerprints are only grouped
  within the same language in the current pipeline (`findDuplicateGroups`).
- **Normalization isn't AST-based.** String-based passes miss some
  structural equivalences (e.g. `return a + b` vs
  `const x = a + b; return x;` — same behavior, different fingerprints).

### Test coverage

- `test/unit/codedna/semantic-fingerprint.test.ts` — 17 tests covering
  empty bodies, identifier renaming, string/number/comment
  normalization, and the 1000-function collision test.

---

## DBSCAN anomaly detection

**Where:** computed server-side in the cloud deep-scan service.
**Used by:** deep-scan anomaly detector.

### What it does

Clusters function embeddings with DBSCAN (density-based spatial
clustering). Functions not assigned to any cluster (DBSCAN label -1)
are reported as outliers. Metric is cosine distance; ε = 0.30 by
default; min_samples = 2.

### Why it's correct

- **DBSCAN** is a standard, well-studied algorithm. Correctness
  depends on ε and min_samples being calibrated to the data
  distribution.
- **Cosine metric** is appropriate for UniXcoder embeddings (direction
  matters, magnitude varies with sequence length).

### Known limitations

- **ε and min_samples are uncalibrated.** Current values (0.30, 2) are
  set by inspection. A server-side calibration harness sweeps ε against
  labeled corpora; until a labeled dataset of ≥ 3 corpora exists, these
  values remain provisional.
- **Assumes functions belong to clusters.** In small directories
  (< 10 functions), DBSCAN often labels everyone as an outlier. The
  deep-scan anomaly detector skips corpora below a size floor.
- **Fixed metric.** Cosine isn't always optimal — for short
  functions, Euclidean on L2-normalized embeddings behaves similarly.
  If the embedding model changes, rerun calibration.

### Test coverage

- Not yet unit-tested server-side.
- Exercised end-to-end by the server-side calibration smoke tests.

---

## Cosine similarity (UniXcoder embeddings)

**Where:** computed server-side in the cloud deep-scan service.
**Used by:** deep-scan duplicate detection, intent-mismatch detection.

### What it does

For duplicate detection: `cosine(emb_a, emb_b)` where each embedding
is a 768-dim UniXcoder output. High similarity (≥ 0.85 by default) →
flagged as semantic duplicate.

For intent mismatch: `cosine(name_embedding, body_embedding)`. Low
similarity (< 0.30 by default) → flagged as mismatch.

### Why it's correct

- **UniXcoder** is trained on code+text pairs; the embedding space
  captures semantic similarity between code snippets. Cosine is the
  natural metric.
- **Normalization guarantee.** All embeddings produced by
  `EmbeddingEngine.embed_batch()` are L2-normalized, so cosine
  similarity is equivalent to the dot product. Range is [-1, 1] but
  in practice for code pairs it stays in [0, 1].
- **NaN handling.** `np.dot / (|u| · |v| + ε)` with ε = 1e-12 avoids
  division by zero for zero-vectors (rare but possible for empty
  bodies after truncation).

### Known limitations

- **Thresholds are uncalibrated.** 0.85 for duplicates, 0.30 for
  intent mismatch — both set by inspection. A server-side calibration
  harness addresses this.
- **Context length.** UniXcoder truncates at 512 tokens. Long
  functions get cut off; the truncated embedding may not reflect
  full semantics.
- **Domain drift.** If the model is fine-tuned or replaced, existing
  thresholds become invalid. Re-run calibration.

### Test coverage

- Exercised end-to-end by the server-side calibration smoke tests.
- Unit tests on the deterministic math (not the model) would be
  straightforward; tracked as follow-up.

---

## Temporal weight decay

**Where:** `src/drift/utils.ts` — `temporalWeight(daysAgo)`.
**Used by:** directory-scoped dominance vote, pivot detection.

### What it does

Given a file's age in days, returns a multiplier applied to its vote:

```
w(d) = 2 · exp(-ln(2) · d / 90)
```

So: 0 days → 2.0×, 90 days → 1.0×, 180 days → 0.5×, 365 days → ~0.12×.
Half-life is 90 days.

### Why it's correct

- **Exponential decay with 90-day half-life** was chosen empirically
  to match typical codebase migration tempos. A 3-month-old refactor
  that shifted the dominant pattern should be fully weighted; a
  9-month-old pattern is half-weight.
- **Continuous and monotonic.** No discontinuities, no ties.
- **Graceful fallback.** When `daysAgo` is null (no git metadata),
  the function returns 1.0 — neutral weight, no temporal signal. This
  preserves pre-temporal-awareness behavior on non-git scans.

### Known limitations

- **Single global constant.** Half-life is 90 days for every
  category. Some dimensions (naming conventions) may change on
  different timescales than others (error-handling strategy).
  Mitigation: the pivot detector flags large temporal shifts as
  legacy-vs-drift rather than relying on continuous weight alone.
- **Git age can lie.** A mass-reformat commit zeros out every file's
  age; a dead file retains its last-modified date forever. The
  dominance vote's entropy gate partially compensates (no dominant
  pattern → no flag).

### Test coverage

- `test/unit/drift/utils.test.ts` covers the math at 0, 90, 180, 365
  days. Property of monotonicity checked over [0, 1000] days.

---

## Dominance vote (Shannon entropy gate)

**Where:** `src/drift/utils.ts` — `buildDirectoryScopedVote`,
`entropyGate`.
**Used by:** every dominance-based drift detector.

### What it does

Within a peer group (directory, scope), count how many files exhibit
each classified pattern. Pick the dominant pattern. If the
distribution is too uniform (high Shannon entropy), emit a
"no convention" info finding instead of flagging deviators.

Entropy:

```
H = −Σ p_i · log₂(p_i)
normalized_H = H / log₂(k)   where k = number of non-zero categories
```

Gate:

- `normalized_H > 0.8` → no convention exists; skip flagging.
- Otherwise → flag minority files with confidence `clamp(1 − H_norm, 0.3, 0.9)`.

### Why it's correct

- **Entropy is the standard measure** of distribution uniformity. At
  H_norm = 0 (all files agree), confidence is highest. At H_norm = 1
  (perfectly uniform), confidence would be 0, so we skip.
- **Threshold at 0.8** was empirically chosen to distinguish "strong
  majority with a few deviators" (H_norm ≈ 0.3-0.5) from "no clear
  majority" (H_norm > 0.8). The calibration is validated by the
  integration tests — a 50/50 split does not emit findings.
- **Tie-breaking.** When two patterns tie in count, the first seen in
  alphabetical file ordering wins. This is arbitrary but deterministic
  across re-scans.

### Known limitations

- **Tiny peer groups.** Minimum group size default = 3. Below that
  we skip the vote entirely. So a lone outlier in a 2-file directory
  isn't flagged, which is usually desired but occasionally wrong.
- **Doesn't weight categories.** A 60/40 naming split and a 60/40
  security-posture split are treated identically by the gate. In
  practice some axes deserve tighter tolerance.

### Test coverage

- `test/unit/drift/utils.test.ts` — dominance math, entropy gate
  thresholds, minimum-group-size floor.
- Directly exercised by all 9 drift-detector integration tests.

---

## Scan-over-scan finding digests (±3 line slop)

**Where:** `src/core/history.ts` — `computeFindingDigest`,
`bucketLine`.
**Used by:** scan-over-scan diff banner, history trend tracking.

### What it does

Produces a stable 16-char hash for a finding that survives
small edits. Key inputs:

- `analyzerId` (literal)
- `file` (literal)
- `bucketLine(line) = floor(line / 3)` — ±1 bucket per 3 lines shifted
- `normalizeMessage(message)` — numbers replaced with `N`

### Why it's correct

- **Line bucketing at N=3** lets findings survive adding or removing
  up to 2 lines above them without losing their key identity. The
  tradeoff: if two findings legitimately land in adjacent buckets,
  they may be treated as one — mitigated by including `analyzerId`
  in the key.
- **Number normalization** handles the common case where a finding's
  message mentions a count ("14 empty catches") that changes run to
  run. Stripping to `N empty catches` keeps the identity stable.
- **Deterministic hash** (SHA-256 truncated to 16 chars) — the same
  input always produces the same key.

### Known limitations

- **Refactors that move code across files lose identity.** Moving a
  function from `src/a.ts` to `src/b.ts` produces a "resolved" in
  a.ts and "new" in b.ts, even though the user moved the same code.
  This is acceptable — the user probably does want to know code
  moved.
- **Large inserts/deletes above a finding** (> 3 lines) shift the
  bucket and produce phantom "new" + "resolved" pairs for the same
  logical finding. Rare in practice; the diff explicitly notes
  "slop window" in its rendered description.

### Test coverage

- `test/unit/output/history-diff.test.ts` — 8 tests including the
  line-slop property, number-normalization, and resolve/new/persistent
  classification.

---

## Adding a new algorithm to this doc

When you add a new heuristic that contributes to a score or a
finding, add a section here with the four standard subsections
(What / Why / Limitations / Tests). If the algorithm has a tunable
threshold, cross-reference the server-side calibration harness.

Reviewers: when reviewing a PR that adds a scoring heuristic, the
PR description should either link to a new section here or
acknowledge why one isn't needed (e.g. "direct passthrough of an
existing primitive, no new tuning").
