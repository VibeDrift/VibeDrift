#!/usr/bin/env python3
"""Calibration judge: ask Claude (production prompt + model) whether each harvested
codedna-fingerprint dup-group pair is a REAL semantic duplicate. Produces a measured
PRECISION for the exact-hash detector, with a Wilson 95% CI, overall and by stratum.

Reads:  eval/calibration/pairs.json
Writes: eval/calibration/verdicts.json
Key:    ANTHROPIC_API_KEY from vibe-drift-api/.env
"""
import json, os, re, sys, time, urllib.request, urllib.error, math
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
PAIRS = os.path.join(HERE, "pairs.json")
OUT = os.path.join(HERE, "verdicts.json")
ENV = os.path.join(HERE, "..", "..", "..", "vibe-drift-api", ".env")

MODEL = "claude-sonnet-4-6"  # mirrors corpus deepscan judge + MCP_VALIDATION_MODEL
# Production SYS prompt, verbatim from corpus/calibration/label.py:claude_judge
SYS = ("You judge whether two code functions are SEMANTIC DUPLICATES: they do essentially "
       "the same job (same purpose and logic), such that one could replace the other. "
       "Superficial similarity (shared idioms, similar names) is NOT duplication. "
       "Answer with exactly 'YES' or 'NO' on the first line, then one short line why.")

def load_key():
    with open(ENV) as f:
        for line in f:
            if line.startswith("ANTHROPIC_API_KEY"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no ANTHROPIC_API_KEY")

KEY = load_key()

def call(pair, retries=2):
    a = pair["fnA"]["body"][:1800]
    b = pair["fnB"]["body"][:1800]
    user = (f"Function A ({pair['fnA']['name']}):\n```\n{a}\n```\n\n"
            f"Function B ({pair['fnB']['name']}):\n```\n{b}\n```\n\nSemantic duplicates? YES or NO.")
    body = json.dumps({
        "model": MODEL, "max_tokens": 60, "system": SYS,
        "messages": [{"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body,
        headers={"x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
            text = "".join(p.get("text", "") for p in data.get("content", [])).strip()
            is_dup = text.upper().lstrip().startswith("Y")
            return {**meta(pair), "isDuplicate": is_dup, "raw": text[:200]}
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 529) and attempt < retries:
                time.sleep(2 * (attempt + 1)); continue
            return {**meta(pair), "isDuplicate": None, "raw": f"HTTP {e.code}: {e.read()[:160]}"}
        except Exception as e:
            if attempt < retries:
                time.sleep(2 * (attempt + 1)); continue
            return {**meta(pair), "isDuplicate": None, "raw": f"ERR {e}"}

def meta(p):
    return {k: p[k] for k in ("id", "repo", "repoType", "groupSize", "crossPackage")} | \
           {"fnA": p["fnA"]["name"], "fnB": p["fnB"]["name"]}

def wilson(k, n, z=1.96):
    if n == 0: return (0.0, 0.0, 0.0)
    p = k / n
    d = 1 + z*z/n
    c = (p + z*z/(2*n)) / d
    h = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n)) / d
    return (p, max(0, c-h), min(1, c+h))

def main():
    pairs = json.load(open(PAIRS))
    print(f"judging {len(pairs)} pairs with {MODEL} ...", file=sys.stderr)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=6) as ex:
        verdicts = list(ex.map(call, pairs))
    json.dump(verdicts, open(OUT, "w"), indent=2)
    ok = [v for v in verdicts if v["isDuplicate"] is not None]
    errs = len(verdicts) - len(ok)
    print(f"done in {time.time()-t0:.0f}s | {len(ok)} judged, {errs} errors\n", file=sys.stderr)

    def report(label, subset):
        n = len(subset); k = sum(1 for v in subset if v["isDuplicate"])
        p, lo, hi = wilson(k, n)
        print(f"{label:32s} precision {p*100:5.1f}%  ({k}/{n})  95% CI [{lo*100:.1f}, {hi*100:.1f}]")

    print("=== MEASURED PRECISION of codedna-fingerprint (exact-hash dup groups) ===")
    report("OVERALL", ok)
    print("-- by repo type --")
    for t in ("monorepo", "lib", "app-messy"):
        s = [v for v in ok if v["repoType"] == t]
        if s: report(t, s)
    print("-- by cross-package (boilerplate proxy) --")
    report("cross-package pairs", [v for v in ok if v["crossPackage"]])
    report("same-package pairs", [v for v in ok if not v["crossPackage"]])
    print("-- by repo --")
    from collections import Counter
    for repo in sorted(set(v["repo"] for v in ok)):
        report("  " + repo, [v for v in ok if v["repo"] == repo])

if __name__ == "__main__":
    main()
