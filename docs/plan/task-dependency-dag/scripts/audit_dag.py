#!/usr/bin/env python3
"""
audit_dag.py — acceptance-criteria audit for task-dependency-dag plan.

Usage:
  python3 audit_dag.py --phase foundation   # checks dag-schema + dag-types + dag-engine
  python3 audit_dag.py --phase final        # checks DoD clauses + full coverage
"""
import argparse
import subprocess
import sys
import os


def run(cmd, *, expect_zero=True):
    """Run a shell command and return (passed, stdout+stderr)."""
    result = subprocess.run(
        cmd, shell=True, capture_output=True, text=True
    )
    ok = (result.returncode == 0) == expect_zero
    return ok, (result.stdout + result.stderr).strip()


def check(label, cmd, *, expect_zero=True):
    ok, out = run(cmd, expect_zero=expect_zero)
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] {label}")
    if not ok:
        for line in out.splitlines()[:8]:
            print(f"         {line}")
    return ok


# ── Phase foundation ──────────────────────────────────────────────────────────

def phase_foundation():
    print("\n=== dag-schema ===")
    results = []
    results.append(check(
        "[dag-schema.1] depends_on column in schema.ts",
        "grep -q 'depends_on' packages/ai/agent-mcp/src/db/schema.ts",
    ))
    results.append(check(
        "[dag-schema.2] on_upstream_failure column in schema.ts",
        "grep -q 'on_upstream_failure' packages/ai/agent-mcp/src/db/schema.ts",
    ))
    results.append(check(
        '[dag-schema.3] inputs column in schema.ts',
        "grep -q '\"inputs\"' packages/ai/agent-mcp/src/db/schema.ts",
    ))
    results.append(check(
        '[dag-schema.4] "waiting" in status enum',
        'grep -q \'"waiting"\' packages/ai/agent-mcp/src/db/schema.ts',
    ))
    results.append(check(
        "[dag-schema.5] Drizzle migration generated (>=4 .sql files)",
        "python3 -c \"import os; sqls=[f for f in os.listdir('packages/ai/agent-mcp/drizzle') if f.endswith('.sql')]; assert len(sqls)>=4, f'expected >=4, got {len(sqls)}'\"",
    ))

    print("\n=== dag-types ===")
    results.append(check(
        '[dag-types.1] "waiting" in taskStatusSchema',
        "grep -q '\"waiting\"' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    results.append(check(
        "[dag-types.2] dependsOn field in taskSchema",
        "grep -q 'dependsOn' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    results.append(check(
        "[dag-types.3] onUpstreamFailure field in taskSchema",
        "grep -q 'onUpstreamFailure' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    results.append(check(
        "[dag-types.4] depends_on in taskToolInputSchema",
        "grep -q 'depends_on' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    results.append(check(
        "[dag-types.5] TaskStore.create() sets 'waiting' when dependsOn",
        "grep -q 'waiting' packages/ai/agent-mcp/src/store/task-store.ts",
    ))
    results.append(check(
        "[dag-types.6] Build passes after type changes",
        "npx nx build agent-mcp 2>&1 | grep -q 'Successfully ran'",
    ))

    print("\n=== dag-engine ===")
    results.append(check(
        "[dag-engine.1] engine/dag-engine.ts exists",
        "test -f packages/ai/agent-mcp/src/engine/dag-engine.ts",
    ))
    results.append(check(
        "[dag-engine.2] DagEngine.dispatchReady method exists",
        "grep -q 'dispatchReady' packages/ai/agent-mcp/src/engine/dag-engine.ts",
    ))
    results.append(check(
        "[dag-engine.3] Cycle detection in DagEngine",
        "grep -qiE 'cycle|Cycle' packages/ai/agent-mcp/src/engine/dag-engine.ts",
    ))
    results.append(check(
        "[dag-engine.4] validateNoCycle called in tools/task.ts before create",
        "grep -q 'validateNoCycle' packages/ai/agent-mcp/src/tools/task.ts",
    ))
    results.append(check(
        "[dag-engine.5] dispatchReady called in tools/task.ts after completion",
        "grep -q 'dispatchReady' packages/ai/agent-mcp/src/tools/task.ts",
    ))
    results.append(check(
        "[dag-engine.6] Test file exists for DagEngine",
        "test -f packages/ai/agent-mcp/src/__tests__/dag-engine.test.ts",
    ))
    results.append(check(
        "[dag-engine.7] All tests pass",
        "npx nx test agent-mcp 2>&1 | grep -qE 'passed'",
    ))

    return results


# ── Phase final ───────────────────────────────────────────────────────────────

def phase_final():
    foundation_results = phase_foundation()

    print("\n=== DoD clauses ===")
    dod_results = []
    dod_results.append(check(
        "[dod.1] depends_on accepted in task creation tool",
        "grep -q 'depends_on' packages/ai/agent-mcp/src/tools/task.ts",
    ))
    dod_results.append(check(
        "[dod.2] Waiting tasks NOT queued (BackgroundQueue not called with waiting status)",
        "grep -q '\"waiting\"' packages/ai/agent-mcp/src/engine/dag-engine.ts",
    ))
    dod_results.append(check(
        "[dod.3] dispatchReady called on every terminal state",
        "grep -qE 'dispatchReady.*completed|completed.*dispatchReady|dispatchReady' packages/ai/agent-mcp/src/tools/task.ts",
    ))
    dod_results.append(check(
        "[dod.4] on_upstream_failure: fail — downstream marked failed",
        "grep -qiE 'fail.*upstream|upstream.*fail' packages/ai/agent-mcp/src/engine/dag-engine.ts",
    ))
    dod_results.append(check(
        "[dod.5] on_upstream_failure: skip — downstream dispatched anyway",
        "grep -q 'skip' packages/ai/agent-mcp/src/engine/dag-engine.ts",
    ))
    dod_results.append(check(
        "[dod.6] inputs populated at dispatch time",
        "grep -q 'inputs' packages/ai/agent-mcp/src/engine/dag-engine.ts",
    ))
    dod_results.append(check(
        "[dod.7] validateNoCycle throws ToolError on cycle",
        "grep -qE 'ToolError|VALIDATION_ERROR' packages/ai/agent-mcp/src/engine/dag-engine.ts",
    ))
    dod_results.append(check(
        "[dod.8] Drizzle migration generated",
        "python3 -c \"import os; sqls=[f for f in os.listdir('packages/ai/agent-mcp/drizzle') if f.endswith('.sql')]; assert len(sqls)>=4\"",
    ))
    dod_results.append(check(
        "[dod.9] Version bumped to 0.2.0",
        "node -e \"const p=require('./packages/ai/agent-mcp/package.json'); process.exit(p.version==='0.2.0'?0:1)\"",
    ))

    print("\n=== Reference conformance ===")
    ref_results = []
    ref_results.append(check(
        "audit-final.ref-task-status-enum",
        "grep -q '\"waiting\"' packages/ai/agent-mcp/src/db/schema.ts && grep -q '\"waiting\"' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    ref_results.append(check(
        "audit-final.ref-tool-error-throw",
        "grep -qE 'new ToolError|throw.*ToolError' packages/ai/agent-mcp/src/engine/dag-engine.ts",
    ))
    ref_results.append(check(
        "audit-final.ref-drizzle-upsert-increment",
        "grep -q 'depends_on' packages/ai/agent-mcp/src/db/schema.ts",
    ))

    return foundation_results + dod_results + ref_results


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["foundation", "final"], required=True)
    args = parser.parse_args()

    os.chdir(os.path.join(os.path.dirname(__file__), "../../../.."))

    if args.phase == "foundation":
        results = phase_foundation()
    else:
        results = phase_final()

    passed = sum(results)
    total = len(results)
    print(f"\n{'='*50}")
    print(f"  {passed}/{total} checks passed")
    print(f"{'='*50}")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
