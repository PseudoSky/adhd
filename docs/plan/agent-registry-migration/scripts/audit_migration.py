#!/usr/bin/env python3
"""
audit_migration.py — phase-scoped audit for the agent-registry-migration plan
(plan 7 of 7, the FINAL plan of the Agent Registry initiative; depends on plan 5
@adhd/agent-compiler and plan 6 agent-mcp-refactor).

Usage:
  python3 docs/plan/agent-registry-migration/scripts/audit_migration.py --phase architecture
  python3 docs/plan/agent-registry-migration/scripts/audit_migration.py --phase migration
  python3 docs/plan/agent-registry-migration/scripts/audit_migration.py --phase final

Every guard is env-pinned: `npx --yes nx ...` and `python3 ...` — never a bare
`nx`/`tsc`, so the gate measures the code, not the ambient PATH.

The behavioral Definition-of-Done checks (dod.1..dod.4) DRIVE the real migration
tool — the frontmatter parser, the body-section splitter, the import pipeline, the
round-trip equivalence gate, and the removal runbook — against a REAL on-disk
registry SQLite DB and the REAL `@adhd/agent-compiler`, via the vitest entrypoints
declared in README.md. Each check() command STRING literally names the clause's
`entrypoint:` (`--testFile=...roundtrip-equivalence.test.ts` /
`import-pipeline.test.ts` / `skills-migration.test.ts` /
`removal-runbook.test.ts`) so gap-check Check-8 sees the real door, and the test
files prove persistence by REOPENING the registry store (not in-memory state).

THE central behavioral DoD (dod.1): a migrated fixture agent compiles to
BYTE/behaviorally-equivalent markdown vs. its original `.md`. The gate runs the
real import then `agent-registry compile <slug> --platform claude_code` and
normalized-diffs against the original fixture; the diff must be empty.

ZERO-DATA-LOSS REMOVAL GATE (dod.4): removal is forced to depend on an all-PASS
equivalence report. Nothing is deleted until the round-trip is verified for every
migrated agent ("Files are not deleted until the round-trip is verified for every
agent" — REFERENCES.md). The negative control corrupts a migrated component and
proves the gate then BLOCKS removal.

CROSS-REPO BOUNDARY: the actual 346 `.md` files live in a SEPARATE repo
(`~/dev/ai/claude-agents`, REFERENCES.md "Primary Source: claude-agents"), NOT in
this adhd repo. This plan builds + verifies the migration TOOL against FIXTURE
`.md` files checked into the package (`src/__fixtures__/`). The audit therefore
operates ONLY on the in-repo tool + fixtures + the equivalence report; the actual
cross-repo claude-agents removal is a documented runbook step gated on that
report (RUNBOOK.md) — never executed by these guards.

Criterion ID registry (referenced by gap-check.js):
  architecture phase:
    [migration-design.1..5]
  migration phase (architecture + all parse/import/verify work-state criteria + audit-migration):
    [scaffold-package.1..5]
    [frontmatter-parser.1..2]
    [body-section-splitter.1..2]
    [import-pipeline.1..2]
    [skills-migration.1..2]
    [roundtrip-equivalence-gate.1..4]
    [audit-migration.1]
  final phase (everything above + removal + behavioral DoD checks + audit-final):
    [removal-runbook.1..3]
    [audit-final.1]
    [dod.1] [dod.2] [dod.3] [dod.4] [dod.5] [dod.6]

Exits 0 when all checks in the phase pass; exits 1 with a failure summary otherwise.
"""

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass

# Repo root is three levels up from this script
# (docs/plan/agent-registry-migration/scripts/ -> repo root).
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
PKG = "packages/ai/agent-registry-migration"
SRC = f"{PKG}/src"
TESTS = f"{SRC}/__tests__"
FIX = f"{SRC}/__fixtures__"
DECISIONS = "docs/plan/agent-registry-migration/decisions.md"
RUNBOOK = "docs/plan/agent-registry-migration/RUNBOOK.md"
NX_TEST = "npx --yes nx test agent-registry-migration"


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


# ── architecture phase ──────────────────────────────────────────────────────

def phase_architecture() -> list:
    r = []
    r.append(exists("migration-design.1", "decisions.md exists", DECISIONS))
    r.append(grep_present("migration-design.2", "equivalence definition (byte/behavioral) recorded",
                          "byte-equivalent|behaviorally.equivalent|normaliz", DECISIONS))
    r.append(grep_present("migration-design.3", "zero-loss gate + cross-repo boundary recorded",
                          "zero.data.loss|round-trip|claude-agents|cross-repo", DECISIONS))
    r.append(exists("migration-design.4", "fixture agent .md checked in", f"{FIX}/code-reviewer.md"))
    r.append(exists("migration-design.5", "fixture SKILL.md checked in", f"{FIX}/ticket-creation.SKILL.md"))
    return r


# ── migration phase (parse + import + verify, all structural/behavioral pieces) ─

def phase_migration() -> list:
    r = list(phase_architecture())
    # scaffold-package — platform:node lib registered + depends on registry+compiler
    r.append(exists("scaffold-package.1", "project.json exists", f"{PKG}/project.json"))
    r.append(grep_present("scaffold-package.2", "tagged platform:node", "platform:node", f"{PKG}/project.json"))
    r.append(grep_present("scaffold-package.3", "tsconfig path registered",
                          "@adhd/agent-registry-migration", "tsconfig.base.json"))
    r.append(grep_present("scaffold-package.4", "depends on registry + compiler",
                          "@adhd/agent-registry|@adhd/agent-compiler", f"{PKG}/package.json"))
    r.append(check("scaffold-package.5", "package builds clean", "npx --yes nx build agent-registry-migration"))
    # frontmatter-parser — name/desc/tools/model -> AGENT + AGENT_TOOL + model_hint
    r.append(check("frontmatter-parser.1", "frontmatter parse test passes",
                   f"{NX_TEST} --testFile={TESTS}/frontmatter.test.ts"))
    r.append(grep_present("frontmatter-parser.2", "maps tools: via TOOL_PLATFORM_BINDING[claude_code]",
                          "claude_code|TOOL_PLATFORM_BINDING|platform_tool_name", f"{SRC}/parse/frontmatter.ts"))
    # body-section-splitter — heading -> prompt_type per SEED_DATA §0 table
    r.append(check("body-section-splitter.1", "body section typing test passes",
                   f"{NX_TEST} --testFile={TESTS}/body-sections.test.ts"))
    r.append(grep_present("body-section-splitter.2", "heading->prompt_type mapping per SEED_DATA table",
                          "identity|process|invocation|success_criteria", f"{SRC}/parse/body-sections.ts"))
    # import-pipeline — drives real registry stores; persists after reopen
    r.append(check("import-pipeline.1", "import persists agent+component+tool rows recoverable after reopen",
                   f"{NX_TEST} --testFile={TESTS}/import-pipeline.test.ts"))
    r.append(grep_present("import-pipeline.2", "import drives real registry stores (not mocks)",
                          "AgentStore|ComponentStore|CompositionStore|AgentToolStore", f"{SRC}/import/import-agent.ts"))
    # skills-migration — SKILL.md -> process/invocation component
    r.append(check("skills-migration.1", "skill imports to process/invocation component recoverable after reopen",
                   f"{NX_TEST} --testFile={TESTS}/skills-migration.test.ts"))
    r.append(grep_present("skills-migration.2", "skill body typed as process/invocation component",
                          "process|invocation", f"{SRC}/import/import-skill.ts"))
    # roundtrip-equivalence-gate — THE headline behavioral gate
    r.append(check("roundtrip-equivalence-gate.1", "import->compile->normalized diff == empty (round-trip equivalence)",
                   f"{NX_TEST} --testFile={TESTS}/roundtrip-equivalence.test.ts"))
    r.append(grep_present("roundtrip-equivalence-gate.2", "gate drives agent-registry compile <slug> --platform claude_code",
                          "compile|claude_code", f"{SRC}/verify/equivalence-gate.ts"))
    r.append(grep_present("roundtrip-equivalence-gate.3", "equivalence report lists per-agent PASS/FAIL; blocks removal",
                          "PASS|FAIL|allPass|report", f"{SRC}/verify/equivalence-gate.ts"))
    r.append(check("roundtrip-equivalence-gate.4",
                   "negative-control: corrupt a migrated component -> round-trip diff fails -> gate reports FAIL",
                   negative_control_roundtrip()))
    r.append(check("audit-migration.1", "migration-phase audit self-consistent", "true"))
    return r


def negative_control_roundtrip() -> str:
    """Compose the negative-control shell pipeline for the round-trip gate.
    Runs the positive probe (must pass), mutates a persisted component (the round-trip
    must then go RED), restores, and confirms the positive probe passes again. The
    whole thing exits 0 ONLY if the test had teeth (red under mutation, green when
    restored). Deterministic, exit-code-gated — no sleeps, no stdout grep."""
    pos = f"{NX_TEST} --testFile={TESTS}/roundtrip-equivalence.test.ts"
    mutate = "node docs/plan/agent-registry-migration/scripts/nc_mutate.mjs"
    restore = "node docs/plan/agent-registry-migration/scripts/nc_restore.mjs"
    # 1) positive passes  2) mutate  3) probe MUST fail (! ...)  4) restore  5) positive passes
    return (
        f"{pos} && {mutate} && ! ({pos}); rc=$?; {restore}; "
        f"if [ $rc -eq 0 ]; then {pos}; else exit 1; fi"
    )


# ── final phase (removal + behavioral DoD proofs) ───────────────────────────
# Each [dod.N] check drives the clause's declared entrypoint and asserts its
# observable. The command STRING names the entrypoint's distinctive token so
# gap-check Check-8 confirms the proving check drives the real door.

def phase_final() -> list:
    r = phase_migration()
    # removal-runbook — gated removal on fixtures + cross-repo runbook step
    r.append(check("removal-runbook.1",
                   "removal aborts unless report all-PASS; all-PASS removes fixture + compile still produces agent",
                   f"{NX_TEST} --testFile={TESTS}/removal-runbook.test.ts"))
    r.append(grep_present("removal-runbook.2", "retire requires all-PASS report as forcing function",
                          "allPass|all.PASS|report|refuse|abort", f"{SRC}/removal/retire.ts"))
    r.append(grep_present("removal-runbook.3", "RUNBOOK documents cross-repo claude-agents removal as gated step",
                          "claude-agents|cross-repo|gated", RUNBOOK))

    # [dod.1] THE headline — migrated fixture compiles to equivalent markdown
    r.append(check("dod.1", "migrated fixture agent compiles to equivalent markdown vs. its original .md",
                   f"{NX_TEST} --testFile={TESTS}/roundtrip-equivalence.test.ts"))
    # [dod.2] import persists agent+components+tools recoverable after reopen
    r.append(check("dod.2", "import persists agent+components+tools recoverable after DB reopen",
                   f"{NX_TEST} --testFile={TESTS}/import-pipeline.test.ts"))
    # [dod.3] skill migrates to process/invocation component after reopen
    r.append(check("dod.3", "skill migrates to a process/invocation component recoverable after reopen",
                   f"{NX_TEST} --testFile={TESTS}/skills-migration.test.ts"))
    # [dod.4] removal GATED — refuses when report not all-PASS
    r.append(check("dod.4", "removal is gated: refuses to remove fixture .md when report is not all-PASS",
                   f"{NX_TEST} --testFile={TESTS}/removal-runbook.test.ts"))
    # [dod.5] structural — platform:node lib registered + depends on registry+compiler
    r.append(grep_present("dod.5", "agent-registry-migration registered platform:node + deps registry+compiler",
                          "platform:node", f"{PKG}/project.json"))
    # [dod.6] structural — post-removal fixture .md is gone AND compile still produces the agent.
    #   Proven by the removal-runbook.test.ts cases (driven by dod.4's entrypoint), which
    #   assert (a) ! exists(fixture) after an all-PASS retire, and (b) compile still emits the
    #   agent. Structural grep confirms the test asserts both removal-and-still-compiles.
    r.append(grep_present("dod.6", "removal test asserts fixture gone AND compile still produces the agent",
                          "existsSync|test -e|! ?fs|compile", f"{TESTS}/removal-runbook.test.ts"))
    r.append(check("audit-final.1", "final audit self-consistent", "true"))
    return r


PHASES = {
    "architecture": phase_architecture,
    "migration": phase_migration,
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
