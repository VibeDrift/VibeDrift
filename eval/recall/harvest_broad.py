#!/usr/bin/env python3
"""Broad-precision calibration — step 1 (harvest the broad-YES positives).

Collect every pair the sonnet BROAD judge called a redundant reimplementation
(from <repo>.verdicts_broad.json), re-join FULL bodies from <repo>.functions.json
(the sampled pairs.json bodies were truncated to 1800 chars — too little context
to adjudicate precision), tag each positive shipped-vs-test, and write one
broad_positives.json for the adversarial Opus panel to adjudicate.

Reads:  <repo>.verdicts_broad.json, <repo>.functions.json   (for each repo)
Writes: eval/recall/broad_positives.json
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Repos to harvest broad-YES positives from (argv overrides the default pair).
REPOS = sys.argv[1:] if len(sys.argv) > 1 else ["vibedrift-public", "trpc-trpc"]
OUT_NAME = os.environ.get("BROAD_OUT", "broad_positives.json")
MAX_BODY = 3500

# Verbatim v6 non-shipped regexes (src/scoring/engine.ts) — tag, don't drop.
NOT_SHIPPED = [
    re.compile(r"(^|/)(generated|__generated__)/|\.(generated|gen)\.[A-Za-z0-9]+$|\.pb\.go$|_pb2?\.py$|\.min\.[A-Za-z0-9]+$"),
    re.compile(r"(^|/)(fixtures?|__fixtures__|__mocks__|mocks|snapshots|__snapshots__)/"),
    re.compile(r"(^|/)(tests?|__tests__|spec)/|\.(test|spec)\.[A-Za-z0-9]+$|_test\.(go|py)$|(^|/)test_[^/]*\.py$"),
    re.compile(r"(^|/)(examples?|demos?|samples?)/"),
]
def is_shipped(path: str) -> bool:
    return not any(rx.search(path) for rx in NOT_SHIPPED)


def main():
    out = []
    gid = 0
    for repo in REPOS:
        vf = os.path.join(HERE, f"{repo}.verdicts_broad.json")
        ff = os.path.join(HERE, f"{repo}.functions.json")
        if not (os.path.exists(vf) and os.path.exists(ff)):
            print(f"skip {repo} (missing files)", file=sys.stderr); continue
        verd = json.load(open(vf))
        fns = json.load(open(ff))  # index-aligned with the a,b in the pair id
        pos = [v for v in verd if v.get("isDuplicate")]
        for v in pos:
            # id format from embed_band.py: f"{band}-{a}-{b}", a,b are fn indices
            parts = v["id"].split("-")
            a, b = int(parts[-2]), int(parts[-1])
            fa, fb = fns[a], fns[b]
            shipped = is_shipped(fa["relativePath"]) and is_shipped(fb["relativePath"])
            out.append({
                "gid": f"p{gid}", "repo": repo, "band": v["band"],
                "cosine": v["cosine"], "struct": v["struct"],
                "isCandidate": v["isCandidate"],     # cos>=0.72 (narrow could reach)
                "belowFloor": not v["isCandidate"],  # the NEW reimplementation region
                "bothShipped": shipped,
                "fnA": {"name": fa["name"], "path": fa["relativePath"], "body": fa["body"][:MAX_BODY]},
                "fnB": {"name": fb["name"], "path": fb["relativePath"], "body": fb["body"][:MAX_BODY]},
            })
            gid += 1
    json.dump(out, open(os.path.join(HERE, OUT_NAME), "w"), indent=2)
    # Quick frame summary
    from collections import Counter
    print(f"harvested {len(out)} broad-YES positives -> broad_positives.json", file=sys.stderr)
    print("by repo:", dict(Counter(p["repo"] for p in out)), file=sys.stderr)
    print("below-floor (the NEW reimpl region):", sum(1 for p in out if p["belowFloor"]), file=sys.stderr)
    print("both-shipped:", sum(1 for p in out if p["bothShipped"]), file=sys.stderr)
    print("below-floor AND both-shipped:", sum(1 for p in out if p["belowFloor"] and p["bothShipped"]), file=sys.stderr)


if __name__ == "__main__":
    main()
