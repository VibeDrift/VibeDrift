#!/usr/bin/env python3
"""Recall probe — step 3 (judge + estimate recall).

Judge each sampled pair with the PRODUCTION judge (claude-sonnet-4-6 + the
verbatim deep-scan SYS prompt) — the SAME judge that measured precision, so the
recall number is apples-to-apples. Then estimate stratified recall:

    recall = sum_{cos>=0.72} p_b * N_b  /  sum_{all bands} p_b * N_b

where N_b is the band population (real cross-file pairs in that cosine band) and
p_b is the measured true-duplicate rate in that band. The bands below 0.72 are
the pairs the production candidate gate drops before Claude — real duplicates
there are pure recall loss.

Reads:  eval/recall/<repo>.pairs.json, <repo>.bands.json
Writes: eval/recall/<repo>.verdicts.json
Key:    ANTHROPIC_API_KEY from vibe-drift-api/.env
"""
import json, os, sys, time, math, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = os.path.join(HERE, "..", "..", "..", "vibe-drift-api", ".env")
MODEL = "claude-sonnet-4-6"  # production deep-scan judge

# NARROW = verbatim production prompt (corpus/calibration/label.py:claude_judge).
SYS_NARROW = ("You judge whether two code functions are SEMANTIC DUPLICATES: they do essentially "
              "the same job (same purpose and logic), such that one could replace the other. "
              "Superficial similarity (shared idioms, similar names) is NOT duplication. "
              "Answer with exactly 'YES' or 'NO' on the first line, then one short line why.")

# BROAD = the "redundant reimplementation / drift" lens VibeDrift wants to sell.
# Tests whether the narrow definition is what's hiding drift: a maintainer would
# want ONE shared implementation, even if the two are written differently.
SYS_BROAD = ("You judge whether two functions are REDUNDANT REIMPLEMENTATIONS: they address the "
             "same responsibility or solve the same sub-problem, such that a maintainer would "
             "likely want ONE shared implementation instead of two — EVEN IF the code is written "
             "differently or the logic differs in detail (copy-then-diverge, parallel solutions to "
             "the same concept, and near-duplicates all count). Generic shared idioms (logging, "
             "null/empty checks, trivial getters/setters, test scaffolding) do NOT count. "
             "Answer with exactly 'YES' or 'NO' on the first line, then one short line why.")

MODE = sys.argv[2] if len(sys.argv) > 2 else "narrow"
SYS = SYS_BROAD if MODE == "broad" else SYS_NARROW
OUT_SUFFIX = "verdicts_broad" if MODE == "broad" else "verdicts"


def load_key():
    with open(ENV) as f:
        for line in f:
            if line.startswith("ANTHROPIC_API_KEY"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no ANTHROPIC_API_KEY")


KEY = load_key()


def call(pair, retries=3):
    a, b = pair["fnA"]["body"][:1800], pair["fnB"]["body"][:1800]
    user = (f"Function A ({pair['fnA']['name']}):\n```\n{a}\n```\n\n"
            f"Function B ({pair['fnB']['name']}):\n```\n{b}\n```\n\nSemantic duplicates? YES or NO.")
    body = json.dumps({"model": MODEL, "max_tokens": 60, "system": SYS,
                       "messages": [{"role": "user", "content": user}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
        headers={"x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
            text = "".join(p.get("text", "") for p in data.get("content", [])).strip()
            return {**meta(pair), "isDuplicate": text.upper().lstrip().startswith("Y"), "raw": text[:200]}
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 529) and attempt < retries:
                time.sleep(2 * (attempt + 1)); continue
            return {**meta(pair), "isDuplicate": None, "raw": f"HTTP {e.code}: {e.read()[:160]}"}
        except Exception as e:
            if attempt < retries:
                time.sleep(2 * (attempt + 1)); continue
            return {**meta(pair), "isDuplicate": None, "raw": f"ERR {e}"}


def meta(p):
    return {k: p[k] for k in ("id", "band", "cosine", "struct", "isCandidate", "autoConfirm")} | \
           {"fnA": p["fnA"]["name"], "fnB": p["fnB"]["name"],
            "pathA": p["fnA"]["path"], "pathB": p["fnB"]["path"]}


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (p, max(0, c - h), min(1, c + h))


def main():
    repo = sys.argv[1]
    pairs = json.load(open(os.path.join(HERE, f"{repo}.pairs.json")))
    bands = json.load(open(os.path.join(HERE, f"{repo}.bands.json")))
    pop = {b["band"]: b["population"] for b in bands["bands"]}
    is_cand = {b["band"]: b["isCandidate"] for b in bands["bands"]}
    print(f"judging {len(pairs)} pairs with {MODEL} ...", file=sys.stderr)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=6) as ex:
        verdicts = list(ex.map(call, pairs))
    json.dump(verdicts, open(os.path.join(HERE, f"{repo}.{OUT_SUFFIX}.json"), "w"), indent=2)
    ok = [v for v in verdicts if v["isDuplicate"] is not None]
    errs = len(verdicts) - len(ok)
    print(f"done in {time.time()-t0:.0f}s | {len(ok)} judged, {errs} errors\n", file=sys.stderr)

    # Per-band true-duplicate rate.
    print(f"=== {repo} [{MODE.upper()} definition]: true-duplicate rate by cosine band (floor = 0.72) ===")
    rate = {}
    for b in bands["bands"]:
        lab = b["band"]
        s = [v for v in ok if v["band"] == lab]
        n = len(s); k = sum(1 for v in s if v["isDuplicate"])
        p, lo, hi = wilson(k, n)
        rate[lab] = p
        tag = "CANDIDATE" if is_cand[lab] else "DROPPED  "
        print(f"  {lab:7s} [{b['lo']:.2f},{b['hi']:.2f}) {tag} "
              f"true-dup {p*100:5.1f}% ({k}/{n}) CI[{lo*100:.0f},{hi*100:.0f}]  "
              f"band-pop={pop[lab]:6d}  est-real-dups={p*pop[lab]:8.0f}")

    # Stratified recall estimate.
    real_cand = sum(rate[b] * pop[b] for b in rate if is_cand[b])
    real_all = sum(rate[b] * pop[b] for b in rate)
    recall = real_cand / real_all if real_all else 0.0
    print(f"\nestimated REAL dup pairs surfaced (cos>=0.72): {real_cand:9.0f}")
    print(f"estimated REAL dup pairs total (all sampled bands): {real_all:9.0f}")
    print(f"==> DUPLICATION RECALL ~= {recall*100:.1f}%  "
          f"(missed ~{(real_all-real_cand):.0f} real dup pairs below the floor)")
    print("\nNote: bands below cos 0.32 are assumed ~0 true-rate; if B_032 shows a "
          "nonzero rate, true recall is even lower than this estimate.")

    # The recall-critical examples: pairs Claude calls duplicates BELOW the floor.
    missed = [v for v in ok if v["isDuplicate"] and not v["isCandidate"]]
    print(f"\n=== {len(missed)} sampled DROPPED pairs Claude judged REAL duplicates "
          f"(drift we never surface) ===")
    for v in sorted(missed, key=lambda x: -x["cosine"])[:20]:
        print(f"  cos={v['cosine']:.3f} struct={v['struct']:.3f} [{v['band']}]  "
              f"{v['fnA']}  ==  {v['fnB']}")
        print(f"      {v['pathA']}\n      {v['pathB']}")


if __name__ == "__main__":
    main()
