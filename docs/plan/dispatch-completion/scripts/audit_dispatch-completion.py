#!/usr/bin/env python3
"""Audit driver for the dispatch-completion plan.

`--phase dod` runs the final Definition-of-Done audit: every [dod.N] clause in
README.md is proven here. Behavioral clauses DRIVE their declared entrypoint
(the `nx test <project>` the DoD names) AND assert its exit code (`== 0`) — the
observable itself is asserted inside the behavioral spec the entrypoint runs, so
the chain is: entrypoint runs the real test -> the test asserts the observable ->
this check gates on the exit code (never on stdout scraping). A revert of any
fix flips the owning spec red, which flips this check red (the negative control).

`--phase <other>` runs that phase's declarative acceptance criteria (criteria.json)
via the vendored run-audit.js, accumulating every earlier phase (the audit
hold-point "verify prior states" semantics).

Run from the repo root:
    python3 docs/plan/dispatch-completion/scripts/audit_dispatch-completion.py --phase dod
    python3 docs/plan/dispatch-completion/scripts/audit_dispatch-completion.py --phase spec

Exit 0 iff every selected check passes. This script is the repo interpreter
(python3) with no import-time third-party deps — deterministic in a clean
executor subprocess.
"""
import subprocess
import sys

_failures = []
_ran = 0

PLAN_DIR = "docs/plan/dispatch-completion"
DISPATCH_PROJECTS = (
    "dispatch-base-spec,dispatch-core-client,dispatch-serializer-json,"
    "dispatch-serializer-sqlite,dispatch-core-optimizer,dispatch-orchestrator,"
    "dispatch-plugin-io,dispatch-plugin-gitnexus,dispatch-tools,dispatch-cli"
)

# Phases whose acceptance criteria live in criteria.json (run via run-audit.js).
CRITERIA_PHASES = (
    "triage", "spec", "optimizer-client", "orchestrator", "plugins",
    "storage", "tools", "cli", "algorithms", "tests", "release",
)


def check(cid, desc, cmd):
    """Run cmd (shell); record pass/fail by exit code."""
    global _ran
    _ran += 1
    try:
        rc = subprocess.run(cmd, shell=True, cwd=".").returncode
    except Exception as e:  # noqa: BLE001
        rc = 1
        print(f"  [{cid}] ERROR running check: {e}")
    status = "PASS" if rc == 0 else "FAIL"
    print(f"  [{cid}] {status} — {desc}")
    if rc != 0:
        _failures.append(cid)
    return rc == 0


def phase_dod():
    # Behavioral checks DRIVE `nx test <project>` (the entrypoint's distinctive
    # token) and assert its exit code with `[[ $rc == 0 ]]` — the observable is
    # asserted inside the spec that the entrypoint runs; this gates on the real
    # exit code (never stdout), and a reverted fix flips the spec (and this) red.
    #
    # dod.1 (structural) — all 10 dispatch projects build+test green.
    check("dod.1", "All 10 dispatch projects build+test green",
          f"npx --yes nx run-many -t test,build -p {DISPATCH_PROJECTS}")
    # dod.2 (behavioral) — execution_mode discriminant on every unit.
    check("dod.2", "DispatchUnit carries non-null execution_mode (asserted by the optimizer spec)",
          "bash -c 'npx --yes nx test dispatch-core-optimizer; rc=$?; [[ $rc == 0 ]]'")
    # dod.3 (behavioral) — a complete milestone reports eligible:false.
    check("dod.3", "complete milestone reports eligible:false (asserted by the spec suite)",
          "bash -c 'npx --yes nx test dispatch-base-spec; rc=$?; [[ $rc == 0 ]]'")
    # dod.4 (behavioral) — mid-cycle runner failure recorded, not thrown.
    check("dod.4", "runner failure recorded as failed dispatch_log entry (asserted by the orchestrator spec)",
          "bash -c 'npx --yes nx test dispatch-orchestrator; rc=$?; [[ $rc == 0 ]]'")
    # dod.5 (behavioral) — causal replan rewires downstream + reaches terminal.
    check("dod.5", "causal replan rewires downstream depends_on to terminal (asserted by the orchestrator spec)",
          "bash -c 'npx --yes nx test dispatch-orchestrator; rc=$?; [[ $rc == 0 ]]'")
    # dod.6 (behavioral) — sqlite serializer reload == json serializer reload.
    check("dod.6", "sqlite serializer adapter parity with json (asserted by the sqlite spec)",
          "bash -c 'npx --yes nx test dispatch-serializer-sqlite; rc=$?; [[ $rc == 0 ]]'")
    # dod.7 (behavioral) — plugins enrich; optimizer pure with null deps.
    check("dod.7", "io/gitnexus plugins enrich; optimizer pure with null deps (asserted by the plugin specs)",
          "bash -c 'npx --yes nx test dispatch-plugin-io dispatch-plugin-gitnexus; rc=$?; [[ $rc == 0 ]]'")
    # dod.8 (structural) — provider enum enforced; calibrate bad-tier fast-fail.
    check("dod.8", "provider enum enforced (spec) + calibrate bad-tier fast-fail (cli)",
          "npx --yes nx run-many -t test -p dispatch-base-spec,dispatch-cli")
    # dod.9 (structural) — snapshot JSON round-trip has no Infinity->null.
    check("dod.9", "snapshot round-trip has no Infinity->null corruption",
          "npx --yes nx test dispatch-core-optimizer")
    # dod.10 (structural) — optimizer-algorithms held-or-beats-greedy.
    check("dod.10", "optimizer-algorithms data-gated (held or beats greedy)",
          "npx --yes nx test dispatch-core-optimizer")
    # dod.11 (behavioral) — dispatch-tools authors valid dag + rejects cycles.
    check("dod.11", "dispatch-tools authors valid dag, rejects cycle (asserted by the tools spec)",
          "bash -c 'npx --yes nx test dispatch-tools; rc=$?; [[ $rc == 0 ]]'")
    # dod.12 (structural) — bin field present; base-types deleted.
    check("dod.12", "cli bin field present AND dispatch-base-types deleted",
          "bash -c 'grep -q \"\\\"bin\\\"\" entrypoint/dispatch-cli/package.json "
          "&& ! test -d packages/dispatch/dispatch-base-types'")
    # dod.13 (structural) — every carried DEBT item fixed-with-test or closed.
    check("dod.13", "plan BACKLOG.md carries no open DEBT-DISPATCH item",
          "bash -c 'test -f docs/plan/dispatch-completion/BACKLOG.md "
          "&& ! grep -Eq \"status:\\s*OPEN\\b\" docs/plan/dispatch-completion/BACKLOG.md'")
    # dod.14 (behavioral, LIVE) — the dispatcher completes a cycle against a REAL
    # model end-to-end. Drives the paid live path (AGENT_MCP_LIVE=1 ->
    # run --no-dry-run -> npx -y @adhd/agent-mcp -> deepseek) and asserts its exit
    # code; the real-e2e spec asserts the observable (a real deepseek task + a
    # persisted dispatch_log result with tokens>0). NO MOCK stands in. Requires
    # the deepseek-api-key human-blocker (fails loudly if the key is absent — the
    # live proof genuinely did not happen). The default-running structural spawn +
    # MCP handshake is proven unflagged by criterion live-e2e.1 (phase tests).
    check("dod.14", "dispatcher completes a real cycle against deepseek end-to-end (live, no mock)",
          "bash -c 'AGENT_MCP_LIVE=1 npx --yes nx test dispatch-cli; rc=$?; [[ $rc == 0 ]]'")


def run_criteria_phase(phase):
    """Delegate a declarative-criteria phase to the vendored run-audit.js."""
    cmd = (
        f"node {PLAN_DIR}/scripts/run-audit.js --phase {phase} "
        f"--criteria {PLAN_DIR}/scripts/criteria.json --repo-root ."
    )
    print(f"== audit phase: {phase} (criteria.json via run-audit.js) ==")
    return subprocess.run(cmd, shell=True, cwd=".").returncode


def main(argv):
    phase = None
    if "--phase" in argv:
        phase = argv[argv.index("--phase") + 1]
    if phase == "dod":
        print("== audit phase: dod (Definition of Done) ==")
        phase_dod()
    elif phase in CRITERIA_PHASES:
        return run_criteria_phase(phase)
    elif phase is None:
        print("== audit phase: dod (Definition of Done) ==")
        phase_dod()
    else:
        print(f"unknown phase: {phase} (known: dod, {', '.join(CRITERIA_PHASES)})")
        return 2
    print(f"\n{_ran} check(s), {len(_failures)} failure(s): {_failures or 'none'}")
    return 1 if _failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
