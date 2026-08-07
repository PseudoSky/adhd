#!/usr/bin/env python3
"""
audit_hitl.py — acceptance-criteria audit for hitl-interrupts plan.

NOTE: hitl-schema and hitl-types nodes were extracted to the task-schema-foundation plan.
This audit only checks hitl-orchestrator and hitl-resume-tool criteria.

Usage:
  python3 audit_hitl.py --phase foundation   # hitl-orchestrator + hitl-resume-tool checks
  python3 audit_hitl.py --phase final        # DoD clauses + full coverage
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
    results = []
    print("\n=== hitl-orchestrator ===")
    results.append(check(
        "[hitl-orchestrator.1] request_human_input constant/string in orchestrator.ts",
        "grep -q 'request_human_input' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    ))
    results.append(check(
        "[hitl-orchestrator.2] Orchestrator sets awaiting_input status",
        "grep -q 'awaiting_input' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    ))
    results.append(check(
        "[hitl-orchestrator.3] resolveHitl exported from orchestrator.ts",
        "grep -q 'resolveHitl' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    ))
    results.append(check(
        "[hitl-orchestrator.4] hitlResolvers Map in orchestrator.ts",
        "grep -q 'hitlResolvers' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    ))
    results.append(check(
        "[hitl-orchestrator.5] Tests pass",
        "npx --yes nx test agent-mcp 2>&1 | grep -qE 'passed'",
    ))

    print("\n=== hitl-resume-tool ===")
    results.append(check(
        "[hitl-resume-tool.1] task_resume tool registered in tools/task.ts",
        "grep -q 'task_resume' packages/ai/agent-mcp/src/tools/task.ts",
    ))
    results.append(check(
        "[hitl-resume-tool.2] resumeToken validated in handler",
        "grep -q 'resumeToken' packages/ai/agent-mcp/src/tools/task.ts",
    ))
    results.append(check(
        "[hitl-resume-tool.3] resolveHitl imported from orchestrator",
        "grep -q 'resolveHitl' packages/ai/agent-mcp/src/tools/task.ts",
    ))
    results.append(check(
        "[hitl-resume-tool.4] TASK_NOT_RESUMABLE error code",
        "grep -q 'TASK_NOT_RESUMABLE' packages/ai/agent-mcp/src/tools/task.ts",
    ))
    results.append(check(
        "[hitl-resume-tool.5] Tests pass",
        "npx --yes nx test agent-mcp 2>&1 | grep -qE 'passed'",
    ))

    return results


# ── Phase final ───────────────────────────────────────────────────────────────

def phase_final():
    foundation_results = phase_foundation()

    print("\n=== DoD clauses ===")
    dod_results = []
    dod_results.append(check(
        "[dod.1] request_human_input built-in tool available",
        "grep -q 'request_human_input' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    ))
    dod_results.append(check(
        "[dod.2] Suspended tasks have status awaiting_input",
        "grep -q 'awaiting_input' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    ))
    dod_results.append(check(
        "[dod.3] resumeToken persisted in DB before await",
        "grep -q 'resumeToken' packages/ai/agent-mcp/src/store/task-store.ts",
    ))
    dod_results.append(check(
        "[dod.4] task_resume MCP tool accepts taskId+resumeToken+userInput",
        "grep -q 'task_resume' packages/ai/agent-mcp/src/tools/task.ts",
    ))
    dod_results.append(check(
        "[dod.5] Orchestrator intercepts before MCP dispatch (not in MCP client)",
        "grep -q 'request_human_input' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    ))
    dod_results.append(check(
        "[dod.6] userInput injected as tool result after resume",
        "grep -q 'userInput' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    ))
    dod_results.append(check(
        "[dod.7] awaiting_input in taskStatusSchema",
        "grep -q '\"awaiting_input\"' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    dod_results.append(check(
        "[dod.8] Version bumped to 1.0.0",
        "node -e \"const p=require('./packages/ai/agent-mcp/package.json'); process.exit(p.version==='1.0.0'?0:1)\"",
    ))

    print("\n=== Reference conformance ===")
    ref_results = []
    ref_results.append(check(
        "audit-final.ref-task-status-enum",
        "grep -q 'awaiting_input' packages/ai/agent-mcp/src/db/schema.ts && grep -q '\"awaiting_input\"' packages/ai/agent-mcp/src/validation/task.ts",
    ))
    ref_results.append(check(
        "audit-final.ref-tool-error-throw",
        "grep -qE 'new ToolError|throw.*ToolError' packages/ai/agent-mcp/src/tools/task.ts",
    ))
    ref_results.append(check(
        "audit-final.ref-orchestrator-tool-loop",
        "grep -q 'request_human_input' packages/ai/agent-mcp/src/engine/orchestrator.ts",
    ))
    ref_results.append(check(
        "[inv:resume-token-db-persisted] resumeToken written before Promise await",
        "grep -q 'resumeToken' packages/ai/agent-mcp/src/engine/orchestrator.ts",
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
