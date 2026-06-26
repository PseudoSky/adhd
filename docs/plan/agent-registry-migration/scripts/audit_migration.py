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

OWNER RE-AUTHOR (LLM-driven ingestion pipeline): this plan does the semantic
breakdown UP FRONT and crystallizes into an import script. The flow is:
  corpus-parser (deterministic, 18-type) -> haiku-usecase-batch (LLM fan-out, cheap
  tier) -> sonnet-consolidation (LLM, one pass) -> dataset-build (persist) ->
  import-script (public importCorpus entrypoint, closes FEAT-007) ->
  roundtrip-equivalence-gate -> removal-runbook.

The behavioral Definition-of-Done checks (dod.1..dod.5) DRIVE the real pipeline —
the deterministic corpus parser, the haiku/sonnet ingestion stages, dataset-build,
the importCorpus entrypoint, the round-trip equivalence gate, and the removal
runbook — against a REAL on-disk registry SQLite DB and the REAL
`@adhd/agent-compiler`, via the vitest entrypoints declared in README.md. Each
check() command STRING literally names the clause's `entrypoint:`
(`--testFile=...corpus-parser.test.ts` / `sonnet-consolidation.test.ts` /
`dataset-build.test.ts` / `import-script.test.ts` / `roundtrip-equivalence.test.ts`
/ `removal-runbook.test.ts`) so gap-check Check-8 sees the real door, and the test
files prove persistence by REOPENING the registry store (not in-memory state).

LLM STAGES (haiku-usecase-batch, sonnet-consolidation): drive REAL models via the
agent-mcp provider, gated behind AGENT_REGISTRY_INGEST_LIVE + the corpus-ingest-llm
human-blocker. They SKIP (not fail) offline; a deterministic replay fixture proves
the SHAPE so CI stays green and offline (CLAUDE.md verification standard #5). Never
a faked model on the live path.

18-TYPE COVERAGE (dod.1): the deterministic parser maps the COMMON FORMAT onto the
FULL 18-type component set; the test asserts every type is exercised across the real
corpus OR the residue is flagged in unmapped[] (no silent drop).

ZERO-DATA-LOSS REMOVAL GATE (dod.5): removal is forced to depend on an all-PASS
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

Criterion ID registry (referenced by gap-check.js — every ID listed LITERALLY so
the criterion<->check mirror resolves grep_present/exists checks, not just check()):
  architecture phase:
    [migration-design.1] [migration-design.2] [migration-design.3]
    [migration-design.4] [migration-design.5] [migration-design.6]
  migration phase (architecture + all parse/ingest/import/verify work-state criteria + audit-migration):
    [scaffold-package.1] [scaffold-package.2] [scaffold-package.3] [scaffold-package.4] [scaffold-package.5]
    [corpus-parser.1] [corpus-parser.2] [corpus-parser.3]
    [haiku-usecase-batch.1] [haiku-usecase-batch.2]
    [sonnet-consolidation.1] [sonnet-consolidation.2] [sonnet-consolidation.3]
    [dataset-build.1] [dataset-build.2] [dataset-build.3]
    [import-script.1] [import-script.2] [import-script.3]
    [roundtrip-equivalence-gate.1] [roundtrip-equivalence-gate.2] [roundtrip-equivalence-gate.3] [roundtrip-equivalence-gate.4]
    [audit-migration.1]
  final phase (everything above + removal + behavioral DoD checks + audit-final):
    [removal-runbook.1] [removal-runbook.2] [removal-runbook.3]
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
    r.append(grep_present("migration-design.2", "parser + FULL 18-type mapping strategy recorded (no silent drop)",
                          "18-type|eighteen|unmapped|prompt.?type", DECISIONS))
    r.append(grep_present("migration-design.3", "LLM pipeline contract recorded (haiku fan-out + sonnet consolidation, live/replay)",
                          "haiku|sonnet|fan-out|consolidat|replay|INGEST_LIVE", DECISIONS))
    r.append(grep_present("migration-design.4", "anchor-vocabulary linkage to Plan 8 recorded (seed here, backfill there)",
                          "anchor|Plan 8|agent-mcp-authoring|enrich", DECISIONS))
    r.append(grep_present("migration-design.5", "FEAT-007 public importCorpus entrypoint + equivalence/zero-loss + cross-repo recorded",
                          "FEAT-007|importCorpus|zero.data.loss|round-trip|claude-agents|cross-repo", DECISIONS))
    r.append(exists("migration-design.6", "fixture agent .md checked in", f"{FIX}/code-reviewer.md"))
    r.append(exists("migration-design.6b", "fixture SKILL.md checked in", f"{FIX}/ticket-creation.SKILL.md"))
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
    # corpus-parser — deterministic COMMON-FORMAT parse onto the FULL 18-type set; 18-type coverage / unmapped-flag teeth
    r.append(check("corpus-parser.1", "deterministic frontmatter+body parse (no LLM); recoverable shape",
                   f"{NX_TEST} --testFile={TESTS}/corpus-parser.test.ts"))
    r.append(grep_present("corpus-parser.2", "heading->prompt_type table over the 18-type set; tools via TOOL_PLATFORM_BINDING[claude_code]",
                          "claude_code|TOOL_PLATFORM_BINDING|prompt.?type|role|identity|invocation", f"{SRC}/parse/component-mapping.ts"))
    r.append(check("corpus-parser.3", "driven over the REAL corpus: all 18 types exercised OR residue flagged (no silent drop)",
                   f"{NX_TEST} --testFile={TESTS}/corpus-parser.test.ts"))
    # haiku-usecase-batch — LLM fan-out (cheap tier), candidate use-cases per component; gated skip-not-fail
    r.append(check("haiku-usecase-batch.1", "haiku fan-out emits >=1 candidate use-case per parsed component",
                   f"{NX_TEST} --testFile={TESTS}/haiku-usecase-batch.test.ts"))
    r.append(grep_present("haiku-usecase-batch.2", "LLM stage gated behind AGENT_REGISTRY_INGEST_LIVE; skips (not fails) offline",
                          "AGENT_REGISTRY_INGEST_LIVE|skip|replay", f"{SRC}/ingest/haiku-batch.ts"))
    # sonnet-consolidation — one LLM pass: canonical vocabulary (smaller) + weighted links; gated skip-not-fail
    r.append(check("sonnet-consolidation.1", "sonnet consolidates candidates into a smaller canonical vocabulary + weighted links",
                   f"{NX_TEST} --testFile={TESTS}/sonnet-consolidation.test.ts"))
    r.append(grep_present("sonnet-consolidation.2", "LLM stage gated behind AGENT_REGISTRY_INGEST_LIVE; skips (not fails) offline",
                          "AGENT_REGISTRY_INGEST_LIVE|skip|replay", f"{SRC}/ingest/sonnet-consolidate.ts"))
    r.append(grep_present("sonnet-consolidation.3", "consolidated vocabulary is the named ANCHOR vocabulary Plan 8 enrichment resolves against",
                          "anchor|Plan 8|agent-mcp-authoring|enrich", f"{SRC}/ingest/usecase-vocabulary.ts"))
    # dataset-build — populate the REAL registry (components+use-cases+weighted links); reopen-proves-persistence
    r.append(check("dataset-build.1", "dataset-build persists components+use-cases+weighted links recoverable after reopen",
                   f"{NX_TEST} --testFile={TESTS}/dataset-build.test.ts"))
    r.append(grep_present("dataset-build.2", "writes anchor embeddings via the Plan 8 substrate (enrich/usecase-anchors)",
                          "usecase-anchors|anchor|enrich|agent-registry", f"{SRC}/ingest/dataset-build.ts"))
    r.append(grep_present("dataset-build.3", "drives the real registry stores (not mocks)",
                          "ComponentStore|UseCaseStore|AgentStore|AgentToolStore|linkComponent", f"{SRC}/ingest/dataset-build.ts"))
    # import-script — the public importCorpus entrypoint (FEAT-007); folds in skills; replay deterministic
    r.append(check("import-script.1", "public importCorpus entrypoint runs the pipeline; rows recoverable after reopen",
                   f"{NX_TEST} --testFile={TESTS}/import-script.test.ts"))
    r.append(grep_present("import-script.2", "importCorpus folds in SKILL.md -> process/invocation component",
                          "process|invocation|skill", f"{SRC}/import/import-skill.ts"))
    r.append(grep_present("import-script.3", "importCorpus is a public entrypoint (lib export + CLI bin), closes FEAT-007",
                          "importCorpus|FEAT-007|bin", f"{SRC}/import/import-corpus.ts"))
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

    # Behavioral DoD checks. The command STRING uses the LITERAL full test path (not
    # {TESTS}/…), because gap-check Check-8 reads this script as TEXT and binds each
    # [dod.N] to the proving check by matching the entrypoint's distinctive token —
    # an unexpanded f-string var would hide that token (team-lead amendment note).
    # [dod.1] the deterministic parser maps onto the FULL 18-type set; coverage / no-silent-drop teeth.
    r.append(check("dod.1", "parser exercises all 18 component types across the corpus OR flags the residue (no silent drop)",
                   "npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/corpus-parser.test.ts"))
    # [dod.1] tooth: the test must itself assert 18-type coverage / unmapped-flag (no silent drop).
    r.append(grep_present("dod.1.tooth", "corpus-parser test asserts 18-type coverage / unmapped-flag (no silent drop)",
                          "18|eighteen|unmapped|no.silent.drop|coverage", f"{TESTS}/corpus-parser.test.ts"))
    # [dod.2] haiku fan-out + sonnet consolidation: candidate-per-component, smaller canonical weighted vocabulary.
    # The check ASSERTS the observable: a static `grep -q` tooth proves the test carries the
    # strictly-smaller-vocabulary + skip-gate assertions BEFORE the run is trusted (not a bare run).
    r.append(check("dod.2", "consolidation test asserts |canonical|<|raw union| + skip-gate (grep -q tooth) THEN runs the haiku+sonnet pipeline",
                   "grep -qE 'smaller|length|dedup|<|AGENT_REGISTRY_INGEST_LIVE' packages/ai/agent-registry-migration/src/__tests__/sonnet-consolidation.test.ts "
                   "&& npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/sonnet-consolidation.test.ts"))
    # [dod.2] tooth: the consolidation test asserts the canonical vocabulary is strictly smaller (dedup happened).
    r.append(grep_present("dod.2.tooth", "consolidation test asserts canonical vocabulary smaller than the raw candidate union + skip-gate",
                          "smaller|length|dedup|<|AGENT_REGISTRY_INGEST_LIVE|skip", f"{TESTS}/sonnet-consolidation.test.ts"))
    # [dod.3] dataset-build persists components+use-cases+weighted links recoverable after reopen.
    r.append(check("dod.3", "dataset-build persists components+use-cases+weighted links recoverable after DB reopen",
                   "npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/dataset-build.test.ts"))
    # [dod.3] tooth: the test reopens the DB and asserts link weights survive.
    r.append(grep_present("dod.3.tooth", "dataset-build test reopens the DB and asserts weighted links persist",
                          "reopen|weight|new Database|close", f"{TESTS}/dataset-build.test.ts"))
    # [dod.4] the public importCorpus entrypoint (FEAT-007): runs the pipeline, folds skills, replay deterministic.
    r.append(check("dod.4", "public importCorpus entrypoint runs the pipeline; skills folded; replay deterministic; recoverable after reopen",
                   "npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/import-script.test.ts"))
    # [dod.4] tooth: the test asserts importCorpus + skill import + deterministic replay (twice -> equal).
    r.append(grep_present("dod.4.tooth", "import-script test asserts importCorpus + skill (process/invocation) + deterministic replay",
                          "importCorpus|replay|process|invocation|reopen", f"{TESTS}/import-script.test.ts"))
    # [dod.5] round-trip equivalence + zero-data-loss gated removal.
    r.append(check("dod.5", "migrated agent round-trips to equivalent markdown; removal refuses unless report all-PASS",
                   "npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/removal-runbook.test.ts"))
    # [dod.5] tooth: removal test asserts fixture gone AND compile still produces the agent on all-PASS; refuses on FAIL.
    r.append(grep_present("dod.5.tooth", "removal test asserts gated removal (refuse on FAIL; on all-PASS md gone AND compile still produces agent)",
                          "existsSync|test -e|! ?fs|compile|allPass|all.PASS|refuse|abort", f"{TESTS}/removal-runbook.test.ts"))
    # [dod.6] structural — platform:node lib registered + depends on registry+compiler
    r.append(grep_present("dod.6", "agent-registry-migration registered platform:node + deps registry+compiler",
                          "platform:node", f"{PKG}/project.json"))
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
