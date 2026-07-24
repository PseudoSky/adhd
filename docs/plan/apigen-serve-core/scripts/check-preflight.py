#!/usr/bin/env python3
"""Guard for py-extract-preflight: red until the findings doc records a DECISION.

Exit 0 iff docs/apigen/proposals/py-extract-serve-split-findings.md exists and
contains a line beginning `DECISION:` (the §8.3 extractor side-effect verdict).
"""
import sys, os
P = "docs/apigen/proposals/py-extract-serve-split-findings.md"
if not os.path.exists(P):
    print("[preflight] findings doc missing", file=sys.stderr); sys.exit(1)
with open(P) as f:
    ok = any(l.startswith("DECISION:") for l in f)
print("[preflight] DECISION line present" if ok else "[preflight] no DECISION line")
sys.exit(0 if ok else 1)
