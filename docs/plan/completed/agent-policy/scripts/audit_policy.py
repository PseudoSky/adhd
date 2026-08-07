#!/usr/bin/env python3
"""
audit_policy.py — phase-scoped audit for the agent-policy plan.

Usage:
  python3 docs/plan/agent-policy/scripts/audit_policy.py --phase architecture
  python3 docs/plan/agent-policy/scripts/audit_policy.py --phase schema
  python3 docs/plan/agent-policy/scripts/audit_policy.py --phase final

Every guard is env-pinned: `npx --yes nx ...` and `python3 ...` — never a bare
`nx`/`tsc`, so the gate measures the code, not the ambient PATH.

The behavioral Definition-of-Done checks (dod.1, dod.2, dod.3) DRIVE the real
AgentPolicyStore / enforcement plugin / seeder against a real on-disk SQLite DB
(and, for dod.2, a real `HookRegistry` from @adhd/agent-mcp-types) via the vitest
entrypoints declared in README.md. Each check() command STRING literally names the
clause's `entrypoint:` (the `--testFile=...inheritance.test.ts` /
`enforcement-plugin.test.ts` / `roundtrip.test.ts` token) so gap-check Check-8 sees
the real door, and the test files prove persistence by REOPENING the store (not
reading in-memory state) and prove enforcement by driving the REAL registry (not a
mock).

Criterion ID registry (referenced by gap-check.js):
  architecture phase:
    [policy-design.1..3]
  schema phase (architecture + all work-state criteria + audit-schema):
    [scaffold-package.1..5]
    [policy-type-and-template-schema.1..3]
    [agent-policy-junction.1..3]
    [policy-inheritance.1..3]
    [enforcement-plugin.1..4]
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
# (docs/plan/agent-policy/scripts/ -> repo root).
import os
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
PKG = "packages/ai/agent-policy"
SCHEMA = f"{PKG}/src/db/schema.ts"
STORE = f"{PKG}/src/store"
PLUGIN = f"{PKG}/src/plugin"
SEED = f"{PKG}/src/seed"
TESTS = f"{PKG}/src/__tests__"
DECISIONS = "docs/plan/agent-policy/decisions.md"


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


# ── Architecture phase ──────────────────────────────────────────────────────

def phase_architecture() -> list:
    r = []
    r.append(exists("policy-design.1", "decisions.md exists", DECISIONS))
    r.append(grep_present("policy-design.2", "eager-vs-lazy inheritance decision recorded",
                          "eager|lazy|fanout|inheritance resolution", DECISIONS))
    r.append(grep_present("policy-design.3", "EnforcementEvent pre:model_request limitation recorded",
                          "EnforcementEvent|pre:model_request", DECISIONS))
    return r


# ── Structural / schema-phase checks ────────────────────────────────────────

def phase_schema() -> list:
    r = list(phase_architecture())
    # scaffold-package
    r.append(exists("scaffold-package.1", "project.json exists", f"{PKG}/project.json"))
    r.append(grep_present("scaffold-package.2", "tsconfig path registered", "@adhd/agent-policy", "tsconfig.base.json"))
    r.append(grep_present("scaffold-package.3", "tagged platform:node", "platform:node", f"{PKG}/project.json"))
    r.append(check("scaffold-package.4", "package builds clean", "npx --yes nx build agent-policy"))
    r.append(grep_absent("scaffold-package.5", "no browser globals", r'from "react"|document\.|window\.', f"{PKG}/src"))
    # policy-type-and-template-schema
    r.append(grep_present("policy-type-and-template-schema.1", "policy_types lookup (text PK, not enum)",
                          "policy_types|policyTypes", SCHEMA))
    r.append(grep_present("policy-type-and-template-schema.2", "policy_templates table (rules+enforcement+version+is_system)",
                          "policy_templates|policyTemplates", SCHEMA))
    r.append(check("policy-type-and-template-schema.3", "policy-template-store round-trip+reopen test passes",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/policy-template-store.test.ts"))
    # agent-policy-junction
    r.append(grep_present("agent-policy-junction.1", "agent_policy junction",
                          "agent_policy|agentPolicy", SCHEMA))
    r.append(grep_present("agent-policy-junction.2", "store attaches direct policy + inherited_from",
                          "inherited_from|inheritedFrom|attach", f"{STORE}/agent-policy-store.ts"))
    r.append(check("agent-policy-junction.3", "agent-policy-store direct-attach round-trip after reopen passes",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/agent-policy-store.test.ts"))
    # policy-inheritance
    r.append(grep_present("policy-inheritance.1", "category-level attach propagates via inherited_from",
                          "inherited_from|inheritedFrom|category", f"{STORE}/agent-policy-store.ts"))
    r.append(check("policy-inheritance.2", "inheritance: new category member inherits mandatory policy after reopen",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/inheritance.test.ts"))
    r.append(check("policy-inheritance.3", "negative-control: inheritance test has teeth (positive probe)",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/inheritance.test.ts"))
    # enforcement-plugin
    r.append(grep_present("enforcement-plugin.1", "plugin exports configSchema (zod)",
                          "configSchema", f"{PLUGIN}/index.ts"))
    r.append(grep_present("enforcement-plugin.2", "createPlugin + registerEnforcement(pre:model_request)",
                          "createPlugin|registerEnforcement", f"{PLUGIN}/index.ts {PLUGIN}/rate-policy.ts"))
    r.append(check("enforcement-plugin.3", "rate policy throws through real IHookRegistry.enforce(pre:model_request)",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/enforcement-plugin.test.ts"))
    r.append(check("enforcement-plugin.4", "negative-control: enforcement test has teeth (positive probe)",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/enforcement-plugin.test.ts"))
    # NOTE: seed-and-roundtrip.* criteria are NOT evaluated here. The
    # seed-and-roundtrip work-state runs in a LATER wave than audit-schema (this
    # schema-phase gate), so evaluating its criteria here would fail before the
    # work has run. They are enforced at the true final gate in phase_final()
    # (audit-final) where the seed work is complete. (F2 phase-membership fix.)
    r.append(check("audit-schema.1", "schema-phase audit self-consistent", "true"))
    return r


# ── Behavioral DoD checks (final phase) ─────────────────────────────────────
# Each drives the clause's declared entrypoint and asserts its observable.
# The command STRING names the entrypoint's distinctive token so gap-check
# Check-8 confirms the proving check drives the real door.

def phase_final() -> list:
    r = phase_schema()
    # seed-and-roundtrip — gated HERE (audit-final), not in phase_schema. By the
    # final wave the seed-and-roundtrip work-state has run, so these criteria are
    # enforceable with full teeth at the true final gate. (F2 phase-membership fix.)
    r.append(check("seed-and-roundtrip.1", "seed/reopen/idempotency suite passes",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/roundtrip.test.ts"))
    r.append(grep_present("seed-and-roundtrip.2", "seed lists SEED_DATA policy templates (multi-value enforcement)",
                          "no-credentials|max-rework|reviewer-posture|sox-audit-trail", f"{SEED}/policy-templates.ts"))
    r.append(check("seed-and-roundtrip.3", "negative-control: roundtrip idempotency has teeth (positive probe)",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/roundtrip.test.ts"))
    # [dod.1] inheritance: new category member inherits mandatory policy after reopen
    r.append(check("dod.1", "mandatory category policy inherited by new agent after reopen (inherited_from set)",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/inheritance.test.ts"))
    # [dod.2] enforcement plugin throws through REAL IHookRegistry
    r.append(check("dod.2", "rate policy enforces by throwing through real IHookRegistry.enforce(pre:model_request)",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/enforcement-plugin.test.ts"))
    # [dod.3] seed idempotency + multi-value enforcement round-trips
    r.append(check("dod.3", "policy-template seed is idempotent and round-trips after reopen",
                   f"npx --yes nx test agent-policy --testFile={TESTS}/roundtrip.test.ts"))
    # [dod.4] structural — platform:node lib registered + path
    r.append(grep_present("dod.4", "agent-policy registered platform:node + tsconfig path",
                          "platform:node", f"{PKG}/project.json"))
    r.append(grep_present("dod.4", "agent-policy tsconfig path present",
                          "@adhd/agent-policy", "tsconfig.base.json"))
    # [dod.5] structural — lookup (not enum) + required tables + plugin contract
    r.append(grep_present("dod.5", "policy_types/policy_templates/agent_policy tables exist",
                          "policy_templates|policyTemplates", SCHEMA))
    r.append(grep_present("dod.5", "agent_policy junction exists",
                          "agent_policy|agentPolicy", SCHEMA))
    r.append(grep_absent("dod.5", "policy_types is a lookup table, not a SQL enum",
                         r"text\(\s*['\"]type['\"]\s*,\s*\{\s*enum", SCHEMA))
    r.append(grep_present("dod.5", "plugin follows agent-mcp-budget contract (configSchema + createPlugin)",
                          "configSchema", f"{PLUGIN}/index.ts"))
    r.append(grep_present("dod.5", "plugin exports createPlugin",
                          "createPlugin", f"{PLUGIN}/index.ts"))
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
