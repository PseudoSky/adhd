"""Name-independence check: prints every backticked agent name found in the given files.

usage: python3 -I docs/testing/checks/names.py [--agents DIR] [--also NAME]... FILE...
Exit 0 when no violation, 1 when any is printed. Agent names are the `id` of every
extensions/agents/*/extension.json under DIR (default ~/dev/ai/sox-ecosystem/extensions/agents);
--also adds names that are planned but have no extension yet. Names that STRATEGY section 2.3
defines as purpose tags are excluded; they are read from that table.
"""
import sys, re, json, glob, os
args = sys.argv[1:]
agents = os.path.expanduser("~/dev/ai/sox-ecosystem/extensions/agents")
also, files = set(), []
i = 0
while i < len(args):
    if args[i] == "--agents": agents = os.path.expanduser(args[i + 1]); i += 2
    elif args[i] == "--also": also.add(args[i + 1]); i += 2
    else: files.append(args[i]); i += 1
here = os.path.dirname(os.path.abspath(__file__))
strategy = open(os.path.join(here, "..", "STRATEGY.md")).read()
sec = strategy[strategy.index("### 2.3"):strategy.index("### 2.4")]
tags = set()
for line in sec.splitlines():
    if line.startswith("|"):
        first = line.split("|")[1]
        tags |= set(re.findall(r"`([a-z][a-z0-9:<>-]*)`", first))
names = {json.load(open(f))["id"] for f in glob.glob(agents + "/*/extension.json")} | also
bad = 0
for f in files:
    for n, line in enumerate(open(f), 1):
        for m in re.finditer(r"`([a-z][a-z0-9-]*)`", line):
            if m.group(1) in names and m.group(1) not in tags:
                print(f"{f}:{n}: agent name `{m.group(1)}`"); bad += 1
print(f"{len(names)} agent names read, {len(tags)} purpose tags excluded, {bad} violations")
sys.exit(1 if bad else 0)
