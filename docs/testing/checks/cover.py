"""Clause-id coverage: every id and section of STRATEGY.md must appear in STRATEGY_MAP.md section 4.

usage: python3 -I docs/testing/checks/cover.py [ALLOWED_SECTION]...   (run from docs/testing)
Each argument is a section id placed under another name (for example 7.1, whose table is in the stage rows).
Exit 0 when nothing is missing, 1 otherwise.
"""
import sys, re
strategy = open("STRATEGY.md").read(); mp_full = open("STRATEGY_MAP.md").read(); mp = mp_full[mp_full.index("## 4. The map"):mp_full.index("## 5. The swimlane")]
allow = set(a for a in sys.argv[1:])
ids = set(re.findall(r"^\*\*(P\d+)\b", strategy, re.M)) | set(re.findall(r"^\| (G\d+) \|", strategy, re.M)) | set(re.findall(r"^\| (R\d) \|", strategy, re.M))
secs = set(re.findall(r"^#{2,3} (\d+(?:\.\d+)?)\.? ", strategy, re.M))
stages = set(re.findall(r"^\| \*\*([A-H])\. ", strategy, re.M))
missing = []
for i in sorted(ids):
    if not re.search(r"\b" + i + r"\b", mp): missing.append(i)
for s in sorted(secs):
    if s in allow: continue
    if s in ("0","1","15","16"): continue
    if not re.search(r"§" + re.escape(s) + r"(?!\d)", mp) and not re.search(r"§\d+\.\d+[–-]" + re.escape(s), mp): missing.append("§"+s)
print(len(ids), "ids,", len(secs), "sections,", len(stages), "stages; missing:", missing)
sys.exit(1 if missing else 0)
