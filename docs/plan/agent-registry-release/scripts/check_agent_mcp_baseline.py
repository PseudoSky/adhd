#!/usr/bin/env python3
"""
check_agent_mcp_baseline.py — the agent-mcp back-out gate for release (Plan 9 [dod.2]).

Gates merge-to-main and is re-run before publish. The owner retains the right to
back out agent-mcp/agent-mcp-types. This gate proves that right is intact at
release time: every change to packages/ai/agent-mcp{,-types}/src between the
pinned pre-initiative baseline and HEAD must have been made by a SANCTIONED
registry-initiative plan. Anything else is a back-out-guarantee violation.

F-P6-6 — the allowed set is the UNION across ALL initiative plans, not "6+8":
  The allowed set is computed as the union of the guarded `…/src` paths each
  registry-initiative plan declares in its plan-index.json `mutate_set`. The
  initiative plan list is read from THIS plan's decisions.md
  (`def:initiative-plans`, R5). This is fail-closed-correct and drift-proof:
    - Plan 6 (agent-mcp-refactor) does NOT touch agent-mcp-types/src — the
      agent-mcp-types/src drift comes from agent-provider. A literal "6+8" union
      would FALSE-FAIL on agent-provider's domain.ts + index.ts; the per-plan
      union over plan-index.json covers them automatically.
    - The pre-registry agent-mcp roadmap (0.0.6, usage-tracking, task-*, hitl,
      parallel) is NOT in the initiative list, so its mutate_sets are NOT allowed.
      Those shipped to main as @adhd/agent-mcp@1.0.1 BEFORE this branch (below
      baseline). If the pinned baseline ever reveals one of them — or anything —
      ABOVE the merge-base and NOT covered by an initiative mutate_set, this gate
      FAILS CLOSED and surfaces it. That is correct, never softened.

Plan 8's own decisions.md modification manifest
(`def:agent-mcp-modification-manifest`) is ALSO folded into the allowed union, so
Plan 8's surface is bounded both here and by Plan 8's own check_manifest.py (dod.8).

The pre-initiative baseline ref is read from this plan's decisions.md
(`agent-mcp-baseline-ref:`). Until decisions.md records it (pre-execution), the gate
is vacuously satisfied — it only bites once a real baseline is pinned and real
changes exist, exactly when the guarantee matters.

Exit 0 = guarantee intact. Exit 1 = drift outside the sanctioned union.
"""

import json
import os
import re
import subprocess
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
DECISIONS = os.path.join(REPO_ROOT, "docs/plan/agent-registry-release/decisions.md")
PLAN8_DECISIONS = os.path.join(REPO_ROOT, "docs/plan/agent-mcp-authoring/decisions.md")
PLAN_INDEX = os.path.join(REPO_ROOT, "docs/plan/plan-index.json")
GUARDED = ("packages/ai/agent-mcp/src", "packages/ai/agent-mcp-types/src")


def run(cmd):
    p = subprocess.run(cmd, shell=True, cwd=REPO_ROOT, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip()


def read_baseline_ref():
    if not os.path.exists(DECISIONS):
        return None
    text = open(DECISIONS, encoding="utf-8").read()
    # Scan ALL `agent-mcp-baseline-ref:` occurrences and take the first that is a
    # PLAUSIBLE git ref. This deliberately skips the R2 heading
    # (``agent-mcp-baseline-ref:`` — captures only the closing backtick) and the
    # `<FILLED AT EXECUTION …>` placeholder, so the gate stays vacuous until a real
    # SHA/tag is pinned. A plausible ref is a SHA or tag/branch name: >=7 chars,
    # alphanumeric start, ref-safe charset.
    for m in re.finditer(r"agent-mcp-baseline-ref:\s*([^\s]+)", text):
        ref = m.group(1).strip().strip("`")
        if ref.startswith("<") or ref.lower() in ("tbd", "todo", "filled"):
            continue
        if re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._/-]{6,}", ref):
            return ref
    return None


def _fenced_block_after(text, marker):
    """Return the first ```-fenced block body that follows `marker`, or ''."""
    idx = text.find(marker)
    if idx == -1:
        return ""
    tail = text[idx:]
    m = re.search(r"```[a-zA-Z]*\n(.*?)```", tail, re.DOTALL)
    return m.group(1) if m else ""


def initiative_plans():
    """The registry-initiative plan dirs, read from THIS plan's decisions.md
    (def:initiative-plans, R5). Fail-closed: an unknown/missing marker yields an
    empty list, which makes ANY guarded drift a violation."""
    if not os.path.exists(DECISIONS):
        return []
    block = _fenced_block_after(open(DECISIONS, encoding="utf-8").read(), "def:initiative-plans")
    plans = []
    for line in block.splitlines():
        line = line.strip().lstrip("-").strip()
        if re.fullmatch(r"[A-Za-z0-9._-]+", line):
            plans.append(line)
    return plans


def union_from_plan_index(plan_dirs):
    """Union of guarded `…/src` mutate_set paths across the given initiative plans."""
    if not os.path.exists(PLAN_INDEX):
        return set()
    doc = json.load(open(PLAN_INDEX, encoding="utf-8"))
    wanted = set(plan_dirs)
    allowed = set()
    for p in doc.get("plans", []):
        if p.get("dir") not in wanted and p.get("plan") not in wanted:
            continue
        for m in p.get("mutate_set", []):
            if any(m.startswith(g) for g in GUARDED):
                allowed.add(m)
    return allowed


def plan8_manifest():
    """Plan 8's explicit decisions.md modification manifest (folded into the union)."""
    if not os.path.exists(PLAN8_DECISIONS):
        return set()
    text = open(PLAN8_DECISIONS, encoding="utf-8").read()
    block = _fenced_block_after(text, "def:agent-mcp-modification-manifest")
    if not block:
        idx = text.find("def:agent-mcp-modification-manifest")
        block = text[idx:] if idx != -1 else ""
    paths = set()
    for line in block.splitlines():
        line = line.strip().lstrip("-").strip()
        # strip an inline `# comment` annotation
        line = line.split("#", 1)[0].strip()
        if any(line.startswith(g) for g in GUARDED):
            paths.add(line)
    return paths


def allowed_union():
    plans = initiative_plans()
    allowed = union_from_plan_index(plans)
    allowed |= plan8_manifest()
    return plans, allowed


def is_allowed(f, allowed):
    """A changed file is allowed if it equals an allowed path or sits under an
    allowed directory prefix (handles dir-style mutate_set entries)."""
    for a in allowed:
        if f == a or f.startswith(a.rstrip("/") + "/"):
            return True
    return False


def changed_since(ref):
    files = set()
    code, out = run(f"git diff --name-only {ref}...HEAD -- {' '.join(GUARDED)}")
    if code == 0 and out:
        files.update(out.splitlines())
    code, out = run(f"git status --porcelain -- {' '.join(GUARDED)}")
    if code == 0 and out:
        for ln in out.splitlines():
            files.add(ln[3:].strip())
    return {f for f in files if f and any(f.startswith(p) for p in GUARDED)}


def main():
    ref = read_baseline_ref()
    if ref is None:
        print("PASS agent-mcp baseline gate: no pinned baseline-ref yet (pre-execution) — vacuously satisfied")
        return 0
    plans, allowed = allowed_union()
    if not plans:
        print("FAIL agent-mcp baseline gate: no initiative plan list found in decisions.md "
              "(def:initiative-plans, R5) — refusing to vouch for an unbounded back-out surface.")
        return 1
    changed = changed_since(ref)
    violations = sorted(f for f in changed if not is_allowed(f, allowed))
    if violations:
        print("FAIL agent-mcp baseline gate: agent-mcp src changed OUTSIDE the sanctioned initiative union:")
        for v in violations:
            print(f"    {v}")
        print(f"  baseline: {ref}; union spans {len(plans)} initiative plan(s), {len(allowed)} allowed path(s)")
        print("  the owner's back-out guarantee is at risk — block merge/publish until reconciled.")
        return 1
    if not changed:
        print(f"PASS agent-mcp baseline gate: byte-identical to baseline {ref} (no initiative plan changed agent-mcp src)")
    else:
        print(f"PASS agent-mcp baseline gate: {len(changed)} change(s) all within the "
              f"{len(plans)}-plan initiative union (baseline {ref}, {len(allowed)} allowed paths)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
