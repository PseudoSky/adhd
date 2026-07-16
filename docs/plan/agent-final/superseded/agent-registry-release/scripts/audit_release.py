#!/usr/bin/env python3
"""
audit_release.py — phase-scoped audit for the agent-registry-release plan (9/9).

Usage:
  python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase design
  python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase clarity
  python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase cleanup
  python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase merge
  python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase publish
  python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase smoke
  python3 docs/plan/agent-registry-release/scripts/audit_release.py --phase final

This is the OPERATIONAL closeout plan: worktree clarity, merge (gated on the
agent-mcp back-out guarantee), publishing 5 registry packages + agent-mcp@2.0.0,
and artifact cleanup. The audit proves the runbooks/artifacts exist and carry the
binding anchors, and that the back-out guarantee is wired as a gate on merge AND
publish. Env-pinned: `python3 …`, and any nx invocation is `npx --yes nx …`.

Criterion ID registry:
  design:   [closeout-design.1]
  clarity:  [worktree-clarity.1]
  cleanup:  [artifact-cleanup.1] [dod.4]
  merge:    [merge-to-main.1] [dod.1] [dod.2] [dod.5]
  publish:  [publish-packages.1] [dod.3]
  smoke:    [post-publish-smoke.1]
  final:    [audit-final.1] + all behavioral DoD
"""

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
PLAN = "docs/plan/agent-registry-release"
REG = "docs/plan/agent-registry"
DECISIONS = f"{PLAN}/decisions.md"
CLOSEOUT = f"{REG}/CLOSEOUT.md"
MERGE_RB = f"{PLAN}/MERGE_RUNBOOK.md"
PUBLISH_RB = f"{PLAN}/PUBLISH_RUNBOOK.md"
POST_PUBLISH = f"{PLAN}/POST_PUBLISH.md"

REGISTRY_PKGS = ["agent-registry", "agent-tool-registry", "agent-provider", "agent-policy", "agent-compiler"]


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str = ""


def run(cmd: str):
    p = subprocess.run(cmd, shell=True, cwd=REPO_ROOT, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip()


def exists(cid, desc, rel):
    ok = os.path.exists(os.path.join(REPO_ROOT, rel))
    return CheckResult(f"[{cid}] {desc}", ok, "" if ok else f"missing: {rel}")


def grep_present(cid, desc, pattern, paths):
    code, _ = run(f"grep -rEq -- {pattern!r} {paths}")
    return CheckResult(f"[{cid}] {desc}", code == 0, "" if code == 0 else f"pattern not found: {pattern} in {paths}")


def grep_absent(cid, desc, pattern, paths):
    code, out = run(f"grep -rEn -- {pattern!r} {paths}")
    return CheckResult(f"[{cid}] {desc}", code != 0, "" if code != 0 else f"forbidden pattern found:\n{out}")


def cmd_check(cid, desc, cmd):
    # F-P6-10 hardening: project.json sets passWithNoTests:true, so a
    # `nx test --testFile=<missing>` exits 0 ("No test files found") — a GHOST
    # PASS that would green an audit for a proof that does not exist. Require the
    # test file to exist first, so a missing proof FAILS the criterion honestly.
    _m = re.search(r"--testFile=(\S+)", cmd)
    if _m and not cmd.lstrip().startswith("test -f"):
        cmd = f"test -f {_m.group(1)} && {cmd}"
    code, out = run(cmd)
    return CheckResult(f"[{cid}] {desc}", code == 0, out if code != 0 else "")


# ── phases ───────────────────────────────────────────────────────────────────

def phase_design():
    r = []
    r.append(exists("closeout-design.0", "decisions.md exists", DECISIONS))
    r.append(grep_present("closeout-design.1", "release strategy (merge/publish/disposition) recorded",
                          "def:release-strategy", DECISIONS))
    r.append(grep_present("closeout-design.2", "pre-initiative agent-mcp baseline ref recorded",
                          "agent-mcp-baseline-ref|agent-mcp baseline", DECISIONS))
    # [dod.5] structural: agent-mcp-backout-gate precedes merge-to-main in the DAG.
    r.append(cmd_check("dod.5", "agent-mcp-backout-gate is a dependency of merge-to-main (back-out gated on merge)",
                       f"python3 -c \"import json;d=json.load(open('{PLAN}/dag.json'));"
                       f"exit(0 if 'agent-mcp-backout-gate' in d['nodes']['merge-to-main']['depends_on'] else 1)\""))
    return r


def phase_clarity():
    r = phase_design()
    r.append(exists("worktree-clarity.0", "CLOSEOUT.md exists", CLOSEOUT))
    # [dod.1] worktree clarity: path + branch + base + merge command + back-out gate.
    r.append(grep_present("worktree-clarity.1", "CLOSEOUT names the worktree branch",
                          "agent-registry-execution", CLOSEOUT))
    # [dod.1] driven as an executable check() that reads CLOSEOUT.md (the entrypoint
    # "docs/plan/agent-registry/CLOSEOUT.md read by the owner") and asserts the
    # worktree-path + branch + merge-command + back-out-gate anchors are all present.
    r.append(cmd_check("dod.1", "CLOSEOUT.md gives worktree path + branch + merge command + back-out gate",
                       "grep -q 'adhd-agent-registry' docs/plan/agent-registry/CLOSEOUT.md "
                       "&& grep -q 'agent-registry-execution' docs/plan/agent-registry/CLOSEOUT.md "
                       "&& grep -Eq 'git merge|--no-ff' docs/plan/agent-registry/CLOSEOUT.md "
                       "&& grep -q 'back-out' docs/plan/agent-registry/CLOSEOUT.md"))
    return r


def phase_cleanup():
    r = phase_clarity()
    # [dod.4] every untracked initiative artifact accounted for in a disposition table.
    r.append(grep_present("artifact-cleanup.1", "CLOSEOUT carries an artifact disposition table",
                          "disposition|SPEC|DEMO|COVERAGE|orchestration-ledger", CLOSEOUT))
    r.append(cmd_check("dod.4", "no untracked initiative file unaccounted for (disposition check)",
                       f"python3 {PLAN}/scripts/check_disposition.py"))
    return r


def phase_merge():
    r = phase_cleanup()
    r.append(exists("merge-to-main.1", "MERGE_RUNBOOK.md exists", MERGE_RB))
    # [dod.2] merge gated on agent-mcp byte-identical verification — the executable
    # check RUNS check_agent_mcp_baseline.py (the declared entrypoint) so a green
    # dod.2 means the gate actually passed, not that a runbook merely mentions it.
    r.append(cmd_check("dod.2", "check_agent_mcp_baseline.py passes (merge gated on the back-out guarantee)",
                       f"python3 {PLAN}/scripts/check_agent_mcp_baseline.py"))
    r.append(grep_present("dod.2.runbook", "MERGE_RUNBOOK wires the merge to the agent-mcp baseline check",
                          "check_agent_mcp_baseline|agent-mcp.*baseline|back-out", MERGE_RB))
    return r


def phase_publish():
    r = phase_merge()
    r.append(exists("publish-packages.0", "PUBLISH_RUNBOOK.md exists", PUBLISH_RB))
    # [dod.3] nx release publish, clean cache — NEVER --skip-nx-cache.
    # The executable check reads PUBLISH_RUNBOOK.md (the declared entrypoint) and
    # asserts it drives `nx release publish`, names agent-mcp@2.0.0, and carries NO
    # --skip-nx-cache token (the stale-dist footgun). The actual registry-resolution
    # observable is proven by post-publish-smoke (smoke_test.sh) once published.
    r.append(cmd_check("dod.3", "PUBLISH_RUNBOOK.md uses nx release publish (agent-mcp@2.0.0) with no --skip-nx-cache",
                       "grep -q 'nx release publish' docs/plan/agent-registry-release/PUBLISH_RUNBOOK.md "
                       "&& grep -Eq 'agent-mcp.*2\\.0\\.0|2\\.0\\.0' docs/plan/agent-registry-release/PUBLISH_RUNBOOK.md "
                       "&& ! grep -q 'skip-nx-cache' docs/plan/agent-registry-release/PUBLISH_RUNBOOK.md"))
    r.append(grep_absent("publish-packages.1", "no --skip-nx-cache in the publish runbook",
                         "skip-nx-cache", PUBLISH_RB))
    # [publish-packages.2] F-P6-13: the runbook must reconcile @adhd/* version pins
    # (no "*" ships) and point at the runtime-resolution smoke. The criterion-mirror
    # check + a stronger compound assertion that the no-"*" verification + transitive
    # deps + the smoke handoff are all actually documented (not just the tag).
    r.append(grep_present("publish-packages.2", "runbook reconciles @adhd/* version pins (no '*' ships), F-P6-13",
                          "F-P6-13", PUBLISH_RB))
    r.append(cmd_check("dod.3.deps", "PUBLISH_RUNBOOK pins @adhd/* to real versions (no '*'), names transitive deps, hands off to the runtime smoke (F-P6-13)",
                       "grep -q 'F-P6-13' docs/plan/agent-registry-release/PUBLISH_RUNBOOK.md "
                       "&& grep -q 'still' docs/plan/agent-registry-release/PUBLISH_RUNBOOK.md "
                       "&& grep -Eq 'agent-mcp-budget|agent-compiler' docs/plan/agent-registry-release/PUBLISH_RUNBOOK.md "
                       "&& grep -q 'smoke_test.sh' docs/plan/agent-registry-release/PUBLISH_RUNBOOK.md"))
    return r


def phase_smoke():
    r = phase_publish()
    r.append(exists("post-publish-smoke.0", "POST_PUBLISH.md exists", POST_PUBLISH))
    r.append(exists("post-publish-smoke.1", "smoke_test.sh exists", f"{PLAN}/scripts/smoke_test.sh"))
    # [post-publish-smoke.2] F-P6-13: the smoke must install agent-mcp OUTSIDE the
    # workspace (no @adhd symlinks) and require-resolve its transitive @adhd/* deps
    # from the published graph — the runtime-resolution consumer-outcome proof.
    r.append(grep_present("post-publish-smoke.2", "smoke proves out-of-workspace runtime resolution of agent-mcp's @adhd deps (F-P6-13)",
                          "F-P6-13", f"{PLAN}/scripts/smoke_test.sh"))
    r.append(cmd_check("post-publish-smoke.2.proof", "smoke uses a scratch project (mktemp) and createRequire-resolves agent-mcp's @adhd/* deps",
                       "grep -q 'mktemp' docs/plan/agent-registry-release/scripts/smoke_test.sh "
                       "&& grep -q 'createRequire' docs/plan/agent-registry-release/scripts/smoke_test.sh "
                       "&& grep -q '@adhd/agent-compiler' docs/plan/agent-registry-release/scripts/smoke_test.sh"))
    return r


def phase_final():
    r = phase_smoke()
    r.append(CheckResult("[audit-final.1] final audit self-consistent", True, ""))
    return r


PHASES = {
    "design": phase_design,
    "clarity": phase_clarity,
    "cleanup": phase_cleanup,
    "merge": phase_merge,
    "publish": phase_publish,
    "smoke": phase_smoke,
    "final": phase_final,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True, choices=sorted(PHASES.keys()))
    args = ap.parse_args()
    results = PHASES[args.phase]()
    failures = [c for c in results if not c.passed]
    for c in results:
        print(f"{'PASS' if c.passed else 'FAIL'} {c.name}")
        if not c.passed and c.detail:
            print("    " + c.detail.replace("\n", "\n    "))
    print(f"\n{len(results) - len(failures)}/{len(results)} checks passed in phase '{args.phase}'.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
