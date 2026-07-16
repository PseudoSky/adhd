#!/usr/bin/env python3
"""
audit_credentialing.py — phase-scoped audit for the agent-provider-credentialing plan.

Usage:
  python3 docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py --phase contract
  python3 docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py --phase runtime
  python3 docs/plan/agent-provider-credentialing/scripts/audit_credentialing.py --phase audit

Every guard is env-pinned: `npx --yes nx ...`, `python3 ...`, `bash <script>.sh`,
`git ...`, `test -f` — never a bare `nx`/`tsc`, so the gate measures the code, not
the ambient PATH.

The behavioral Definition-of-Done checks ([dod.2..6]) DRIVE the clause's declared
`entrypoint:` — each check() command STRING literally names the test file token
(`credential-inference.test.ts`, `dotenv-load.test.ts`, `backcompat-normalize.test.ts`,
`openai-compat-roundtrip.e2e.test.ts`) so gap-check Check-8 confirms the proving
check drives the real door. We trust the runner EXIT CODE, never `grep -q passed`
(better-sqlite3 can segfault on teardown — project memory).

Criterion ID registry (mirrors scripts/criteria.json; referenced by gap-check.js):
  contract phase:
    [unified-credential-contract.1..4]
  runtime phase (contract + runtime work states):
    [provider-credential-runtime.1..6]
    [lmstudio-removal.1..6]
  audit phase (everything above + env + backcompat + audit + behavioral DoD):
    [dotenv-dual-load.1..4]
    [backcompat-normalizer.1..2]
    [audit-credentialing.1..3]
    [dod.1] [dod.2] [dod.3] [dod.4] [dod.5] [dod.6] [dod.7] [dod.8]

Exits 0 when all checks in the phase pass; exits 1 with a failure summary otherwise.
"""

import argparse
import os
import subprocess
import sys
from dataclasses import dataclass

# Repo root is four levels up from this script
# (docs/plan/agent-provider-credentialing/scripts/ -> repo root).
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
SCRIPTS = "docs/plan/agent-provider-credentialing/scripts"

TYPES_DOMAIN = "packages/ai/agent-mcp-types/src/domain.ts"
MCP = "packages/ai/agent-mcp/src"
PROVIDERS = f"{MCP}/providers"
VALIDATION = f"{MCP}/validation/agent.ts"
TESTS = f"{MCP}/__tests__"
PROVIDER_SEED = "packages/ai/agent-provider/src/seed/providers.ts"


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str = ""


def run(cmd: str):
    p = subprocess.run(cmd, shell=True, cwd=REPO_ROOT, capture_output=True, text=True)
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
    return CheckResult(f"[{check_id}] {description}", code == 0,
                       "" if code == 0 else f"pattern not found: {pattern} in {paths}")


def grep_absent(check_id: str, description: str, pattern: str, paths: str) -> CheckResult:
    code, out = run(f"grep -rEn -- {pattern!r} {paths}")
    return CheckResult(f"[{check_id}] {description}", code != 0,
                       "" if code != 0 else f"forbidden pattern found:\n{out}")


def negative_control(check_id: str, description: str, positive: str, mutate: str, restore: str) -> CheckResult:
    """Teeth: positive must PASS clean, FAIL after mutate, then we always restore.
    Proves the assertion has real teeth (a reintroduced bug turns it red)."""
    pre_code, _ = run(positive)
    if pre_code != 0:
        run(restore)
        return CheckResult(f"[{check_id}] {description}", False,
                           "positive probe did not pass before mutation (test not green at baseline)")
    run(mutate)
    broken_code, _ = run(positive)
    run(restore)  # always restore, even if assertions below fail
    passed = broken_code != 0
    return CheckResult(f"[{check_id}] {description}", passed,
                       "" if passed else "MUTATED code still passed — the assertion has NO teeth")


# ── contract phase ───────────────────────────────────────────────────────────

def phase_contract() -> list:
    r = []
    r.append(grep_present("unified-credential-contract.1", "domain.ts declares credentialEnv",
                          "credentialEnv", TYPES_DOMAIN))
    r.append(grep_present("unified-credential-contract.2", "domain.ts declares credentialType",
                          "credentialType", TYPES_DOMAIN))
    r.append(grep_absent("unified-credential-contract.3", "registry seed has no lmstudio provider row",
                         r'id:[[:space:]]*"lmstudio"', PROVIDER_SEED))
    r.append(check("unified-credential-contract.4", "agent-provider registry round-trip test passes",
                   "npx --yes nx test agent-provider --testFile=packages/ai/agent-provider/src/__tests__/roundtrip.test.ts"))
    return r


# ── runtime phase (contract + runtime work states) ───────────────────────────

def phase_runtime() -> list:
    r = phase_contract()
    # provider-credential-runtime
    r.append(grep_present("provider-credential-runtime.1", "openai.ts resolves credentialEnv",
                          "credentialEnv", f"{PROVIDERS}/openai.ts"))
    r.append(grep_absent("provider-credential-runtime.2", 'openai.ts has no ?? "lmstudio" placeholder',
                         r'\?\?[[:space:]]*"lmstudio"', f"{PROVIDERS}/openai.ts"))
    r.append(grep_present("provider-credential-runtime.3", "anthropic.ts reads credentialEnv",
                          "credentialEnv", f"{PROVIDERS}/anthropic.ts"))
    r.append(grep_present("provider-credential-runtime.4", "anthropic.ts passes baseURL to the SDK",
                          "baseURL", f"{PROVIDERS}/anthropic.ts"))
    r.append(grep_present("provider-credential-runtime.5", "claudecli.ts exports ANTHROPIC_BASE_URL",
                          "ANTHROPIC_BASE_URL", f"{PROVIDERS}/claudecli.ts"))
    r.append(check("provider-credential-runtime.6", "credential-inference unit test passes",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/credential-inference.test.ts"))
    # lmstudio-removal
    r.append(check("lmstudio-removal.1", "providers/lmstudio.ts is deleted",
                   f"test ! -f {PROVIDERS}/lmstudio.ts"))
    r.append(grep_absent("lmstudio-removal.2", 'factory.ts has no case "lmstudio"',
                         r'case "lmstudio"', f"{PROVIDERS}/factory.ts"))
    r.append(grep_absent("lmstudio-removal.3", "validation has no lmstudioProviderSchema",
                         "lmstudioProviderSchema", VALIDATION))
    r.append(grep_absent("lmstudio-removal.4", "domain.ts union has no lmstudio member",
                         r'type: "lmstudio"', TYPES_DOMAIN))
    r.append(grep_absent("lmstudio-removal.5", "providers/index.ts no longer exports LMStudioProvider",
                         "LMStudioProvider", f"{PROVIDERS}/index.ts"))
    r.append(check("lmstudio-removal.6", "agent-mcp builds clean after lmstudio removal",
                   "npx --yes nx build agent-mcp"))
    return r


# ── audit phase (everything + env + backcompat + behavioral DoD) ─────────────

def phase_audit() -> list:
    r = phase_runtime()
    # dotenv-dual-load
    r.append(grep_present("dotenv-dual-load.1", "env loader targets .adhd/agent-mcp/.env",
                          r"\.adhd/agent-mcp/\.env", f"{MCP}/utils/load-env.ts"))
    r.append(exists("dotenv-dual-load.2", ".env.example documents the unified shape",
                    "packages/ai/agent-mcp/.env.example"))
    r.append(check("dotenv-dual-load.3", "dual .env load resolves project-over-home (unit test)",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/dotenv-load.test.ts"))
    r.append(check("dotenv-dual-load.4", "project .adhd/agent-mcp/.env destination is gitignored",
                   "git check-ignore -q .adhd/agent-mcp/.env"))
    # backcompat-normalizer
    r.append(grep_present("backcompat-normalizer.1", "validation adds a normalize-on-load preprocess",
                          "preprocess", VALIDATION))
    r.append(check("backcompat-normalizer.2", "legacy config normalizes + real agents.db rows parse",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/backcompat-normalize.test.ts"))
    # audit-credentialing
    r.append(check("audit-credentialing.1", "no LM Studio secret in any tracked file (incl PROPOSAL.md); .env gitignored",
                   f"bash {SCRIPTS}/check-no-secrets.sh"))
    r.append(check("audit-credentialing.2", "live openai_compat_roundtrip drives the real openai adapter",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/integration/openai-compat-roundtrip.e2e.test.ts"))
    r.append(negative_control("audit-credentialing.3",
                              "teeth: breaking openai credential resolution fails the flow RED even with box down",
                              f"npx --yes nx test agent-mcp --testFile={TESTS}/integration/openai-compat-roundtrip.e2e.test.ts",
                              f"node {SCRIPTS}/nc_break_credential.mjs",
                              "git checkout -- packages/ai/agent-mcp/src/providers/openai.ts"))

    # ── Behavioral + structural Definition-of-Done checks ──
    # [dod.1] structural — unified contract present, lmstudio absent everywhere
    dod1_ok = (
        run(f"grep -rEq -- 'credentialEnv' {TYPES_DOMAIN} {VALIDATION}")[0] == 0
        and run(f"grep -rEq -- 'credentialType' {TYPES_DOMAIN} {VALIDATION}")[0] == 0
        and run(f"grep -rEn -- 'type: \"lmstudio\"' {TYPES_DOMAIN}")[0] != 0
        and run(f"grep -rEn -- '\\?\\?[[:space:]]*\"lmstudio\"' {PROVIDERS}/openai.ts")[0] != 0
        and run(f"grep -rEn -- 'id:[[:space:]]*\"lmstudio\"' {PROVIDER_SEED}")[0] != 0
    )
    r.append(CheckResult("[dod.1] unified credentialEnv/credentialType contract; lmstudio type gone everywhere",
                         dod1_ok, "" if dod1_ok else "contract not unified or a lmstudio type remains"))
    # [dod.2] behavioral — anthropic infers x-api-key vs Bearer (drives credential-inference.test.ts)
    r.append(check("dod.2", "anthropic infers sk-ant-api->x-api-key / sk-ant-oat->Bearer",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/credential-inference.test.ts"))
    # [dod.3] behavioral — missing credential fails loud for non-localhost openai (same entrypoint)
    r.append(check("dod.3", "missing credential fails loud for a non-localhost openai baseURL",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/credential-inference.test.ts"))
    # [dod.4] behavioral — dual .env resolves project-over-home
    r.append(check("dod.4", "dual .env load resolves project over home",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/dotenv-load.test.ts"))
    # [dod.5] behavioral — legacy normalizes + real agents.db parses
    r.append(check("dod.5", "legacy lmstudio/apiKeyEnv normalizes + real agents.db rows parse",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/backcompat-normalize.test.ts"))
    # [dod.6] behavioral — live openai round-trip against the LM Studio box
    r.append(check("dod.6", "live openai_compat_roundtrip returns a real completion (or loud-skips network leg)",
                   f"npx --yes nx test agent-mcp --testFile={TESTS}/integration/openai-compat-roundtrip.e2e.test.ts"))
    # [dod.7] structural — zero secrets in any tracked file
    r.append(check("dod.7", "zero LM Studio secrets in any tracked file (incl docs/mcp-env/PROPOSAL.md)",
                   f"bash {SCRIPTS}/check-no-secrets.sh"))
    # [dod.8] structural — baseURL honored by every provider
    dod8_ok = (
        run(f"grep -rEq -- 'baseURL' {PROVIDERS}/anthropic.ts")[0] == 0
        and run(f"grep -rEq -- 'ANTHROPIC_BASE_URL' {PROVIDERS}/claudecli.ts")[0] == 0
        and run(f"grep -rEq -- 'baseURL' {PROVIDERS}/openai.ts")[0] == 0
    )
    r.append(CheckResult("[dod.8] baseURL honored by anthropic (SDK), claudecli (ANTHROPIC_BASE_URL), openai",
                         dod8_ok, "" if dod8_ok else "a provider does not honor baseURL"))
    return r


PHASES = {
    "contract": phase_contract,
    "runtime": phase_runtime,
    "audit": phase_audit,
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
