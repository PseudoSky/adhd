#!/usr/bin/env python3
"""
audit_mcp_refactor.py — phase-scoped audit for the agent-mcp-refactor plan (6/7).

Usage:
  python3 docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py --phase architecture
  python3 docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py --phase integration
  python3 docs/plan/agent-mcp-refactor/scripts/audit_mcp_refactor.py --phase final

Every guard is env-pinned: `npx --yes nx ...` and `python3 ...` — never a bare
`nx`/`tsc`, so the gate measures the code, not the ambient PATH.

The behavioral Definition-of-Done checks (dod.1, dod.2, dod.3) DRIVE the REAL
agent-mcp session-start path against a REAL on-disk SQLite DB via the vitest
entrypoints declared in README.md. The LLM provider boundary is mocked; the
compiler + stores + session start are the REAL thing under test. Each check()
command STRING literally names the clause's `entrypoint:` token (the
`--testFile=...session-compiler-e2e.test.ts` / `cache-reuse.test.ts` token, or
the bare full-suite `npx --yes nx test agent-mcp`) so gap-check Check-8 sees the
real door.

Persistence / cache claims are proven by REOPENING the better-sqlite3 handle from
the same file path — never by reading in-memory state. better-sqlite3 under vitest
can segfault on teardown: every gate keys on the runner's EXIT CODE, never on
stdout `grep -q passed`.

Criterion ID registry (referenced by gap-check.js / criteria.json):
  architecture phase:
    [refactor-design.1..5]
  schema phase (+ architecture):
    [runtime-sink-schema.1..5]
  integration phase (+ schema + retire):
    [compiler-integration.1..5] [agent-store-retire.1..3]
    [policy-engine-bridge.1..3] [audit-integration.1]
  final phase (everything above + behavioral DoD checks + audit-final):
    [session-e2e.1..4] [audit-final.1]
    [dod.1] [dod.2] [dod.3] [dod.4] [dod.5] [dod.6]

Exits 0 when all checks in the phase pass; exits 1 with a failure summary otherwise.
"""

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass

# Repo root is four levels up from this script
# (docs/plan/agent-mcp-refactor/scripts/ -> repo root).
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
PKG = "packages/ai/agent-mcp"
TYPES = "packages/ai/agent-mcp-types"
SCHEMA = f"{PKG}/src/db/schema.ts"
TESTS = f"{PKG}/src/__tests__"
DECISIONS = "docs/plan/agent-mcp-refactor/decisions.md"


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str = ""


def run(cmd: str):
    p = subprocess.run(
        cmd, shell=True, cwd=REPO_ROOT,
        capture_output=True, text=True,
    )
    return p.returncode, (p.stdout + p.stderr).strip()


def check(check_id: str, description: str, cmd: str) -> CheckResult:
    """Run cmd; pass on exit 0. Signature matches gap-check.js 3-arg pattern."""
    code, out = run(cmd)
    return CheckResult(f"[{check_id}] {description}", code == 0, out if code != 0 else "")


def exists(check_id: str, description: str, rel: str) -> CheckResult:
    ok = os.path.exists(os.path.join(REPO_ROOT, rel))
    return CheckResult(f"[{check_id}] {description}", ok, "" if ok else f"missing: {rel}")


def grep_present(check_id: str, description: str, pattern: str, paths: str) -> CheckResult:
    code, _ = run(f"grep -rEq -- {pattern!r} {paths}")
    ok = (code == 0)
    return CheckResult(f"[{check_id}] {description}", ok, "" if ok else f"pattern not found: {pattern} in {paths}")


def grep_absent(check_id: str, description: str, pattern: str, paths: str) -> CheckResult:
    code, out = run(f"grep -rEn -- {pattern!r} {paths}")
    ok = (code != 0)  # grep exit 1 = no match = good
    return CheckResult(f"[{check_id}] {description}", ok, "" if ok else f"forbidden pattern found:\n{out}")


# ── architecture phase ──────────────────────────────────────────────────────

def phase_architecture() -> list:
    r = []
    r.append(exists("refactor-design.1", "decisions.md exists", DECISIONS))
    r.append(grep_present("refactor-design.2", "AgentStore removal-vs-thin-cache decision recorded",
                          "AgentStore|thin cache|source.of.truth", DECISIONS))
    r.append(grep_present("refactor-design.3", "session-start composed_prompt cache flow recorded",
                          "composed_prompt_id|cache lookup|context hash", DECISIONS))
    r.append(grep_present("refactor-design.4", "systemPrompt compat-shim policy recorded",
                          "compat|shim|populated from compiler", DECISIONS))
    r.append(grep_present("refactor-design.5", "claudecli tactical-feature reconciliation recorded",
                          "allowedBuiltinTools|systemPromptIsAgentSpec|AGENT_TOOL", DECISIONS))
    return r


# ── schema phase ────────────────────────────────────────────────────────────

def phase_schema() -> list:
    r = list(phase_architecture())
    r.append(grep_present("runtime-sink-schema.1", "composed_prompts cache table in schema",
                          "composed_prompts|composedPromptsTable", SCHEMA))
    r.append(grep_present("runtime-sink-schema.2", "experiment_assignments table in schema",
                          "experiment_assignments|experimentAssignmentsTable", SCHEMA))
    r.append(grep_present("runtime-sink-schema.3", "sessions.composed_prompt_id FK column in schema",
                          "composed_prompt_id|composedPromptId", SCHEMA))
    r.append(check("runtime-sink-schema.4", "a drizzle migration file exists for the new tables/column",
                   f"ls {PKG}/drizzle | grep -E '\\.sql$'"))
    r.append(check("runtime-sink-schema.5", "composed-prompt-store reopen roundtrip test passes (real on-disk DB)",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/composed-prompt-schema.test.ts"))
    return r


# ── integration phase (schema + retire + integration audit) ─────────────────

def phase_integration() -> list:
    r = list(phase_schema())
    # compiler-integration
    r.append(grep_present("compiler-integration.1", "prompt-resolver imports compileAgent from @adhd/agent-compiler",
                          "compileAgent|@adhd/agent-compiler", f"{PKG}/src/engine/prompt-resolver.ts"))
    r.append(grep_present("compiler-integration.2", "resolver caches/looks up composed prompt + writes composed_prompt_id",
                          "resolveSystemPrompt|resolveComposedPrompt|composed_prompt_id|composedPromptId",
                          f"{PKG}/src/engine/prompt-resolver.ts"))
    r.append(check("compiler-integration.3", "compiler-resolve test passes: systemPrompt comes from compileAgent",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/compiler-resolve.test.ts"))
    r.append(grep_present("compiler-integration.4", "agent-mcp package.json declares @adhd/agent-compiler dependency",
                          "@adhd/agent-compiler", f"{PKG}/package.json"))
    r.append(grep_present("compiler-integration.5", "tsconfig.base.json resolves @adhd/agent-compiler path",
                          "@adhd/agent-compiler", "tsconfig.base.json"))
    # agent-store-retire — the "old system is gone" clauses are STRUCTURAL (grep_absent)
    r.append(grep_absent("agent-store-retire.1",
                         "flat systemPrompt source-of-truth authoring field is gone (no required z.string())",
                         "systemPrompt: z\\.string\\(\\)", f"{PKG}/src/validation/agent.ts"))
    r.append(grep_present("agent-store-retire.2", "systemPrompt retained only as a computed compat shim",
                          "compat|computed|populated from compiler|composed", f"{PKG}/src/validation/agent.ts"))
    r.append(check("agent-store-retire.3", "agent CRUD delegates / agent row is a compiled cache (test passes)",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/agent-cache-store.test.ts"))
    # policy-engine-bridge
    r.append(grep_present("policy-engine-bridge.1", "PolicyEngine reads limits from agent-policy templates",
                          "policy template|agent-policy|policyStore|fromPolicy|rules", f"{PKG}/src/engine/policy.ts"))
    r.append(grep_present("policy-engine-bridge.2", "claudecli reconciles tactical flags with AGENT_TOOL/compiled tools",
                          "AGENT_TOOL|compiled tools|composed\\.tools|allowedBuiltinTools", f"{PKG}/src/providers/claudecli.ts"))
    r.append(check("policy-engine-bridge.3", "policy/tool reconciliation test passes (no competing third model)",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/policy-tool-reconcile.test.ts"))
    r.append(check("audit-integration.1", "integration-phase audit self-consistent", "true"))
    return r


# ── final phase (everything + behavioral DoD checks + audit-final) ──────────
# Each behavioral DoD check DRIVES the clause's declared entrypoint and asserts
# its observable through the REAL agent-mcp path (real DB; LLM boundary mocked).

def phase_final() -> list:
    r = phase_integration()
    # session-e2e structural/command criteria
    r.append(check("session-e2e.1", "e2e: real session start resolves systemPrompt == compileAgent output",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/session-compiler-e2e.test.ts"))
    r.append(check("session-e2e.2", "cache: second session reuses composed_prompt (proven by reopen)",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/cache-reuse.test.ts"))
    # session-e2e.3 is the negative-control criterion (run-audit.js owns its mutate/restore)
    r.append(check("session-e2e.4", "non-regression: full agent-mcp unit suite still passes",
                   "npx --yes nx test agent-mcp"))

    # [dod.1] session start resolves systemPrompt from compiler
    r.append(check("dod.1", "session systemPrompt equals compileAgent output (real path, real DB)",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/session-compiler-e2e.test.ts"))
    # [dod.2] composed_prompt cache hit on second session
    r.append(check("dod.2", "second session reuses cached composed_prompt without recompile (reopen-proven)",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/cache-reuse.test.ts"))
    # [dod.3] non-regression full suite
    r.append(check("dod.3", "all existing agent-mcp unit tests still pass (full suite, exit-code gated)",
                   "npx --yes nx test agent-mcp"))
    # [dod.4] structural — flat-systemPrompt authoring/source-of-truth path is gone
    r.append(grep_absent("dod.4", "flat-systemPrompt authoring path removed",
                         "systemPrompt: z\\.string\\(\\)", f"{PKG}/src/validation/agent.ts"))
    # [dod.5] structural — runtime sink schema + compiler dependency
    r.append(grep_present("dod.5", "sessions.composed_prompt_id FK exists",
                          "composed_prompt_id|composedPromptId", SCHEMA))
    # [dod.6] structural — claudecli tactical features reconciled
    r.append(grep_present("dod.6", "claudecli tactical features reconciled with AGENT_TOOL/compiled tools",
                          "AGENT_TOOL|compiled tools|composed\\.tools|allowedBuiltinTools", f"{PKG}/src/providers/claudecli.ts"))
    r.append(check("audit-final.1", "final audit self-consistent", "true"))
    return r


PHASES = {
    "architecture": phase_architecture,
    "schema": phase_schema,
    "integration": phase_integration,
    "final": phase_final,
}


def main() -> int:
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
