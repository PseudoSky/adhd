#!/usr/bin/env python3
"""
audit_provider.py — phase-scoped audit for the agent-provider plan (3/7).

Usage:
  python3 docs/plan/agent-provider/scripts/audit_provider.py --phase schema
  python3 docs/plan/agent-provider/scripts/audit_provider.py --phase final

Every guard is env-pinned: `npx --yes nx ...` and `python3 ...` — never a bare
`nx`/`tsc`, so the gate measures the code, not the ambient PATH.

The behavioral Definition-of-Done checks (dod.1, dod.2, dod.3) DRIVE the real
ModelStore binding resolver / the FEAT-007 tool emitter / the seeder against a
real on-disk SQLite DB via the vitest entrypoints declared in README.md. Each
check() command STRING literally names the clause's `entrypoint:` (the
`--testFile=...binding-store.test.ts` / `emit-tools.test.ts` / `roundtrip.test.ts`
token) so gap-check Check-8 sees the real door, and the test files prove
persistence by REOPENING the store (not reading in-memory state).

Criterion ID registry (referenced by gap-check.js):
  schema phase (foundation + schema work-state criteria + audit-schema):
    [scaffold-package.1..5]
    [provider-and-model-schema.1..3]
    [model-platform-bindings.1..4]
    [provider-tool-formats.1..2]
    [audit-schema.1]
  final phase (everything above + adapter/runtime/seed criteria + behavioral
  DoD checks + audit-final):
    [provider-adapter-contract.1..3]
    [runtime-tool-forwarding.1..4]
    [seed-and-roundtrip.1..4]
    [audit-final.1]
    [dod.1] [dod.2] [dod.3] [dod.4] [dod.5] [dod.6]

Exits 0 when all checks in the phase pass; exits 1 with a failure summary otherwise.
"""

import argparse
import subprocess
import sys
from dataclasses import dataclass

# Repo root is four levels up from this script
# (docs/plan/agent-provider/scripts/ -> repo root).
import os
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
PKG = "packages/ai/agent-provider"
SCHEMA = f"{PKG}/src/db/schema.ts"
TESTS = f"{PKG}/src/__tests__"
MODEL_STORE = f"{PKG}/src/store/model-store.ts"
EMIT_TOOLS = f"{PKG}/src/runtime/emit-tools.ts"
TYPES_DOMAIN = "packages/ai/agent-mcp-types/src/domain.ts"


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
    Signature matches gap-check.js 3-arg pattern: check(id, description, cmd).
    For vitest entrypoints we trust the EXIT CODE, never stdout `grep -q passed`
    (better-sqlite3 can segfault on teardown — project memory)."""
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


# ── Foundation + schema-phase checks ────────────────────────────────────────

def phase_schema() -> list:
    r = []
    # scaffold-package
    r.append(exists("scaffold-package.1", "project.json exists", f"{PKG}/project.json"))
    r.append(grep_present("scaffold-package.2", "tsconfig path registered", "@adhd/agent-provider", "tsconfig.base.json"))
    r.append(grep_present("scaffold-package.3", "tagged platform:node", "platform:node", f"{PKG}/project.json"))
    r.append(check("scaffold-package.4", "package builds clean", "npx --yes nx build agent-provider"))
    r.append(grep_absent("scaffold-package.5", "no browser globals", r'from "react"|document\.|window\.', f"{PKG}/src"))
    # provider-and-model-schema
    r.append(grep_present("provider-and-model-schema.1", "providers table", "providers|providersTable", SCHEMA))
    r.append(grep_present("provider-and-model-schema.2", "models table", "models|modelsTable", SCHEMA))
    r.append(check("provider-and-model-schema.3", "model-store round-trip+reopen test passes",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/model-store.test.ts"))
    # model-platform-bindings
    r.append(grep_present("model-platform-bindings.1", "model_platform_bindings table",
                          "model_platform_bindings|modelPlatformBindings", SCHEMA))
    r.append(grep_present("model-platform-bindings.2", "resolveModelId reads binding by platform",
                          "resolveModelId|platform_model_id|platformModelId", MODEL_STORE))
    r.append(check("model-platform-bindings.3", "binding resolution test passes (canonical->per-platform after reopen)",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/binding-store.test.ts"))
    r.append(check("model-platform-bindings.4", "negative-control: binding resolution has teeth (positive probe)",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/binding-store.test.ts"))
    # provider-tool-formats
    r.append(grep_present("provider-tool-formats.1", "provider_tool_formats table",
                          "provider_tool_formats|providerToolFormats", SCHEMA))
    r.append(check("provider-tool-formats.2", "tool-format store test passes",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/tool-format-store.test.ts"))
    # audit-schema
    r.append(check("audit-schema.1", "schema-phase audit self-consistent", "true"))
    return r


# ── Adapter / runtime / seed checks + behavioral DoD (final phase) ──────────
# Each behavioral DoD check drives the clause's declared entrypoint and asserts
# its observable. The command STRING names the entrypoint's distinctive token so
# gap-check Check-8 confirms the proving check drives the real door.

def phase_final() -> list:
    r = phase_schema()
    # provider-adapter-contract
    r.append(grep_present("provider-adapter-contract.1", "ProviderAdapter defined in agent-mcp-types",
                          "ProviderAdapter", TYPES_DOMAIN))
    r.append(grep_absent("provider-adapter-contract.2", "ProviderAdapter not re-declared in agent-provider",
                         "interface ProviderAdapter", f"{PKG}/src"))
    r.append(check("provider-adapter-contract.3", "adapter resolves a model id through the binding table",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/adapter-resolve.test.ts"))
    # runtime-tool-forwarding (FEAT-007)
    r.append(grep_present("runtime-tool-forwarding.1", "emitter branches on server-side type-tagged shape",
                          "web_search|type-tagged|serverSide|server_side", EMIT_TOOLS))
    r.append(grep_present("runtime-tool-forwarding.2", "emitter throws explicit error for unsupported native",
                          "throw|UnsupportedNativeToolError|UNSUPPORTED_NATIVE_TOOL", EMIT_TOOLS))
    r.append(check("runtime-tool-forwarding.3", "emit-tools test: server-side -> type-tagged; unsupported -> throw",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/emit-tools.test.ts"))
    r.append(check("runtime-tool-forwarding.4", "negative-control: FEAT-007 emitter has teeth (positive probe)",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/emit-tools.test.ts"))
    # seed-and-roundtrip
    r.append(check("seed-and-roundtrip.1", "seed/reopen/idempotency suite passes",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/roundtrip.test.ts"))
    r.append(grep_present("seed-and-roundtrip.2", "seed lists canonical models",
                          "claude_opus_4_8|claude_sonnet_4_6", f"{PKG}/src/seed/models.ts"))
    r.append(grep_present("seed-and-roundtrip.3", "seed lists providers",
                          "anthropic|bedrock|lmstudio", f"{PKG}/src/seed/providers.ts"))
    r.append(check("seed-and-roundtrip.4", "negative-control: seed idempotency has teeth (positive probe)",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/roundtrip.test.ts"))

    # ── Behavioral DoD checks ──
    # [dod.1] model binding resolves per platform after reopen
    r.append(check("dod.1", "canonical model id resolves per-platform via bindings after reopen",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/binding-store.test.ts"))
    # [dod.2] FEAT-007 emitter: type-tagged server-side + gated error
    r.append(check("dod.2", "emitter emits type-tagged server-side tool + throws on unsupported native",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/emit-tools.test.ts"))
    # [dod.3] seed idempotent + round-trips after reopen
    r.append(check("dod.3", "seed is idempotent and round-trips after reopen",
                   f"npx --yes nx test agent-provider --testFile={TESTS}/roundtrip.test.ts"))
    # [dod.4] structural — platform:node lib registered + builds
    r.append(grep_present("dod.4", "agent-provider registered platform:node + path",
                          "platform:node", f"{PKG}/project.json"))
    # [dod.5] structural — provider_* tables exist
    r.append(grep_present("dod.5", "provider_* domain tables exist",
                          "provider_tool_formats|providerToolFormats", SCHEMA))
    # [dod.6] structural — ProviderAdapter lives in agent-mcp-types, not here
    r.append(grep_present("dod.6", "ProviderAdapter interface lives in agent-mcp-types",
                          "ProviderAdapter", TYPES_DOMAIN))
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
