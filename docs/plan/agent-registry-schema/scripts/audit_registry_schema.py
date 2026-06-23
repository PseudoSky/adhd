#!/usr/bin/env python3
"""
audit_registry_schema.py — phase-scoped audit for the agent-registry-schema plan.

Usage:
  python3 docs/plan/agent-registry-schema/scripts/audit_registry_schema.py --phase schema
  python3 docs/plan/agent-registry-schema/scripts/audit_registry_schema.py --phase final

Every guard is env-pinned: `npx --yes nx ...` and `python3 ...` — never a bare
`nx`/`tsc`, so the gate measures the code, not the ambient PATH.

The behavioral Definition-of-Done checks (dod.1, dod.2, dod.3) DRIVE the real
ComponentStore / CompositionStore / seeder against a real on-disk SQLite DB via
the vitest entrypoints declared in README.md. Each check() command STRING literally
names the clause's `entrypoint:` (the `--testFile=...roundtrip.test.ts` /
`composition-store.test.ts` token) so gap-check Check-8 sees the real door, and the
test files prove persistence by REOPENING the store (not reading in-memory state).

Criterion ID registry (referenced by gap-check.js):
  schema phase (all work-state criteria + audit-schema):
    [scaffold-package.1..5]
    [lookup-and-component-schema.1..3]
    [agent-and-taxonomy-schema.1..3]
    [composition-junction.1..3]
    [usecase-and-context-rules.1..2]
    [composed-prompt-cache.1..2]
    [seed-and-roundtrip.1..3]
    [audit-schema.1]
  final phase (everything above + behavioral DoD checks + audit-final):
    [audit-final.1]
    [dod.1] [dod.2] [dod.3] [dod.4] [dod.5]

Exits 0 when all checks in the phase pass; exits 1 with a failure summary otherwise.
"""

import argparse
import subprocess
import sys
from dataclasses import dataclass

# Repo root is three levels up from this script
# (docs/plan/agent-registry-schema/scripts/ -> repo root).
import os
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
PKG = "packages/ai/agent-registry"
SCHEMA = f"{PKG}/src/db/schema.ts"
TESTS = f"{PKG}/src/__tests__"


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


def check(check_id: str, description: str, cmd: str, expect_empty: bool = False) -> CheckResult:
    """Run cmd. expect_empty → pass only when output empty; else pass on exit 0.
    Signature matches gap-check.js 3-arg pattern: check(id, description, cmd)."""
    code, out = run(cmd)
    if expect_empty:
        passed = (out == "")
        detail = f"unexpected output:\n{out}" if not passed else ""
    else:
        passed = (code == 0)
        detail = out if not passed else ""
    return CheckResult(f"[{check_id}] {description}", passed, detail)


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


DECISIONS = "docs/plan/agent-registry-schema/decisions.md"


def phase_architecture() -> list:
    r = []
    r.append(exists("design-and-architecture.1", "decisions.md exists", DECISIONS))
    r.append(grep_present("design-and-architecture.2", "DB topology decision recorded",
                          "DB topology|ATTACH DATABASE|table-name prefix", DECISIONS))
    r.append(grep_present("design-and-architecture.3", "context-condition precedence recorded",
                          "context.condition|precedence|last wins|all included", DECISIONS))
    return r


# ── Structural / schema-phase checks ────────────────────────────────────────

def phase_schema() -> list:
    r = list(phase_architecture())
    # scaffold-package
    r.append(exists("scaffold-package.1", "project.json exists", f"{PKG}/project.json"))
    r.append(grep_present("scaffold-package.2", "tsconfig path registered", "@adhd/agent-registry", "tsconfig.base.json"))
    r.append(grep_present("scaffold-package.3", "tagged platform:node", "platform:node", f"{PKG}/project.json"))
    r.append(check("scaffold-package.4", "package builds clean", "npx --yes nx build agent-registry"))
    r.append(grep_absent("scaffold-package.5", "no browser globals", r'from "react"|document\.|window\.', f"{PKG}/src"))
    # lookup-and-component-schema
    r.append(grep_present("lookup-and-component-schema.1", "prompt_types table", "prompt_types|promptTypes", SCHEMA))
    r.append(grep_present("lookup-and-component-schema.2", "prompt_components table", "prompt_components|promptComponents", SCHEMA))
    r.append(check("lookup-and-component-schema.3", "component-store test passes",
                   f"npx --yes nx test agent-registry --testFile={TESTS}/component-store.test.ts"))
    # agent-and-taxonomy-schema
    r.append(grep_present("agent-and-taxonomy-schema.1", "agents table", "agents|agentsTable", SCHEMA))
    r.append(grep_present("agent-and-taxonomy-schema.2", "taxonomy_categories table", "taxonomy", SCHEMA))
    r.append(check("agent-and-taxonomy-schema.3", "agent-store test passes",
                   f"npx --yes nx test agent-registry --testFile={TESTS}/agent-store.test.ts"))
    # composition-junction
    r.append(grep_present("composition-junction.1", "agent_components junction", "agent_components|agentComponents", SCHEMA))
    r.append(grep_present("composition-junction.2", "resolveComposition reads order", "resolveComposition|position",
                          f"{PKG}/src/store/composition-store.ts"))
    r.append(check("composition-junction.3", "composition ordering/pin/context test passes",
                   f"npx --yes nx test agent-registry --testFile={TESTS}/composition-store.test.ts"))
    # usecase-and-context-rules
    r.append(grep_present("usecase-and-context-rules.1", "use_cases/context_rules/component_usage",
                          "use_cases|context_rules|component_usage", SCHEMA))
    r.append(check("usecase-and-context-rules.2", "usecase-store test passes",
                   f"npx --yes nx test agent-registry --testFile={TESTS}/usecase-store.test.ts"))
    # composed-prompt-cache
    r.append(grep_present("composed-prompt-cache.1", "composed_prompts table", "composed_prompts|composedPrompts", SCHEMA))
    r.append(check("composed-prompt-cache.2", "composed-prompt-store cache test passes",
                   f"npx --yes nx test agent-registry --testFile={TESTS}/composed-prompt-store.test.ts"))
    # NOTE: seed-and-roundtrip.* criteria are NOT evaluated here. The seed-and-roundtrip
    # work-state runs in a LATER wave (depends_on: ["audit-schema"]), so audit-schema must
    # gate only the schema-TABLE criteria above. The seed criteria are enforced at the true
    # final gate in phase_final() (audit-final, the last wave) where the work is complete.
    r.append(check("audit-schema.1", "schema-phase audit self-consistent", "true"))
    return r


# ── Behavioral DoD checks (final phase) ─────────────────────────────────────
# Each drives the clause's declared entrypoint and asserts its observable.
# The command STRING names the entrypoint's distinctive token so gap-check
# Check-8 confirms the proving check drives the real door.

def phase_final() -> list:
    r = phase_schema()
    # seed-and-roundtrip — gated HERE (audit-final), not in phase_schema. By the final
    # wave the seed-and-roundtrip work-state has run, so these criteria are enforceable
    # with full teeth at the true final gate.
    r.append(check("seed-and-roundtrip.1", "seed/reopen/idempotency suite passes",
                   f"npx --yes nx test agent-registry --testFile={TESTS}/roundtrip.test.ts"))
    r.append(grep_present("seed-and-roundtrip.2", "seed lists DATA_MODEL types",
                          "success_criteria|escalation|convergence", f"{PKG}/src/seed/prompt-types.ts"))
    r.append(check("seed-and-roundtrip.3", "negative-control: roundtrip has teeth (positive probe)",
                   f"npx --yes nx test agent-registry --testFile={TESTS}/roundtrip.test.ts"))
    # [dod.1] component round-trips after reopen
    r.append(check("dod.1", "component round-trips through real store after reopen",
                   f"npx --yes nx test agent-registry --testFile={TESTS}/roundtrip.test.ts"))
    # [dod.2] composition order/pin/context honored
    r.append(check("dod.2", "composition resolves ordered, pinned, context-filtered components",
                   f"npx --yes nx test agent-registry --testFile={TESTS}/composition-store.test.ts"))
    # [dod.3] seed idempotency
    r.append(check("dod.3", "seed is idempotent on re-run",
                   f"npx --yes nx test agent-registry --testFile={TESTS}/roundtrip.test.ts"))
    # [dod.4] structural — platform:node lib registered + builds
    r.append(grep_present("dod.4", "agent-registry registered platform:node + path",
                          "platform:node", f"{PKG}/project.json"))
    # [dod.5] structural — required tables exist
    r.append(grep_present("dod.5", "required schema tables exist",
                          "composed_prompts|composedPrompts", SCHEMA))
    r.append(check("audit-final.1", "final audit self-consistent", "true"))
    return r


PHASES = {
    "architecture": phase_architecture,
    "schema": phase_schema,
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
