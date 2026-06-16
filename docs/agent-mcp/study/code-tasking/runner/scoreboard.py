#!/usr/bin/env python3
"""Scoreboard across the full test set for every model in results/grades.manual.json.

Renders: the per-test grade matrix, a weighted score per model
(PASS=1.0, NEAR/PARTIAL=0.5, FAIL/ERROR=0), tallies, and the by-requirement
strict pass-rate. Verdicts are the hand-graded ones in grades.manual.json
(authoritative; the auto-grader in grade.py is only a first pass).

    python3 runner/scoreboard.py            # full board
    python3 runner/scoreboard.py --md       # GitHub-markdown tables (for docs)
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
GRADES = os.path.join(HERE, "..", "results", "grades.manual.json")

WEIGHT = {"PASS": 1.0, "NEAR": 0.5, "PARTIAL": 0.5, "FAIL": 0.0, "ERROR": 0.0}
# model key in each test dict -> display label
MODELS = [
    ("qwen2.5_14b", "qwen2.5-14b"),
    ("qwen3.5_9b_claude_distill", "qwen3.5-9b"),
    ("claude_haiku_4_5", "haiku-4.5"),
    ("claude_sonnet_4_6", "sonnet-4.6"),
]
REQ_ORDER = ["ADDITIVE", "APPLY", "GOTCHA", "DIAGNOSE", "ORCH"]


def load():
    d = json.load(open(GRADES))
    return d["tests"]


def grade(t, key):
    return t[key]["grade"]


def render(md=False):
    tests = load()
    keys = [k for k, _ in MODELS]
    labels = [l for _, l in MODELS]

    def row(cells, sep="|"):
        return f"{sep} " + f" {sep} ".join(cells) + f" {sep}"

    out = []
    title = "Scores across the full test set (4 models)"
    out.append(f"# {title}\n" if md else f"\n{title}\n" + "=" * len(title))

    # ---- per-test matrix ----
    head = ["#", "requires", "SP", "posing"] + labels
    if md:
        out.append(row(head)); out.append(row(["---"] * len(head)))
    else:
        out.append("")
        out.append(f"{'#':>2}  {'requires':9} {'SP':12} {'posing':34} " + " ".join(f"{l:>11}" for l in labels))
        out.append("-" * 132)
    for t in tests:
        cells = [str(t["test"]), t["requires"], t.get("system_prompt", "").split()[0], t["posing"]]
        cells += [grade(t, k) for k in keys]
        if md:
            out.append(row(cells))
        else:
            out.append(f"{t['test']:>2}  {t['requires']:9} {t.get('system_prompt','').split()[0]:12} {t['posing'][:34]:34} "
                       + " ".join(f"{grade(t,k):>11}" for k in keys))

    # ---- scores + tallies ----
    n = len(tests)
    scores, tallies = {}, {}
    for k in keys:
        gs = [grade(t, k) for t in tests]
        scores[k] = sum(WEIGHT.get(g, 0.0) for g in gs)
        tallies[k] = {g: gs.count(g) for g in ["PASS", "NEAR", "PARTIAL", "FAIL", "ERROR"] if gs.count(g)}

    out.append("" if md else "")
    sect = "## Score & tally" if md else "Score & tally  (PASS=1.0  NEAR/PARTIAL=0.5  FAIL/ERROR=0)"
    out.append(sect)
    if md:
        out.append(row(["model", f"score / {n}", "%", "tally"]))
        out.append(row(["---", "---:", "---:", "---"]))
    for k, l in MODELS:
        tally = " · ".join(f"{c} {g}" for g, c in tallies[k].items())
        pct = f"{100*scores[k]/n:.0f}%"
        if md:
            out.append(row([l, f"{scores[k]:.1f}", pct, tally]))
        else:
            out.append(f"  {l:12} {scores[k]:5.1f} / {n}   {pct:>4}   {tally}")

    # ---- by-requirement strict pass-rate ----
    out.append("" if md else "")
    out.append("## Strict PASS-rate by requirement" if md else "Strict PASS-rate by requirement")
    reqs = {}
    for t in tests:
        reqs.setdefault(t["requires"], []).append(t)
    order = [r for r in REQ_ORDER if r in reqs] + [r for r in reqs if r not in REQ_ORDER]
    if md:
        out.append(row(["requires", "n"] + labels))
        out.append(row(["---", "---:"] + ["---:"] * len(labels)))
    else:
        out.append(f"  {'requires':9} {'n':>2}  " + " ".join(f"{l:>11}" for l in labels))
    for r in order:
        ts = reqs[r]
        cells = []
        for k in keys:
            p = sum(grade(t, k) == "PASS" for t in ts)
            cells.append(f"{p}/{len(ts)}")
        if md:
            out.append(row([r, str(len(ts))] + cells))
        else:
            out.append(f"  {r:9} {len(ts):>2}  " + " ".join(f"{c:>11}" for c in cells))

    if md:
        out.append("\n_Weighted score: PASS=1.0, NEAR/PARTIAL=0.5, FAIL/ERROR=0. "
                   "Verdicts are hand-graded (`results/grades.manual.json`); ERROR = orchestration "
                   "plumbing, not a coding verdict._")
    return "\n".join(out)


if __name__ == "__main__":
    print(render(md="--md" in sys.argv[1:]))
