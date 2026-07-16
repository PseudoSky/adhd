#!/usr/bin/env python3
"""
audit_schema_foundation.py — acceptance-criteria audit for task-schema-foundation plan.

Usage:
  python3 audit_schema_foundation.py --phase foundation   # schema-columns + task-types checks
  python3 audit_schema_foundation.py --phase final        # foundation + DoD clauses
"""
import argparse
import subprocess
import sys
import os


def run(cmd, *, expect_zero=True):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
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
    print("\n=== schema-columns ===")
    results = []
    results.append(check(
        "[schema-columns.1] depends_on column in schema.ts",
        "grep -q 'depends_on' packages/ai/agent-mcp/src/db/schema.ts",
    ))
    results.append(check(
        "[schema-columns.2] resume_token column in schema.ts",
        "grep -q 'resume_token' packages/ai/agent-mcp/src/db/schema.ts",
    ))
    results.append(check(
        '[schema-columns.3] "waiting" in status enum in schema.ts',
        'grep -q \'"waiting"\' packages/ai/agent-mcp/src/db/schema.ts',
    ))
    results.append(check(
        '[schema-columns.4] "awaiting_input" in status enum in schema.ts',
        'grep -q \'"awaiting_input"\' packages/ai/agent-mcp/src/db/schema.ts',
    ))
    results.append(check(
        "[schema-columns.5] Drizzle migration generated (>=4 .sql files)",
        "python3 -c \"import os; sqls=[f for f in os.listdir('packages/ai/agent-mcp/drizzle') if f.endswith('.sql')]; assert len(sqls)>=4, f'expected >=4, got {len(sqls)}'\"",
    ))

    print("\n=== task-types ===")
    results.append(check(
        '[task-types.1] "waiting" in taskStatusSchema (validation/task.ts)',
        "grep -q '\"waiting\"' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    results.append(check(
        '[task-types.2] "awaiting_input" in taskStatusSchema (validation/task.ts)',
        "grep -q '\"awaiting_input\"' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    results.append(check(
        "[task-types.3] dependsOn field in taskSchema",
        "grep -q 'dependsOn' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    results.append(check(
        "[task-types.4] resumeToken field in taskSchema",
        "grep -q 'resumeToken' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    results.append(check(
        '[task-types.5] "waiting" in TaskStatus export (agent-mcp-types)',
        "grep -q 'waiting' packages/ai/agent-mcp-types/src/index.ts",
    ))
    results.append(check(
        "[task-types.6] Build passes after type changes",
        "npx --yes nx build agent-mcp 2>&1 | grep -q 'Successfully ran'",
    ))

    return results


# ── Phase final ───────────────────────────────────────────────────────────────

def phase_final():
    foundation_results = phase_foundation()

    print("\n=== DoD clauses ===")
    dod_results = []
    dod_results.append(check(
        "[dod.1] Migration 0004_*.sql exists with all four columns",
        r"""python3 -c "
import glob, sys
# Match the 0004_* migration by number, not list position — positional
# indexing breaks when other migrations (0001_task_usage, 0005_*) shift the
# index away from the migration number.
cands = sorted(glob.glob('packages/ai/agent-mcp/drizzle/0004_*.sql'))
if not cands:
    print('FAIL: no 0004_*.sql migration found'); sys.exit(1)
migration = open(cands[0]).read()
for col in ['depends_on', 'on_upstream_failure', 'inputs', 'resume_token']:
    if col not in migration:
        print(f'FAIL: column {col!r} not in {cands[0]}'); sys.exit(1)
print('OK')
" """,
    ))
    dod_results.append(check(
        '[dod.2] "waiting" and "awaiting_input" in status enum (schema.ts + validation/task.ts)',
        "grep -q '\"waiting\"' packages/ai/agent-mcp/src/db/schema.ts && "
        "grep -q '\"awaiting_input\"' packages/ai/agent-mcp/src/db/schema.ts && "
        "grep -q '\"waiting\"' packages/ai/agent-mcp/src/validation/task.ts && "
        "grep -q '\"awaiting_input\"' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    dod_results.append(check(
        "[dod.3] TaskStore updated — create sets 'waiting' when dependsOn; updateStatus accepts resumeToken",
        "grep -q 'waiting' packages/ai/agent-mcp/src/store/task-store.ts && "
        "grep -q 'resumeToken' packages/ai/agent-mcp/src/store/task-store.ts",
    ))
    dod_results.append(check(
        "[dod.4] agent-mcp-types TaskStatus includes 'waiting' and 'awaiting_input'",
        "grep -q 'waiting' packages/ai/agent-mcp-types/src/index.ts && "
        "grep -q 'awaiting_input' packages/ai/agent-mcp-types/src/index.ts",
    ))
    dod_results.append(check(
        "[dod.5] Build passes (no TypeScript errors)",
        "npx --yes nx build agent-mcp 2>&1 | grep -q 'Successfully ran'",
    ))
    dod_results.append(check(
        "[dod.6] Version bumped to 1.0.0",
        "node -e \"const p=require('./packages/ai/agent-mcp/package.json'); process.exit(p.version==='1.0.0'?0:1)\"",
    ))

    return foundation_results + dod_results


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
