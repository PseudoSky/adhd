#!/usr/bin/env python3
"""
audit_authoring.py — phase-scoped audit for the agent-mcp-authoring plan (8/9).

Usage:
  python3 docs/plan/agent-mcp-authoring/scripts/audit_authoring.py --phase architecture
  python3 docs/plan/agent-mcp-authoring/scripts/audit_authoring.py --phase final

Every guard is env-pinned: `npx --yes nx ...` and `python3 ...` — never a bare
`nx`/`tsc`, so the gate measures the code, not the ambient PATH.

This plan adds a DEFINITION lane (compose agents from registry components over
MCP) on top of the runtime. The behavioral Definition-of-Done checks DRIVE the
real MCP tools / enrichment pipeline / composition journey against a real
on-disk SQLite registry via the vitest entrypoints declared in README.md. Each
check() command STRING literally names the clause's `entrypoint:` distinctive
token (the `--testFile=...` token) so gap-check Check-8 sees the real door, and
the test files prove persistence/idempotence by REOPENING the store (not reading
in-memory state). Vitest checks trust the EXIT CODE, never `grep -q passed`
(better-sqlite3 can segfault on teardown — project memory).

HARD CONSTRAINT (the owner's agent-mcp back-out guarantee): agent-mcp /
agent-mcp-types source is touched ONLY under this plan's opt-in states, listed in
decisions.md's modification manifest. The final phase asserts (a) the manifest
exists, (b) the full pre-existing agent-mcp test suite stays green
(non-regression), and (c) no agent-mcp src file outside the manifest was touched.

OWNER AMENDMENT (live-provider matrix, no mocks): the e2e proofs drive REAL LLM
providers, never a scripted/mock provider. dod.5's composition journey runs the
agent on a REAL provider (default claudecli; no mock on the run path). dod.6 runs
the live journey across the {anthropic (useClaudeOauth keychain), claudecli,
lmstudio (baseURL)} provider MATRIX, per-provider availability gating each case
(skip-not-fail), the whole matrix skipped offline when AGENT_MCP_LIVE is unset.
Per-provider prerequisites are human-blockers in human-blockers.json.

Criterion ID registry (referenced by gap-check.js):
  architecture phase:
    [authoring-design.1..4]
  final phase (everything above + work-state criteria + behavioral DoD checks):
    [embedding-substrate.1] [enrichment-pipeline.1] [name-slug-seam.1]
    [discovery-tools.1] [component-define.1] [agent-define.1] [compat-shim.1]
    [versioning.1] [composition-journey-e2e.1] [live-model-e2e.1]
    [dod.1] [dod.2] [dod.3] [dod.4] [dod.5] [dod.6] [dod.7] [dod.8]

Exits 0 when all checks in the phase pass; exits 1 with a failure summary otherwise.
"""

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass

# Repo root is four levels up (docs/plan/agent-mcp-authoring/scripts/ -> root).
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
PLAN = "docs/plan/agent-mcp-authoring"
DECISIONS = f"{PLAN}/decisions.md"
MCP = "packages/ai/agent-mcp"
REG = "packages/ai/agent-registry"
MCP_TESTS = f"{MCP}/src/__tests__"
REG_TESTS = f"{REG}/src/__tests__"
TYPES = "packages/ai/agent-mcp-types"


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str = ""


def run(cmd: str):
    p = subprocess.run(cmd, shell=True, cwd=REPO_ROOT, capture_output=True, text=True)
    return p.returncode, (p.stdout + p.stderr).strip()


def check(check_id: str, description: str, cmd: str, expect_empty: bool = False) -> CheckResult:
    # F-P6-10 hardening: project.json sets passWithNoTests:true, so a
    # `nx test --testFile=<missing>` exits 0 ("No test files found") — a GHOST
    # PASS that would green an audit for a proof that does not exist. Require the
    # test file to exist first, so a missing proof FAILS the criterion honestly.
    _m = re.search(r"--testFile=(\S+)", cmd)
    if _m and not cmd.lstrip().startswith("test -f"):
        cmd = f"test -f {_m.group(1)} && {cmd}"
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
    ok = (code != 0)
    return CheckResult(f"[{check_id}] {description}", ok, "" if ok else f"forbidden pattern found:\n{out}")


# ── architecture phase — the design gate (decisions.md, no src change) ───────

def phase_architecture() -> list:
    r = []
    r.append(exists("authoring-design.0", "decisions.md exists", DECISIONS))
    # [authoring-design.1..4] mirror the context criteria (markers in decisions.md).
    r.append(grep_present("authoring-design.1", "embedding-source decision recorded",
                          "def:embedding-source", DECISIONS))
    r.append(grep_present("authoring-design.2", "name<->slug translation-seam policy recorded",
                          "def:name-slug-seam", DECISIONS))
    r.append(grep_present("authoring-design.3", "agent-mcp modification manifest recorded (opt-in reversible gate)",
                          "def:agent-mcp-modification-manifest", DECISIONS))
    r.append(grep_present("authoring-design.4", "agent_define transaction + sequencing-after-Plan-6 recorded",
                          "def:agent-define-transaction", DECISIONS))
    # The modification manifest must name the baseline ref + the non-regression guard.
    r.append(grep_present("authoring-design.5", "manifest cites a pre-plan baseline git ref + non-regression guard",
                          "baseline-ref|baseline ref|non-regression", DECISIONS))
    return r


# ── final phase — work-state criteria + behavioral DoD + back-out guarantee ──

def phase_final() -> list:
    r = phase_architecture()

    # ── work-state criteria (each drives its real test entrypoint) ──
    r.append(check("embedding-substrate.1", "deterministic embedding + use-case anchors rank a match first",
                   f"npx --yes nx test agent-registry --testFile={REG_TESTS}/embedding-substrate.test.ts"))
    r.append(check("enrichment-pipeline.1", "enrichComponent embeds+resolves+summarizes; idempotent on identical content",
                   f"npx --yes nx test agent-registry --testFile={REG_TESTS}/enrichment-pipeline.test.ts"))
    r.append(check("name-slug-seam.1", "bridge translates name->slug inbound, strips slug outbound (no slug on the wire)",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/name-slug-seam.test.ts"))
    r.append(check("discovery-tools.1", "all discovery tools return name-keyed results over the real stores",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/discovery-tools.test.ts"))
    # discovery-tools.2 — BUG-003: list/search tools bounded by default. Drives a
    # store seeded N>>limit; asserts <=limit summary-projected items, no full
    # systemPrompt/body inline, total output under a KB-scale ceiling (the 464,821-char
    # blowout cannot recur). Real tools over the bridge + real store; no mocks.
    r.append(check("discovery-tools.2", "BUG-003: agent_list/component_search/*_list bounded by default (N>>limit -> <=limit summary items, no full body inline, output under ceiling)",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/discovery-bounded-output.test.ts"))
    r.append(check("component-define.1", "component_define upsert enriches on write, version-bumps on change, idempotent",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/component-define.test.ts"))
    # component-define.2 — component_delete pairs creation with deletion. Behavioral
    # proof (define->delete leaves no trace, reopen-proven; typed errors; no orphan)
    # + a structural tooth that the delete op is actually registered in the lane.
    r.append(check("component-define.2", "component_delete: define->delete leaves no trace (reopen-proven), COMPONENT_NOT_FOUND on unknown, no-orphan on shared-with-consumers",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/component-define.test.ts"))
    r.append(grep_present("component-define.2.tool", "component_delete is registered in the authoring lane",
                          "component_delete", f"{MCP}/src/tools/authoring.ts"))
    r.append(check("agent-define.1", "agent_define declarative upsert: full-replace, version-bump, idempotent, typed errors",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/agent-define.test.ts"))
    r.append(check("compat-shim.1", "agent_create({systemPrompt}) compat shim + VALIDATION_ERROR on both + 11-tool surface intact",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/systemprompt-compat.test.ts"))
    r.append(grep_present("versioning.1", "package.json is agent-mcp@2.x",
                          '"version": "2\\.', f"{MCP}/package.json"))
    r.append(check("composition-journey-e2e.1", "SPEC §7 journey over MCP wire + compiler CLI; composed agent runs a task",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/composition-journey-e2e.test.ts"))
    r.append(check("live-model-e2e.1", "AGENT_MCP_LIVE-gated real-model journey; skips when unset; empty-registry teeth",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/authoring-live-e2e.test.ts"))

    # ── behavioral DoD checks (drive the clause entrypoint, assert observable) ──
    # [dod.1] component_define auto-enrichment (content-only -> summary+use_cases+weights)
    r.append(check("dod.1", "component_define returns auto-derived summary+use_cases (no agent-supplied weights); idempotent",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/component-define.test.ts"))
    # [dod.2] component_search semantic auto-ranking
    r.append(check("dod.2", "component_search ranks a semantically-matching component above an unrelated one",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/discovery-tools.test.ts"))
    # [dod.3] agent_define one declarative idempotent upsert
    r.append(check("dod.3", "agent_define composes in one upsert; idempotent re-define = changed:false, no version bump",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/agent-define.test.ts"))
    # [dod.4] name-only on the wire; slug never leaks (recursive scan in the test)
    r.append(check("dod.4", "no slug field appears in any authoring/discovery tool response (name is identity)",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/name-slug-seam.test.ts"))
    # [dod.5] the full SPEC §7 journey over the PUBLIC surface, zero internal/src imports,
    # with the agent RUN step on a REAL provider (no mock on the run path).
    # The check ASSERTS the observable: static `grep -q` teeth prove the e2e test
    # carries (a) the no-src-import scan AND (b) the real-provider run-path guard
    # BEFORE the journey run is trusted (not a bare test run).
    r.append(check("dod.5", "composition e2e statically asserts NO packages/ai/**/src import + REAL provider on the run path (grep -q teeth) THEN runs over MCP wire + CLI bin",
                   "grep -qE 'no-src-import|importScan|packages/ai/[^ ]+/src' packages/ai/agent-mcp/src/__tests__/composition-journey-e2e.test.ts "
                   "&& grep -qE 'claudecli|anthropic|lmstudio|real.?provider|no-mock' packages/ai/agent-mcp/src/__tests__/composition-journey-e2e.test.ts "
                   "&& npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/composition-journey-e2e.test.ts"))
    # [dod.5] tooth: the e2e test must itself contain the import-scan guard so a deep import is caught.
    r.append(grep_present("dod.5.tooth", "composition e2e asserts NO packages/ai/**/src import is used",
                          "src/|no-src-import|importScan|deep import",
                          f"{MCP_TESTS}/composition-journey-e2e.test.ts"))
    # [dod.5] tooth-2: the run path uses a REAL provider, not the scripted/mock double.
    r.append(grep_present("dod.5.realprovider", "composition e2e runs the agent on a REAL provider (claudecli/anthropic/lmstudio), not a mock",
                          "claudecli|anthropic|lmstudio|real.?provider|no-mock",
                          f"{MCP_TESTS}/composition-journey-e2e.test.ts"))
    # [dod.6] live-model end-to-end across the REAL-PROVIDER MATRIX. The check ASSERTS the
    # observable: `grep -q` teeth prove the test carries the AGENT_MCP_LIVE skip-gate, the
    # stopReason/agent_define completion assertion, AND all three matrix providers
    # (anthropic + claudecli + lmstudio) BEFORE the gated real-model runs are trusted.
    r.append(check("dod.6", "live e2e asserts AGENT_MCP_LIVE skip-gate + stopReason/agent_define completion + {anthropic,claudecli,lmstudio} provider matrix (grep -q teeth) THEN runs the gated real-model journey per provider",
                   "grep -qE 'AGENT_MCP_LIVE' packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts "
                   "&& grep -qE 'stopReason|agent_define' packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts "
                   "&& grep -qE 'anthropic' packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts "
                   "&& grep -qE 'claudecli' packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts "
                   "&& grep -qE 'lmstudio' packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts "
                   "&& grep -qE 'useClaudeOauth|baseURL|LMSTUDIO_BASE_URL' packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts "
                   "&& npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts"))
    # [dod.6] tooth: the live e2e must contain the skip-gate + completion assertion so an empty/canned run is caught.
    r.append(grep_present("dod.6.tooth", "live e2e asserts AGENT_MCP_LIVE skip-gate and stopReason completed",
                          "AGENT_MCP_LIVE|stopReason|completed",
                          f"{MCP_TESTS}/authoring-live-e2e.test.ts"))
    # [dod.6] tooth-2: all three real providers in the matrix are exercised (anthropic OAuth keychain + claudecli + lmstudio baseURL).
    r.append(grep_present("dod.6.matrix", "live e2e exercises the {anthropic,claudecli,lmstudio} real-provider matrix with per-provider config",
                          "anthropic.*claudecli|claudecli.*lmstudio|useClaudeOauth|LMSTUDIO_BASE_URL",
                          f"{MCP_TESTS}/authoring-live-e2e.test.ts"))
    # [dod.7] flat systemPrompt is a deprecated compat shim; 11-tool hot path unchanged; 2.0.0
    r.append(check("dod.7", "systemPrompt compat shim + mutual-exclusion error + unchanged 11-tool delegation surface",
                   f"npx --yes nx test agent-mcp --testFile={MCP_TESTS}/systemprompt-compat.test.ts"))
    r.append(grep_present("dod.7.version", "agent-mcp@2.0.0 (breaking required->optional systemPrompt)",
                          '"version": "2\\.0\\.', f"{MCP}/package.json"))

    # [dod.8] AGENT-MCP BACK-OUT GUARANTEE — the opt-in reversible gate.
    # (a) decisions.md carries the modification manifest (the only place src changes are sanctioned).
    r.append(grep_present("dod.8.manifest", "agent-mcp modification manifest exists in decisions.md",
                          "def:agent-mcp-modification-manifest", DECISIONS))
    # (b) NON-REGRESSION: the full pre-existing agent-mcp suite stays green (sessions/tasks/DAG/HITL/streaming/usage).
    r.append(check("dod.8.nonregression", "full pre-existing agent-mcp test suite green (non-regression guard)",
                   "npx --yes nx test agent-mcp"))
    # (c) agent-mcp builds clean at 2.0.0.
    r.append(check("dod.8.build", "agent-mcp builds clean", "npx --yes nx build agent-mcp"))
    # (d) The byte-back-out check: every changed agent-mcp src file is listed in the manifest.
    #     Driven by a vendored helper that diffs `git` changes under packages/ai/agent-mcp{,-types}/src
    #     against the manifest's enumerated paths; PASS iff the change set is a subset of the manifest.
    r.append(check("dod.8.manifest-diff", "no agent-mcp src file changed outside the recorded manifest",
                   f"python3 {PLAN}/scripts/check_manifest.py"))

    r.append(check("audit-final.1", "final audit self-consistent", "true"))
    return r


PHASES = {
    "architecture": phase_architecture,
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
