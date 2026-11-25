#!/usr/bin/env python3
"""Alien-style combination sampling over War's own design atoms.

Mirrors the SELECTION step of alejandrohdez00/alien-space-of-science
(generation/sample.py: _zscore and build_results_payload): every candidate
k-set gets a coherence score and an unavailability score, both are z-scored
over the whole candidate pool, and the fused score is

    (1 - beta) * z(coherence) + beta * z(unavailability),   beta = 0.7

What is NOT the same, and why:
  * Coherence here is a transparent tag-overlap heuristic, not the paper's
    coherence transformer. The released transformer only knows ML-paper atoms.
  * Availability here is "how much of this set does one reference game already
    have" (the paper asks the same of one AUTHOR's repertoire, via a learned
    two-tower model), blended with a hand-estimated commonness prior.
So this is the paper's workflow applied by hand, not the paper's models.

Standard library only. Run:  python3 design/alien/brainstorm.py
"""

import itertools
import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BETA = 0.7
K = 3
TOP_K = 14
MAX_USES = 1


def zscore(xs):
    m = statistics.fmean(xs)
    sd = statistics.pstdev(xs)
    return [0.0] * len(xs) if sd <= 0 else [(x - m) / sd for x in xs]


def pair_coherence(a, b):
    ta, tb = set(a["tags"]), set(b["tags"])
    jac = len(ta & tb) / len(ta | tb)
    # Atoms in the same family reinforce each other; morale/position/terrain
    # are the game's load-bearing pillars, so touching one is a weak bond too.
    pillar = 0.15 if (ta | tb) & {"morale", "position", "terrain"} else 0.0
    return jac + pillar


def coherence(atoms):
    return statistics.fmean(pair_coherence(a, b) for a, b in itertools.combinations(atoms, 2))


def availability(ids, atoms_by_id, refs):
    held = max(len(set(ids) & set(r["atoms"])) / len(ids) for r in refs)
    prior = statistics.fmean(atoms_by_id[i]["commonness"] for i in ids)
    return 0.7 * held + 0.3 * prior


def main():
    data = json.loads((HERE / "atoms.json").read_text())
    atoms = data["atoms"]
    by_id = {a["id"]: a for a in atoms}
    refs = data["references"]

    cands = list(itertools.combinations(sorted(by_id), K))  # exhaustive, like --exhaustive-ks 3
    coh = [coherence([by_id[i] for i in c]) for c in cands]
    unavail = [-availability(c, by_id, refs) for c in cands]
    zc, zu = zscore(coh), zscore(unavail)
    fused = [(1 - BETA) * a + BETA * b for a, b in zip(zc, zu)]

    order = sorted(range(len(cands)), key=lambda i: (-fused[i], cands[i]))
    # ADDED, not in the paper: a plain top-K was eight of the first ten sets
    # drawn from the same three rare atoms. Greedy pass in fused order that lets
    # each atom appear at most MAX_USES times in the shortlist, so the list is a
    # spread of directions rather than one direction restated.
    uses = {}
    picked = []
    for i in order:
        if any(uses.get(a, 0) >= MAX_USES for a in cands[i]):
            continue
        picked.append(i)
        for a in cands[i]:
            uses[a] = uses.get(a, 0) + 1
        if len(picked) == TOP_K:
            break
    out = []
    for rank, i in enumerate(picked, start=1):
        out.append({
            "rank": rank,
            "atom_ids": list(cands[i]),
            "atoms": [by_id[a]["name"] for a in cands[i]],
            "coherence": round(coh[i], 4),
            "unavailability": round(unavail[i], 4),
            "z_coherence": round(zc[i], 3),
            "z_unavailability": round(zu[i], 3),
            "fused": round(fused[i], 3),
        })
    payload = {
        "beta": BETA, "k": K, "candidates": len(cands),
        "fusion_formula": "(1 - beta) * z_coh + beta * z_unavail",
        "top_k_sequences": out,
    }
    (HERE / "results.json").write_text(json.dumps(payload, indent=2) + "\n")
    for r in out:
        print(f'{r["rank"]:>2}  {r["fused"]:+.2f}  coh {r["z_coherence"]:+.2f}  unav {r["z_unavailability"]:+.2f}  ' + " | ".join(r["atoms"]))


if __name__ == "__main__":
    sys.exit(main())
