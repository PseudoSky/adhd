#!/usr/bin/env python3
"""
check_disposition.py — no dangling initiative artifact (Plan 9 [dod.4]).

The initiative left design/demo artifacts under docs/plan/agent-registry/ (SPEC,
DEMO, GOAL, COVERAGE, demo/, ledgers, orchestration-ledger). Closeout requires
every one to be either TRACKED (committed) or explicitly listed in CLOSEOUT.md's
disposition table (relocated/removed-on-purpose). This script fails if any
untracked file under docs/plan/agent-registry/ is NOT named in the disposition
table — i.e. a dangling thread.

Pre-execution (CLOSEOUT.md not yet written) the gate is informational: it prints
the current untracked set so the closeout author can build the disposition table,
and passes (the artifact-cleanup state owns producing the table). Once CLOSEOUT.md
exists, every untracked file must appear in it.

Exit 0 = clean / vacuous. Exit 1 = a dangling untracked artifact.
"""

import os
import subprocess
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
SCOPE = "docs/plan/agent-registry"
CLOSEOUT = os.path.join(REPO_ROOT, SCOPE, "CLOSEOUT.md")


def run(cmd):
    p = subprocess.run(cmd, shell=True, cwd=REPO_ROOT, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip()


def untracked_under_scope():
    code, out = run(f"git status --porcelain --untracked-files=all -- {SCOPE}")
    files = []
    if code == 0 and out:
        for ln in out.splitlines():
            status, path = ln[:2], ln[3:].strip()
            if "?" in status:  # untracked
                files.append(path)
    return files


def main():
    untracked = untracked_under_scope()
    if not os.path.exists(CLOSEOUT):
        if untracked:
            print("INFO check_disposition: CLOSEOUT.md not yet written; current untracked artifacts to disposition:")
            for f in untracked:
                print(f"    {f}")
        print("PASS check_disposition: pre-execution (artifact-cleanup state owns the disposition table)")
        return 0
    table = open(CLOSEOUT, encoding="utf-8").read()
    dangling = []
    for f in untracked:
        base = os.path.basename(f.rstrip("/"))
        if f not in table and base not in table:
            dangling.append(f)
    if dangling:
        print("FAIL check_disposition: untracked initiative artifact(s) absent from CLOSEOUT disposition table:")
        for f in dangling:
            print(f"    {f}")
        return 1
    print(f"PASS check_disposition: {len(untracked)} untracked artifact(s) all accounted for in CLOSEOUT.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
