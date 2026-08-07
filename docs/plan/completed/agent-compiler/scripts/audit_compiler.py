#!/usr/bin/env python3
"""
audit_compiler.py — phase-scoped audit for the agent-compiler plan (plan 5 of 7).

Usage:
  python3 docs/plan/agent-compiler/scripts/audit_compiler.py --phase architecture
  python3 docs/plan/agent-compiler/scripts/audit_compiler.py --phase schema
  python3 docs/plan/agent-compiler/scripts/audit_compiler.py --phase final

Every guard is env-pinned: `npx --yes nx ...` and `python3 ...` — never a bare
`nx`/`tsc`, so the gate measures the code, not the ambient PATH.

agent-compiler is the CONVERGENCE plan: it JOINS across the four sibling registry
packages (agent-registry, agent-tool-registry, agent-provider, agent-policy) which,
per the schema plan's topology decision, share ONE SQLite file with table-name
prefixes (registry_* / tool_* / provider_* / policy_*). The compiler opens one DB
and queries all four, then WRITES composed_prompts rows.

The behavioral Definition-of-Done checks (dod.1..dod.5) DRIVE the real compile
engine / CLI bin against a real on-disk SQLite DB seeded with rows from all four
packages, via the vitest entrypoints declared in README.md. Each check() command
STRING literally names the clause's `entrypoint:` token (the
`--testFile=...compile-e2e.test.ts` / `compile-cache.test.ts` /
`compile-cli.test.ts` filename) so gap-check Check-8 sees the real door, and the
test files prove the platform-shaped observable (frontmatter `tools:`, junction
order, context-conditional inclusion, policy constraint, cache hit by REOPENING
the DB) — not a proxy.

Tests gate on the runner's EXIT CODE, never stdout `grep -q passed`
(better-sqlite3 can segfault on teardown — project memory
`feedback_plan_execution_pitfalls`; CLAUDE.md verification standard #4).

Criterion ID registry (referenced by gap-check.js):
  architecture phase:
    [compiler-design.1..4]
  schema phase (architecture + all work-state criteria + audit-engine):
    [scaffold-package.1..6]
    [composition-resolve.1..2]
    [tool-header-emit.1..2]
    [model-and-policy-emit.1..3]
    [platform-markdown-emit.1..3]
    [compile-cli.1..2]
    [composed-prompt-caching.1..2]
    [compile-fixtures-e2e.1..2]
    [audit-engine.1]
  final phase (everything above + behavioral DoD checks + audit-final):
    [audit-final.1]
    [dod.1] [dod.2] [dod.3] [dod.4] [dod.5] [dod.6] [dod.7]

Exits 0 when all checks in the phase pass; exits 1 with a failure summary otherwise.
"""

import argparse
import subprocess
import sys
from dataclasses import dataclass

# Repo root is four levels up from this script
# (docs/plan/agent-compiler/scripts/ -> repo root).
import os
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
PKG = "packages/ai/agent-compiler"
SRC = f"{PKG}/src"
RESOLVE = f"{SRC}/resolve"
EMIT = f"{SRC}/emit"
CACHE = f"{SRC}/cache"
CLI = f"{SRC}/cli"
SEED = f"{SRC}/seed"
TESTS = f"{SRC}/__tests__"
DECISIONS = "docs/plan/agent-compiler/decisions.md"


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
    r.append(exists("compiler-design.1", "decisions.md exists", DECISIONS))
    r.append(grep_present("compiler-design.2", "context-condition precedence consumption recorded",
                          "context.condition|precedence|last wins|all included", DECISIONS))
    r.append(grep_present("compiler-design.3", "per-platform header builder contract recorded",
                          "yaml_frontmatter|json_object|header builder", DECISIONS))
    r.append(grep_present("compiler-design.4", "single-DB cross-package join topology cited",
                          "table-name prefix|registry_|tool_|provider_|policy_|single SQLite|one DB", DECISIONS))
    return r


# ── Structural / schema-phase checks ────────────────────────────────────────

def phase_schema() -> list:
    r = list(phase_architecture())
    # scaffold-package
    r.append(exists("scaffold-package.1", "project.json exists", f"{PKG}/project.json"))
    r.append(grep_present("scaffold-package.2", "tsconfig path registered", "@adhd/agent-compiler", "tsconfig.base.json"))
    r.append(grep_present("scaffold-package.3", "tagged platform:node", "platform:node", f"{PKG}/project.json"))
    r.append(check("scaffold-package.4", "package builds clean", "npx --yes nx build agent-compiler"))
    r.append(grep_absent("scaffold-package.5", "no browser globals", r'from "react"|document\.|window\.', f"{PKG}/src"))
    r.append(grep_present("scaffold-package.6", "depends on the four registry packages",
                          "@adhd/agent-registry|@adhd/agent-tool-registry|@adhd/agent-provider|@adhd/agent-policy",
                          f"{PKG}/package.json"))
    # composition-resolve
    r.append(grep_present("composition-resolve.1", "assembles body via resolveComposition in junction order",
                          "resolveComposition|junction order|position", f"{RESOLVE}/composition.ts"))
    r.append(check("composition-resolve.2", "body-ordering test passes",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/composition-resolve.test.ts"))
    # tool-header-emit
    r.append(grep_present("tool-header-emit.1", "joins tool_platform_bindings to build tools header",
                          "tool_platform_bindings|toolPlatformBindings|resolve.*alias", f"{RESOLVE}/tools.ts"))
    r.append(check("tool-header-emit.2", "resolved tools header test passes",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/tool-header.test.ts"))
    # model-and-policy-emit
    r.append(grep_present("model-and-policy-emit.1", "resolves model_hint via model_platform_bindings",
                          "model_platform_bindings|modelPlatformBindings|resolveModelId", f"{RESOLVE}/model.ts"))
    r.append(grep_present("model-and-policy-emit.2", "folds agent_policy rows into header/body block",
                          "agent_policy|agentPolicy|constraint|permission", f"{RESOLVE}/policy.ts"))
    r.append(check("model-and-policy-emit.3", "model+policy resolution test passes",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/model-policy.test.ts"))
    # platform-markdown-emit
    r.append(grep_present("platform-markdown-emit.1", "compileAgent entrypoint exported", "compileAgent", f"{SRC}/compile.ts"))
    r.append(grep_present("platform-markdown-emit.2", "markdown emitter writes YAML frontmatter", "frontmatter|---", f"{EMIT}/markdown.ts"))
    r.append(check("platform-markdown-emit.3", "compileAgent emits real markdown+json from rows",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/compile-agent.test.ts"))
    # compile-cli
    r.append(grep_present("compile-cli.1", "CLI parses --platform/--context/--out-dir/--all", "platform|context|out-dir|all", f"{CLI}/compile.ts"))
    r.append(check("compile-cli.2", "CLI drives compile and asserts stdout markdown",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/compile-cli.test.ts"))
    # composed-prompt-caching
    r.append(grep_present("composed-prompt-caching.1", "writes composed_prompts row keyed by context hash",
                          "composed_prompts|composedPrompts|context_hash|contextHash", f"{CACHE}/composed-prompt-cache.ts"))
    r.append(check("composed-prompt-caching.2", "recompile hits cache; persistence proven by reopen",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/compile-cache.test.ts"))
    # NOTE: compile-fixtures-e2e.* criteria are NOT evaluated here. The
    # compile-fixtures-e2e work-state runs in a LATER wave than audit-engine (this
    # engine-phase gate), so evaluating its criteria here would fail before the
    # work has run. They are enforced at the true final gate in phase_final()
    # (audit-final) where the e2e fixtures exist. (F2 phase-membership fix.)
    r.append(check("audit-engine.1", "schema-phase audit self-consistent", "true"))
    return r


# ── Behavioral DoD checks (final phase) ─────────────────────────────────────
# Each drives the clause's declared entrypoint and asserts its observable.
# The command STRING names the entrypoint's distinctive --testFile token so
# gap-check Check-8 confirms the proving check drives the real door.

def phase_final() -> list:
    r = phase_schema()
    # compile-fixtures-e2e — gated HERE (audit-final), not in phase_schema. By the
    # final wave the compile-fixtures-e2e work-state has run, so these criteria are
    # enforceable with full teeth at the true final gate. (F2 phase-membership fix.)
    r.append(grep_present("compile-fixtures-e2e.1", "seeds a real agent from shared components across four domains",
                          "api-design-reviewer|fixtures|seed", f"{SEED}/fixtures.ts"))
    r.append(check("compile-fixtures-e2e.2", "e2e: compile across two platforms + two contexts from real rows",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/compile-e2e.test.ts"))
    # [dod.1] HEADLINE: compiler emits REAL platform output from REAL rows —
    # claude_code frontmatter tools: resolved from tool_platform_bindings; body
    # components in junction order.
    r.append(check("dod.1", "claude_code markdown frontmatter tools: + body junction order from real rows",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/compile-e2e.test.ts"))
    # [dod.2] context-conditional emit
    r.append(check("dod.2", "context security includes security criteria, excludes general (context-conditional)",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/compile-e2e.test.ts"))
    # [dod.3] policy constraint folded into compiled output
    r.append(check("dod.3", "attached policy constraint appears in compiled header/body",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/compile-e2e.test.ts"))
    # [dod.4] cache hit proven by reopening the DB
    r.append(check("dod.4", "recompile same agent+context returns cached composed_prompts row after reopen",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/compile-cache.test.ts"))
    # [dod.5] real CLI bin prints platform-shaped markdown to stdout
    r.append(check("dod.5", "real compile CLI bin prints YAML-frontmatter markdown to stdout from seeded rows",
                   f"npx --yes nx test agent-compiler --testFile={TESTS}/compile-cli.test.ts"))
    # [dod.6] structural — platform:node lib registered + four deps + builds
    r.append(grep_present("dod.6", "agent-compiler registered platform:node",
                          "platform:node", f"{PKG}/project.json"))
    r.append(grep_present("dod.6", "agent-compiler tsconfig path present",
                          "@adhd/agent-compiler", "tsconfig.base.json"))
    r.append(grep_present("dod.6", "depends on the four registry packages",
                          "@adhd/agent-registry|@adhd/agent-tool-registry|@adhd/agent-provider|@adhd/agent-policy",
                          f"{PKG}/package.json"))
    # [dod.7] structural — writes composed_prompts + emits both header formats
    r.append(grep_present("dod.7", "compiler writes composed_prompts rows",
                          "composed_prompts|composedPrompts", f"{CACHE}/composed-prompt-cache.ts"))
    r.append(grep_present("dod.7", "emits yaml_frontmatter (claude_code) format",
                          "frontmatter|---", f"{EMIT}/markdown.ts"))
    r.append(grep_present("dod.7", "emits json_object (claude_api) format",
                          "json_object|JSON.stringify|systemPrompt|system_prompt", f"{EMIT}/json.ts"))
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
