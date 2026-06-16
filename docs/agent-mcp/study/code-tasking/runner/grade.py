#!/usr/bin/env python3
"""Grade a runs.<label>.jsonl against each scenario's rubric signals.

Signal checks have TEETH: each is a mechanism the correct answer MUST contain
(per scenarios/<slug>.md). A run PASSES only if every signal for its scenario is
present. These are conservative proxies for the manual rubric — a CHECK means
"inspect by hand", not necessarily a fail. Usage:

    python3 grade.py <label>        # reads results/runs.<label>.jsonl
    python3 grade.py --all          # grades every results/runs.*.jsonl

Writes results/grades.<label>.json and prints a per-test table.
"""
import json, re, sys, glob, os

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "..", "results")

def sig_fk(t):
    return [
        ("names PRAGMA-no-op-in-transaction cause",
         bool(re.search(r"no[- ]?op|ignored|silently", t)) and "pragma" in t and "foreign_key" in t
         and bool(re.search(r"transaction|within a tx|inside a tx", t))),
        ("connection-level fix (pragma OFF before migrate, restore after)",
         bool(re.search(r'pragma\(\s*["\']foreign_keys|foreign_keys\s*=\s*off', t))
         and bool(re.search(r"connection|before migrat|sqlite\.pragma|restore|re-?enable|turn .* back", t))),
        ("keeps the cascade (does not weaken it)", "cascade" in t),
    ]

def sig_sse(t):
    return [
        ("identifies async 'error' EventEmitter event (not try/catch)",
         bool(re.search(r"['\"]error['\"]\s*event|error\s*event|emit", t))
         and bool(re.search(r"async|event ?emitter|uncaught|not.*(thrown|try/?catch)|listener", t))),
        ("adds server.on/once('error') handler",
         bool(re.search(r"\.(on|once)\(\s*['\"]error['\"]", t))),
        ("process survives / SSE disabled",
         bool(re.search(r"surviv|keep running|continu|disabled|does ?n.t crash|not crash|stay", t))),
        ("port injectable",
         "port" in t and bool(re.search(r"param|argument|inject|default|= 0|ephemeral", t))),
    ]

def sig_audit(t):
    return [
        ("identifies comment false-match",
         "comment" in t and bool(re.search(r"306|prose|mention|string|prior|earlier line", t))),
        ("fix ignores comments / matches real code",
         bool(re.search(r"strip|skip|ignore|remove comment|not .* comment|actual code|ast|parse|await promise", t))),
    ]

def sig_ephemeral(t):
    return [
        ("zod boolean optional", "boolean" in t and "optional" in t),
        ("query uses is_ephemeral with undefined guard / 0|1",
         "ephemeral" in t and bool(re.search(r"undefined|!== ?undefined|\? ?1 ?: ?0|number\(", t))),
    ]

def sig_portparam(t):
    return [
        ("optional port param, defaulted",
         "port" in t and bool(re.search(r"default|port\s*\?\s*:|port\s*=|sse_port|optional", t))),
        ("existing callers unaffected (taskStore-only still works)", "taskstore" in t),
    ]

def sig_enum(t):
    return [
        ("adds waiting", "waiting" in t),
        ("adds awaiting_input", "awaiting_input" in t),
        ("touches both sites (schema enum + zod)", "enum" in t and ("schema" in t or "z.enum" in t)),
    ]

def sig_ts4023(t):
    return [
        ("explicit type annotation resolving TS4023",
         bool(re.search(r"database\.database|import type|:\s*database", t))),
        ("adds export", "export" in t),
        ("not 'any', not a fabricated type", "any" not in re.findall(r":\s*(\w+)", t) if False else True),
    ]

SIGS = {
    "fk-cascade-migration": sig_fk, "sse-eaddrinuse": sig_sse,
    "audit-ref-policy-comment": sig_audit, "tasklist-ephemeral-filter": sig_ephemeral,
    "sse-port-param": sig_portparam, "task-status-enum-extend": sig_enum,
    "export-sqlite-type-annotation": sig_ts4023,
}

def grade_file(path):
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    # collapse multi-step tests to the final step (the code/answer)
    by_test = {}
    for r in rows:
        by_test.setdefault(r["test"], []).append(r)
    out = []
    for test in sorted(by_test):
        steps = sorted(by_test[test], key=lambda x: x["step"])
        final = steps[-1]
        combined = "\n".join(s["result"] for s in steps).lower()  # judge on all turns
        # A failed task returns a `{task_id,status:"failed",usage}` envelope (no
        # "result" field) — often >200 chars, so detect the status explicitly.
        def is_failed_envelope(txt):
            try:
                o = json.loads(txt)
                return isinstance(o, dict) and o.get("status") == "failed"
            except Exception:
                return False
        errored = (any(s.get("error") for s in steps)
                   or final.get("result_status") == "failed"
                   or is_failed_envelope(final["result"])
                   or len(final["result"]) < 200)
        sigs = SIGS[final["scenario"]](combined) if not errored else []
        passed = (not errored) and all(v for _, v in sigs)
        out.append({"test": test, "scenario": final["scenario"], "tier": final["tier"],
                    "posing": final["posing"], "mode": final["mode"],
                    "verdict": "PASS" if passed else ("ERROR" if errored else "CHECK"),
                    "signals": [{"name": n, "ok": bool(v)} for n, v in sigs],
                    "error": next((s.get("error") for s in steps if s.get("error")), None)})
    return out

def main():
    args = sys.argv[1:]
    labels = []
    if "--all" in args:
        labels = [os.path.basename(p)[len("runs."):-len(".jsonl")]
                  for p in glob.glob(os.path.join(RESULTS, "runs.*.jsonl"))]
    else:
        labels = args
    if not labels:
        print("usage: grade.py <label> | --all"); sys.exit(2)
    for label in labels:
        path = os.path.join(RESULTS, f"runs.{label}.jsonl")
        if not os.path.exists(path):
            print(f"!! no {path}"); continue
        g = grade_file(path)
        json.dump(g, open(os.path.join(RESULTS, f"grades.{label}.json"), "w"), indent=1)
        npass = sum(1 for x in g if x["verdict"] == "PASS")
        ncheck = sum(1 for x in g if x["verdict"] == "CHECK")
        nerr = sum(1 for x in g if x["verdict"] == "ERROR")
        print(f"\n### {label}: {npass} PASS / {ncheck} CHECK / {nerr} ERROR  (of {len(g)})")
        for x in g:
            bad = "" if x["verdict"] == "PASS" else "  <- " + (
                x["error"] if x["error"] else ", ".join(s["name"] for s in x["signals"] if not s["ok"]))
            print(f"  test-{x['test']:>2} [{x['tier'][:4]}] {x['verdict']:5} {x['scenario']:28} {x['posing']}{bad}")

if __name__ == "__main__":
    main()
