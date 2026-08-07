#!/usr/bin/env python3
"""Why each model failed — the reason behind every non-PASS verdict.

Reads results/grades.manual.json (hand-graded; each verdict carries a `note`
explaining the failure) and prints the reasons, grouped by model (default) or by
test. NEAR/PARTIAL are included as near-misses (the note says what was right vs
wrong); FAIL = wrong cause + non-working fix; ERROR = orchestration plumbing.

    python3 runner/failures.py                 # group by model
    python3 runner/failures.py --by-test       # group by test (cross-model)
    python3 runner/failures.py --model haiku    # one model
    python3 runner/failures.py --hard           # only FAIL/ERROR (drop NEAR/PARTIAL)
    python3 runner/failures.py --md             # markdown
"""
import json, os, sys, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
GRADES = os.path.join(HERE, "..", "results", "grades.manual.json")
MODELS = [
    ("gemma_4_e4b", "gemma-4-e4b"),
    ("qwen2.5_14b", "qwen2.5-14b"),
    ("qwen3.5_9b_claude_distill", "qwen3.5-9b"),
    ("qwen3_coder_30b", "qwen3-coder-30b"),
    ("claude_haiku_4_5", "haiku-4.5"),
    ("claude_sonnet_4_6", "sonnet-4.6"),
]
NONPASS = {"FAIL", "ERROR", "NEAR", "PARTIAL"}


def load():
    return json.load(open(GRADES))["tests"]


def wrap(s, indent, width=96):
    pad = " " * indent
    return ("\n").join(textwrap.wrap(s, width=width, initial_indent=pad, subsequent_indent=pad))


def main():
    a = sys.argv[1:]
    md = "--md" in a
    by_test = "--by-test" in a
    hard = "--hard" in a
    only = None
    if "--model" in a:
        only = a[a.index("--model") + 1].lower()
    grades = {"FAIL", "ERROR"} if hard else NONPASS

    tests = load()
    models = [(k, l) for k, l in MODELS if only is None or only in l.lower()]
    out = []
    title = "Failure reasons" + (" (hard fails only)" if hard else "") + " — code-tasking study"
    out.append(f"# {title}" if md else f"\n{title}\n" + "=" * len(title))
    legend = "FAIL = wrong cause + non-working fix · NEAR/PARTIAL = right/working fix, wrong or muddled cause · ERROR = orchestration plumbing (not a coding verdict)"
    out.append(("> " + legend) if md else legend)

    if by_test:
        for t in tests:
            rows = [(l, t[k]["grade"], t[k]["note"]) for k, l in models if t[k]["grade"] in grades]
            if not rows:
                continue
            head = f"T{t['test']} · {t['requires']} · {t['posing']}  (SP: {t.get('system_prompt','')})"
            out.append(("\n### " + head) if md else f"\n{head}")
            for l, g, note in rows:
                if md:
                    out.append(f"- **{l}** — `{g}`: {note or '—'}")
                else:
                    out.append(f"  {l:12} {g:7} {note or '—'}" if len(note or '') < 80
                               else f"  {l:12} {g:7}\n{wrap(note, 23)}")
    else:
        for k, l in models:
            rows = [(t, t[k]["grade"], t[k]["note"]) for t in tests if t[k]["grade"] in grades]
            n_fail = sum(r[1] == "FAIL" for r in rows)
            n_err = sum(r[1] == "ERROR" for r in rows)
            n_near = sum(r[1] in ("NEAR", "PARTIAL") for r in rows)
            summary = f"{n_fail} FAIL · {n_err} ERROR · {n_near} NEAR"
            out.append((f"\n## {l}  ({summary})") if md else f"\n{l}  ({summary})\n" + "-" * 60)
            for t, g, note in rows:
                tag = f"T{t['test']} [{t['requires']}] {t['posing']}  (SP: {t.get('system_prompt','')})"
                if md:
                    out.append(f"- `{g}` **{tag}** — {note or '—'}")
                else:
                    out.append(f"  {g:7} {tag}")
                    out.append(wrap(note or "—", 10))
    print("\n".join(out))


if __name__ == "__main__":
    main()
