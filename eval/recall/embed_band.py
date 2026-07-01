#!/usr/bin/env python3
"""Recall probe — step 2 (embed + band + sample).

Reproduces the PRODUCTION deep-scan candidate-generation path locally:
  - embed function bodies with the corpus Embedder (CodeRankEmbed, mean-pool,
    L2-norm, 512-token truncation, no query prefix) — verbatim prod embedder
  - compute all CROSS-FILE cosine pairs (same-file is Layer 1's job, skipped)
  - the production gate: a pair becomes a Claude candidate iff cosine >= 0.72;
    it auto-confirms (no Claude) iff structural Jaccard >= 0.95

Then it BANDS every cross-file pair by cosine and stratified-samples pairs per
band (with bodies) so Claude can judge the true semantic-duplicate rate in each
band. The bands BELOW 0.72 are the recall question: real duplicates there are
silently dropped before Claude ever sees them.

Reads:  eval/recall/<repo>.functions.json   (from extract.ts)
Writes: eval/recall/<repo>.bands.json       (band populations + the candidate split)
        eval/recall/<repo>.pairs.json       (sampled pairs with bodies, to judge)

Run (api venv has torch/transformers/numpy):
  ../vibe-drift-api/.venv/bin/python eval/recall/embed_band.py <repo>
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "..", "..", "..", "vibedrift-corpus")
sys.path.insert(0, CORPUS)

from corpus.embedder import Embedder            # noqa: E402  prod embedder, verbatim
from corpus.dedup.structural import structural_sim  # noqa: E402  prod struct Jaccard

COS_MED = 0.72      # production cosine floor (api/models/duplicates.py)
STRUCT_HIGH = 0.95  # production auto-confirm Jaccard

# Cosine bands. >=0.72 are production CANDIDATES (Claude sees them); <0.72 are
# the silently-dropped region the recall probe is about. Per-band sample sizes:
# the below-floor bands carry huge populations and dominate the recall
# denominator, so they get far more samples to tighten their CIs (the first
# n=24 pass had near-zero power there).
#   (label, lo, hi, isCandidate, sampleN)
BANDS = [
    ("C_high", 0.85, 1.01, True,  24),  # candidate, high cosine
    ("C_mid",  0.72, 0.85, True,  24),  # candidate, borderline -> Claude
    ("B_062",  0.62, 0.72, False, 60),  # JUST below the floor — the key band
    ("B_052",  0.52, 0.62, False, 60),
    ("B_042",  0.42, 0.52, False, 100), # big population — needs power
    ("B_032",  0.32, 0.42, False, 100), # biggest population — needs power
    ("B_022",  0.22, 0.32, False, 60),  # floor sanity band
]
MAX_BODY = 1800     # trim bodies sent to the judge (matches calibration judge)
SEED = 20260624


def main():
    repo = sys.argv[1]
    fns = json.load(open(os.path.join(HERE, f"{repo}.functions.json")))
    n = len(fns)
    bodies = [f["body"] for f in fns]
    files = [f["file"] for f in fns]
    rels = [f["relativePath"] for f in fns]
    names = [f["name"] for f in fns]
    print(f"{repo}: {n} functions; loading embedder ...", file=sys.stderr)

    # Load from a flat (symlink-dereferenced) model dir to dodge the
    # trust_remote_code-over-symlinked-snapshot loader bug, but reuse the prod
    # Embedder's _normalize_code/_pool/_finalize so the vectors stay identical
    # to production (mean-pool + L2, mask_literals=False).
    import torch
    from transformers import AutoModel, AutoTokenizer
    mdir = os.environ.get("CODERANK_DIR", "/tmp/coderank-flat")
    emb_engine = Embedder()
    emb_engine.tokenizer = AutoTokenizer.from_pretrained(mdir, trust_remote_code=True)
    emb_engine.model = AutoModel.from_pretrained(mdir, trust_remote_code=True)
    emb_engine.embedding_dim = int(getattr(emb_engine.model.config, "hidden_size", 768))
    if torch.backends.mps.is_available():
        emb_engine.device = "mps"; emb_engine.model.to("mps")
    elif torch.cuda.is_available():
        emb_engine.device = "cuda"; emb_engine.model.cuda()
    else:
        emb_engine.device = "cpu"
    emb_engine.model.eval()
    emb_engine.is_loaded = True
    if not emb_engine.is_loaded:
        raise SystemExit("embedder failed to load (torch/transformers/model cache?)")
    print(f"embedder on {emb_engine.device}; embedding {n} bodies ...", file=sys.stderr)
    vecs = emb_engine.embed_batch(bodies, batch_size=32).astype(np.float32)  # (n,768) L2-normed

    # Cosine = dot product (rows already L2-normalised). Upper triangle, cross-file only.
    print("computing cross-file cosine pairs ...", file=sys.stderr)
    file_id = {p: i for i, p in enumerate(sorted(set(files)))}
    fid = np.array([file_id[p] for p in files])
    sims = vecs @ vecs.T  # (n,n)
    iu, ju = np.triu_indices(n, k=1)
    cross = fid[iu] != fid[ju]
    iu, ju = iu[cross], ju[cross]
    cvals = sims[iu, ju]
    total_pairs = len(cvals)
    print(f"{total_pairs} cross-file pairs", file=sys.stderr)

    rng = np.random.default_rng(SEED)
    band_report = []
    sampled = []
    for label, lo, hi, is_candidate, per_band in BANDS:
        sel = np.where((cvals >= lo) & (cvals < hi))[0]
        pop = int(sel.size)
        take = min(per_band, pop)
        pick = rng.choice(sel, size=take, replace=False) if pop else np.array([], dtype=int)
        band_report.append({
            "band": label, "lo": lo, "hi": hi, "isCandidate": is_candidate,
            "population": pop, "sampled": int(take),
        })
        for k in pick:
            a, b = int(iu[k]), int(ju[k])
            ss = structural_sim(bodies[a], bodies[b])
            sampled.append({
                "id": f"{label}-{a}-{b}",
                "band": label, "cosine": round(float(cvals[k]), 4),
                "struct": round(float(ss), 4),
                "isCandidate": is_candidate,
                "autoConfirm": bool(ss >= STRUCT_HIGH),
                "fnA": {"name": names[a], "path": rels[a], "body": bodies[a][:MAX_BODY]},
                "fnB": {"name": names[b], "path": rels[b], "body": bodies[b][:MAX_BODY]},
            })

    # Production candidate accounting (what the deep scan actually surfaces).
    cand_mask = cvals >= COS_MED
    cand_idx = np.where(cand_mask)[0]
    auto = 0
    for k in cand_idx:
        a, b = int(iu[k]), int(ju[k])
        if structural_sim(bodies[a], bodies[b]) >= STRUCT_HIGH:
            auto += 1
    candidates = int(cand_idx.size)

    out = {
        "repo": repo, "functions": n, "crossFilePairs": total_pairs,
        "cosMed": COS_MED, "structHigh": STRUCT_HIGH,
        "candidates": candidates, "autoConfirm": auto, "needsLlm": candidates - auto,
        "bands": band_report,
    }
    json.dump(out, open(os.path.join(HERE, f"{repo}.bands.json"), "w"), indent=2)
    json.dump(sampled, open(os.path.join(HERE, f"{repo}.pairs.json"), "w"), indent=2)

    print("\n=== production candidate accounting ===", file=sys.stderr)
    print(f"cross-file pairs: {total_pairs}", file=sys.stderr)
    print(f"candidates (cos>=0.72): {candidates}  "
          f"[auto-confirm struct>=0.95: {auto} | to-Claude: {candidates-auto}]", file=sys.stderr)
    print("\n=== cosine band populations (cross-file pairs) ===", file=sys.stderr)
    for b in band_report:
        tag = "CANDIDATE" if b["isCandidate"] else "dropped  "
        print(f"  {b['band']:7s} [{b['lo']:.2f},{b['hi']:.2f}) {tag} "
              f"pop={b['population']:7d}  sampled={b['sampled']}", file=sys.stderr)
    print(f"\nwrote {repo}.bands.json and {repo}.pairs.json ({len(sampled)} pairs to judge)", file=sys.stderr)


if __name__ == "__main__":
    main()
