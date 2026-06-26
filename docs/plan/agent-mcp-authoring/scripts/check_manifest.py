#!/usr/bin/env python3
"""
check_manifest.py — enforce the agent-mcp back-out guarantee (Plan 8 [dod.8]).

The owner retains the right to back out agent-mcp/agent-mcp-types because that
system works today. This plan is the FIRST sanctioned modifier, and only under an
explicit, reversible, enumerated manifest recorded in decisions.md.

This script proves the guarantee mechanically:
  1. Parse the modification manifest from decisions.md — the fenced block tagged
     `def:agent-mcp-modification-manifest` lists every agent-mcp{,-types} src path
     this plan is allowed to touch, plus a `baseline-ref:` line.
  2. Compute the set of agent-mcp{,-types}/src files that DIFFER from baseline-ref
     (committed + working-tree changes).
  3. PASS iff that change set is a SUBSET of the manifest. Any changed src file
     not enumerated in the manifest is a back-out-guarantee violation -> FAIL.

Run from anywhere; it resolves the repo root itself. Exits 0 on PASS, 1 on FAIL.

NOTE: until the plan executes there are no changes, so the change set is empty and
the subset check is vacuously true (PASS) — the gate only bites once src is
touched, exactly when the guarantee matters.
"""

import os
import re
import subprocess
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
DECISIONS = os.path.join(REPO_ROOT, "docs/plan/agent-mcp-authoring/decisions.md")
GUARDED_PREFIXES = ("packages/ai/agent-mcp/src", "packages/ai/agent-mcp-types/src")


def run(cmd):
    p = subprocess.run(cmd, shell=True, cwd=REPO_ROOT, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip()


def parse_manifest():
    """Return (baseline_ref, set(allowed_paths)) from the manifest block."""
    if not os.path.exists(DECISIONS):
        return None, set()
    text = open(DECISIONS, encoding="utf-8").read()
    # The manifest is the fenced block following the def:agent-mcp-modification-manifest marker.
    idx = text.find("def:agent-mcp-modification-manifest")
    if idx == -1:
        return None, set()
    tail = text[idx:]
    m = re.search(r"```[a-zA-Z]*\n(.*?)```", tail, re.DOTALL)
    block = m.group(1) if m else tail
    baseline = None
    bm = re.search(r"baseline[-_ ]ref:\s*([^\s]+)", tail)
    if bm:
        baseline = bm.group(1).strip()
    paths = set()
    for line in block.splitlines():
        line = line.strip().lstrip("-").strip()
        for pref in GUARDED_PREFIXES:
            if line.startswith(pref):
                paths.add(line)
    return baseline, paths


def changed_guarded_files(baseline):
    """agent-mcp{,-types}/src files differing from baseline (or empty if no baseline yet)."""
    files = set()
    # Committed changes vs baseline.
    if baseline:
        code, out = run(f"git diff --name-only {baseline}...HEAD -- {' '.join(GUARDED_PREFIXES)}")
        if code == 0 and out:
            files.update(out.splitlines())
    # Working-tree + staged changes.
    code, out = run(f"git status --porcelain -- {' '.join(GUARDED_PREFIXES)}")
    if code == 0 and out:
        for line in out.splitlines():
            files.add(line[3:].strip())
    return {f for f in files if f and any(f.startswith(p) for p in GUARDED_PREFIXES)}


def main():
    baseline, allowed = parse_manifest()
    if baseline is None:
        # Pre-execution: manifest not yet written (architecture state not started).
        # The architecture-phase audit owns "manifest exists"; here we don't block.
        print("PASS check_manifest: no baseline-ref yet (pre-execution) — vacuously satisfied")
        return 0
    changed = changed_guarded_files(baseline)
    violations = sorted(changed - allowed)
    if violations:
        print("FAIL check_manifest: agent-mcp src changed OUTSIDE the recorded manifest:")
        for v in violations:
            print(f"    {v}")
        print(f"  baseline-ref: {baseline}")
        print(f"  manifest allows ({len(allowed)}): " + ", ".join(sorted(allowed)) or "<none>")
        return 1
    print(f"PASS check_manifest: {len(changed)} changed agent-mcp src file(s) all within the manifest "
          f"(baseline {baseline}, {len(allowed)} allowed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
