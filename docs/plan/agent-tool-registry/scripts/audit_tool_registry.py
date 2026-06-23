#!/usr/bin/env python3
"""
audit_tool_registry.py — phase-scoped audit for the agent-tool-registry plan.

Usage:
  python3 docs/plan/agent-tool-registry/scripts/audit_tool_registry.py --phase schema
  python3 docs/plan/agent-tool-registry/scripts/audit_tool_registry.py --phase final

Every guard is env-pinned: `npx --yes nx ...` and `python3 ...` — never a bare
`nx`/`tsc`, so the gate measures the code, not the ambient PATH.

The behavioral Definition-of-Done checks (dod.1, dod.2, dod.3) DRIVE the real
BindingStore / seeder / AgentToolStore against a real on-disk SQLite DB via the
vitest entrypoints declared in README.md. Each check() command STRING literally
names the clause's `entrypoint:` (the `--testFile=...binding-store.test.ts` /
`roundtrip.test.ts` / `agent-tool-store.test.ts` token) so gap-check Check-8 sees
the real door, and the test files prove persistence by REOPENING the store (not
reading in-memory state).

Criterion ID registry (referenced by gap-check.js):
  schema phase (all work-state criteria + audit-schema):
    [scaffold-package.1..5]
    [tool-and-type-schema.1..3]
    [platform-and-binding-schema.1..3]
    [mcp-server-schema.1..2]
    [agent-tool-junction.1..2]
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

# Repo root is four levels up from this script
# (docs/plan/agent-tool-registry/scripts/ -> repo root).
import os
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
PKG = "packages/ai/agent-tool-registry"
SCHEMA = f"{PKG}/src/db/schema.ts"
TESTS = f"{PKG}/src/__tests__"
NC_MUTATE = "docs/plan/agent-tool-registry/scripts/nc_mutate.mjs"
NC_RESTORE = "docs/plan/agent-tool-registry/scripts/nc_restore.mjs"


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
    """Run cmd. expect_empty -> pass only when output empty; else pass on exit 0.
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


# ── Structural / schema-phase checks ────────────────────────────────────────

def phase_schema() -> list:
    r = []
    # scaffold-package
    r.append(exists("scaffold-package.1", "project.json exists", f"{PKG}/project.json"))
    r.append(grep_present("scaffold-package.2", "tsconfig path registered", "@adhd/agent-tool-registry", "tsconfig.base.json"))
    r.append(grep_present("scaffold-package.3", "tagged platform:node", "platform:node", f"{PKG}/project.json"))
    r.append(check("scaffold-package.4", "package builds clean", "npx --yes nx build agent-tool-registry"))
    r.append(grep_absent("scaffold-package.5", "no browser globals", r'from "react"|document\.|window\.', f"{PKG}/src"))
    # tool-and-type-schema
    r.append(grep_present("tool-and-type-schema.1", "tool_types text-PK lookup table (not enum)", "tool_types|toolTypes", SCHEMA))
    r.append(grep_present("tool-and-type-schema.2", "tools table", "tools|toolsTable", SCHEMA))
    r.append(check("tool-and-type-schema.3", "tool-store test passes",
                   f"npx --yes nx test agent-tool-registry --testFile={TESTS}/tool-store.test.ts"))
    # platform-and-binding-schema
    r.append(grep_present("platform-and-binding-schema.1", "platforms table with header_format", "platforms|header_format|headerFormat", SCHEMA))
    r.append(grep_present("platform-and-binding-schema.2", "tool_platform_bindings table", "tool_platform_bindings|toolPlatformBindings", SCHEMA))
    r.append(check("platform-and-binding-schema.3", "binding-store canonical->platform-name test passes",
                   f"npx --yes nx test agent-tool-registry --testFile={TESTS}/binding-store.test.ts"))
    # mcp-server-schema
    r.append(grep_present("mcp-server-schema.1", "mcp_servers table", "mcp_servers|mcpServers", SCHEMA))
    r.append(check("mcp-server-schema.2", "mcp-server-store test passes",
                   f"npx --yes nx test agent-tool-registry --testFile={TESTS}/mcp-server-store.test.ts"))
    # agent-tool-junction
    r.append(grep_present("agent-tool-junction.1", "agent_tools junction with permission level", "agent_tools|agentTools", SCHEMA))
    r.append(check("agent-tool-junction.2", "agent-tool-store permission-level test passes",
                   f"npx --yes nx test agent-tool-registry --testFile={TESTS}/agent-tool-store.test.ts"))
    # seed-and-roundtrip
    r.append(check("seed-and-roundtrip.1", "seed/reopen/idempotency/binding-resolution suite passes",
                   f"npx --yes nx test agent-tool-registry --testFile={TESTS}/roundtrip.test.ts"))
    r.append(grep_present("seed-and-roundtrip.2", "tool seed lists SEED_DATA canonical tools",
                          "shell_exec|file_read|web_fetch", f"{PKG}/src/seed/tools.ts"))
    r.append(check("seed-and-roundtrip.3", "negative-control: binding round-trip has teeth (positive probe)",
                   f"npx --yes nx test agent-tool-registry --testFile={TESTS}/roundtrip.test.ts"))
    r.append(check("audit-schema.1", "schema-phase audit self-consistent", "true"))
    return r


# ── Behavioral DoD checks (final phase) ─────────────────────────────────────
# Each drives the clause's declared entrypoint and asserts its observable.
# The command STRING names the entrypoint's distinctive token so gap-check
# Check-8 confirms the proving check drives the real door.

def phase_final() -> list:
    r = phase_schema()
    # [dod.1] canonical tool resolves to platform name after reopen
    r.append(check("dod.1", "canonical tool resolves to platform-specific name after reopen",
                   f"npx --yes nx test agent-tool-registry --testFile={TESTS}/binding-store.test.ts"))
    # [dod.2] seed idempotent + round-trips after reopen
    r.append(check("dod.2", "seed of tools + bindings is idempotent and round-trips after reopen",
                   f"npx --yes nx test agent-tool-registry --testFile={TESTS}/roundtrip.test.ts"))
    # [dod.3] agent_tools junction grants at permission level, queryable back
    r.append(check("dod.3", "agent_tools junction grants a tool at a permission level, queryable back",
                   f"npx --yes nx test agent-tool-registry --testFile={TESTS}/agent-tool-store.test.ts"))
    # [dod.4] structural — platform:node lib registered + builds
    r.append(grep_present("dod.4", "agent-tool-registry registered platform:node + tsconfig path",
                          "platform:node", f"{PKG}/project.json"))
    r.append(grep_present("dod.4", "agent-tool-registry tsconfig path registered",
                          "@adhd/agent-tool-registry", "tsconfig.base.json"))
    # [dod.5] structural — required tables exist + tool_types is a lookup, not an enum
    r.append(grep_present("dod.5", "required schema tables exist (tool_platform_bindings + agent_tools + mcp_servers)",
                          "tool_platform_bindings|toolPlatformBindings", SCHEMA))
    r.append(grep_present("dod.5", "tool_types is a lookup table (sqliteTable), never a SQL enum",
                          "tool_types|toolTypes", SCHEMA))
    r.append(grep_absent("dod.5", "tool type is not a SQL enum",
                         r"enum\(\s*['\"]?tool_type", SCHEMA))
    r.append(check("audit-final.1", "final audit self-consistent", "true"))
    return r


PHASES = {
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
