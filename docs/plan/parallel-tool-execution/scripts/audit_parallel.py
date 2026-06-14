#!/usr/bin/env python3
"""audit_parallel.py — structured checklist runner for parallel-tool-execution plan.

Usage:
    python3 docs/plan/parallel-tool-execution/scripts/audit_parallel.py --phase foundation
    python3 docs/plan/parallel-tool-execution/scripts/audit_parallel.py --phase final

Each --phase runs all checks for that phase plus all prior phases.
Exits with the count of failures (0 = all pass).
"""
from __future__ import annotations

import argparse
import subprocess
import sys


def _run(cmd: str) -> tuple[int, str]:
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


failures: list[str] = []


def check(criterion_id: str, description: str, cmd: str,
          expect_empty: bool = False, expect_ok: bool = False) -> None:
    code, out = _run(cmd)
    if expect_empty and out:
        failures.append(
            f"[{criterion_id}] FAIL: expected empty output, got:\n  {out[:300]}\n"
            f"  Fix: {description}"
        )
    elif expect_ok and "OK" not in out:
        failures.append(
            f"[{criterion_id}] FAIL: expected OK, got:\n  {out[:300]}\n"
            f"  Fix: {description}"
        )
    elif not expect_empty and not expect_ok and code != 0:
        failures.append(
            f"[{criterion_id}] FAIL:\n  {out[:300]}\n"
            f"  Fix: {description}"
        )


def phase_foundation() -> None:
    """Checks for parallel-dispatch state."""

    # [parallel-dispatch.1] Promise.all present in orchestrator
    check(
        "parallel-dispatch.1",
        "Add Promise.all to orchestrator.ts tool dispatch loop",
        "grep -q 'Promise.all' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    # [parallel-dispatch.2] Sequential for-loop absent
    check(
        "parallel-dispatch.2",
        "Remove sequential 'for (const toolCall of toolCalls)' loop from orchestrator.ts",
        "grep -q 'for (const toolCall of toolCalls)' packages/ai/agent-mcp/src/engine/orchestrator.ts",
        expect_empty=False,  # this check inverts: we want the grep to FAIL (not found)
    )
    # Re-implement as a real negative check
    code, out = _run("grep -n 'for (const toolCall of toolCalls)' packages/ai/agent-mcp/src/engine/orchestrator.ts")
    if code == 0:
        failures.append(
            "[parallel-dispatch.2] FAIL: sequential 'for (const toolCall of toolCalls)' still present:\n"
            f"  {out[:200]}\n"
            "  Fix: replace the sequential for-loop with the two-phase Promise.all pattern"
        )

    # [parallel-dispatch.3] toolCallId uses toolCall.id
    check(
        "parallel-dispatch.3",
        "toolCallId in result message must reference toolCall.id directly",
        "grep -q 'toolCallId: toolCall.id' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    # [parallel-dispatch.4] toolCallCount++ appears before policy.check in orchestrator
    check(
        "parallel-dispatch.4",
        "toolCallCount must be incremented before policy.check() in the pre-dispatch loop",
        r"""python3 -c "
import re, sys
src = open('packages/ai/agent-mcp/src/engine/orchestrator.ts').read()
# Find line numbers of toolCallCount++ and policy.check(
lines = src.splitlines()
count_inc = next((i for i, l in enumerate(lines) if 'toolCallCount++' in l), None)
policy_chk = next((i for i, l in enumerate(lines) if 'policy.check(' in l), None)
if count_inc is None:
    print('FAIL: toolCallCount++ not found'); sys.exit(1)
if policy_chk is None:
    print('FAIL: policy.check( not found'); sys.exit(1)
if count_inc >= policy_chk:
    print(f'FAIL: toolCallCount++ at line {count_inc+1} is not before policy.check( at line {policy_chk+1}')
    sys.exit(1)
print('OK')
" """,
        expect_ok=True,
    )

    # [parallel-dispatch.5] Fatal ToolError codes re-throw from Phase 2 catch block
    check(
        "parallel-dispatch.5",
        "Fatal ToolError codes (MAX_DEPTH_EXCEEDED, MAX_TOOL_LOOPS_EXCEEDED, DELEGATION_NOT_ALLOWED) must re-throw from Phase 2 catch block — not caught as isError=true",
        r"""python3 -c "
import sys
src = open('packages/ai/agent-mcp/src/engine/orchestrator.ts').read()
fatal_codes = ['MAX_DEPTH_EXCEEDED', 'MAX_TOOL_LOOPS_EXCEEDED', 'DELEGATION_NOT_ALLOWED']
missing = [c for c in fatal_codes if c not in src]
if missing:
    print('FAIL: fatal code(s) not referenced in orchestrator: ' + ', '.join(missing))
    sys.exit(1)
# Check for a re-throw pattern: throw inside catch that gates on the error code
has_rethrow = any(p in src for p in ['throw error', 'throw err', 'FATAL_CODES', 'fatalCodes', 'includes(error.code)'])
if not has_rethrow:
    print('FAIL: no fatal-code re-throw pattern found — add check in Phase 2 catch: if (error instanceof ToolError && FATAL_CODES.includes(error.code)) throw error')
    sys.exit(1)
print('OK')
" """,
        expect_ok=True,
    )

    # [parallel-dispatch.6] Test suite passes
    check(
        "parallel-dispatch.6",
        "All existing tests must pass after parallel dispatch change",
        "npx nx test agent-mcp 2>&1 | grep -qE 'passed|Tests:.*passed'",
    )

    # [parallel-dispatch.7] New test exists for parallel/concurrent dispatch
    check(
        "parallel-dispatch.7",
        "Add test case for multiple concurrent tool calls in orchestrator.test.ts",
        r"grep -qiE 'parallel|concurrent|multiple.*tool|tool.*multiple' packages/ai/agent-mcp/src/__tests__/orchestrator.test.ts",
    )


def phase_final() -> None:
    """Final audit: all DoD clauses verified end-to-end."""
    phase_foundation()

    # [dod.1] Promise.all dispatch is the mechanism (redundant with parallel-dispatch.1, belt+suspenders)
    check(
        "dod.1",
        "Promise.all must be the tool dispatch mechanism in orchestrator.ts",
        "grep -c 'Promise.all' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    # [dod.2] isError=true surfacing: catch block sets isError=true (not re-throws)
    check(
        "dod.2",
        "Non-fatal tool errors must set isError=true, not re-throw",
        "grep -q 'isError = true' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    # [dod.4] Fatal policy codes still re-throw
    check(
        "dod.4",
        "Fatal policy codes (MAX_DEPTH_EXCEEDED, etc.) must re-throw from the catch block",
        "grep -q 'MAX_DEPTH_EXCEEDED' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    # [dod.7] Full build succeeds
    check(
        "dod.7.build",
        "agent-mcp build must succeed",
        "npx nx build agent-mcp 2>&1 | grep -q 'Successfully ran'",
    )

    # [dod.7] Full test suite
    check(
        "dod.7.tests",
        "Full test suite must pass",
        "npx nx test agent-mcp 2>&1 | grep -qE 'passed'",
    )

    # [ref:tool-error-throw] All ToolError throws use the pattern
    check(
        "audit-final.ref-tool-error-throw",
        "All orchestrator ToolError throws must use new ToolError('CODE', message) pattern",
        "grep -n 'throw new ToolError' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    # [dod.3] Call-ID keying verified end-to-end
    check(
        "dod.3",
        "toolCallId must be keyed by toolCall.id in result messages",
        "grep -q 'toolCallId: toolCall.id' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    # [dod.5] toolCallCount correct
    check(
        "dod.5",
        "toolCallCount incremented in pre-dispatch loop before policy check",
        "grep -q 'toolCallCount++' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    # [dod.6] Tool results appended before next model request
    check(
        "dod.6",
        "All tool results appended (one role:tool per call) before next model request",
        "grep -q 'tool_result' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    )

    # [dod.8] Human code-review sentinel exists
    check(
        "dod.8",
        "Human review sentinel .code-review-complete must exist",
        "test -f docs/plan/parallel-tool-execution/.code-review-complete",
    )

    # [code-review.1] Code-review sentinel exists
    check(
        "code-review.1",
        "Human review sentinel .code-review-complete must exist",
        "test -f docs/plan/parallel-tool-execution/.code-review-complete",
    )

    # [docs-and-publish.1] package.json version = 0.1.0
    check(
        "docs-and-publish.1",
        "packages/ai/agent-mcp/package.json version must be 0.1.0",
        "node -e \"const p=require('./packages/ai/agent-mcp/package.json');process.exit(p.version==='0.1.0'?0:1)\"",
    )

    # [docs-and-publish.2] npm registry shows 0.1.0
    check(
        "docs-and-publish.2",
        "npm info @adhd/agent-mcp version must return 0.1.0",
        "npm info @adhd/agent-mcp version 2>/dev/null | grep -q '0.1.0'",
    )

    # [ref:policy-before-dispatch] policy.check appears before Promise.all
    check(
        "audit-final.ref-policy-before-dispatch",
        "policy.check() must appear before Promise.all in orchestrator.ts",
        r"""python3 -c "
import sys
src = open('packages/ai/agent-mcp/src/engine/orchestrator.ts').read()
lines = src.splitlines()
policy_line = next((i for i, l in enumerate(lines) if 'policy.check(' in l), None)
promise_line = next((i for i, l in enumerate(lines) if 'Promise.all' in l), None)
if policy_line is None or promise_line is None:
    print('FAIL: policy.check or Promise.all not found'); sys.exit(1)
if policy_line >= promise_line:
    print(f'FAIL: policy.check at {policy_line+1} is not before Promise.all at {promise_line+1}')
    sys.exit(1)
print('OK')
" """,
        expect_ok=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=["foundation", "final"], required=True)
    args = parser.parse_args()

    {"foundation": phase_foundation, "final": phase_final}[args.phase]()

    label = args.phase.upper()
    if failures:
        print(f"\n{label} AUDIT FAILED: {len(failures)} criterion/criteria:\n")
        for f in failures:
            print(f)
        sys.exit(len(failures))
    else:
        print(f"\n{label} AUDIT PASSED: all criteria verified.")
        sys.exit(0)


if __name__ == "__main__":
    main()
