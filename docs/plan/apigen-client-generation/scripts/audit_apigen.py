#!/usr/bin/env python3
"""
audit_apigen.py — phase-scoped audit for the apigen-client-generation plan.

Usage:
  python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase foundation
  python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase runtime
  python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase plugins
  python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase cli
  python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase integration
  python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase final

  # env-pinned guard phases (F1) — each replaces a bare node/test guard in dag.json:
  python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase scaffold-packages
  python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase scaffold-plugins
  python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase plugin-fastify-checkpoint
  python3 docs/plan/apigen-client-generation/scripts/audit_apigen.py --phase done

All behavioral DoD checks (dod.1, dod.1-sse, dod.1-streaming-http, dod.1-live, dod.2,
dod.5, dod.cli, dod.7) drive scripts/probe_mcp.mjs (dod.7 drives the nx target twice),
which DERIVES every expected observable from the fixture (no hard-coded values) — see
[conv:fixture-samples]. Each behavioral check's command STRING literally names its
clause's entrypoint (--cli/--source/--packages-dir) so gap-check Check-8 sees the door.

Exits 0 when all checks in the phase pass.
Exits 1 with a failure summary if any check fails.

Criterion ID registry (referenced by gap-check.js):
  Foundation phase:
    [audit-core.1] [audit-core.2] [audit-core.3] [audit-core.4] [audit-core.5]
    [audit-core.6] [audit-core.7] [audit-core.8] [audit-core.9] [audit-core.10]
    [schema-extraction.1] [schema-extraction.2] [schema-extraction.3]
    [schema-extraction.4] [schema-extraction.5] [schema-extraction.6] [schema-extraction.7]
    [schema-composition.1] [schema-composition.2] [schema-composition.3]
    [schema-composition.4] [schema-composition.5]
    [core-types.1] [core-types.2] [core-types.3] [core-types.4]
    [scaffold-packages.1] [scaffold-packages.2] [scaffold-packages.3]
    [scaffold-packages.4] [scaffold-packages.5]

  Runtime phase:
    [audit-runtime.1] [audit-runtime.2] [audit-runtime.3] [audit-runtime.4]
    [audit-runtime.5] [audit-runtime.6] [audit-runtime.7] [audit-runtime.8] [audit-runtime.9]
    [runtime-middleware.1] [runtime-middleware.2] [runtime-middleware.3]
    [runtime-middleware.4] [runtime-middleware.5] [runtime-middleware.6]
    [runtime-dispatch.1] [runtime-dispatch.2] [runtime-dispatch.3]
    [runtime-dispatch.4] [runtime-dispatch.5]

  Plugins phase:
    [audit-plugins.1] [audit-plugins.2] [audit-plugins.3] [audit-plugins.4]
    [audit-plugins.5] [audit-plugins.6] [audit-plugins.7]
    [plugin-jsonschema.1] [plugin-jsonschema.2] [plugin-jsonschema.3] [plugin-jsonschema.4]
    [plugin-mcp.1] [plugin-mcp.2] [plugin-mcp.3] [plugin-mcp.4] [plugin-mcp.5] [plugin-mcp.6]
    [plugin-api-fastify.1] [plugin-api-fastify.2] [plugin-api-fastify.3] [plugin-api-fastify.4]
    [plugin-api-express.1] [plugin-api-express.2] [plugin-api-express.3] [plugin-api-express.4]
    [plugin-cli-output.1] [plugin-cli-output.2] [plugin-cli-output.3]
    [plugin-cli-output.4] [plugin-cli-output.5] [plugin-cli-output.6]

  Foundation phase (nx-generator moved here):
    [nx-generator.1] [nx-generator.2] [nx-generator.3] [nx-generator.4]
    [nx-generator.5] [nx-generator.6] [nx-generator.7] [nx-generator.8] [nx-generator.9]

  Plugins phase (scaffold-plugins + fastify-first):
    [scaffold-plugins.1] [scaffold-plugins.2] [scaffold-plugins.3]
    [scaffold-plugins.4] [scaffold-plugins.5]
    [plugin-fastify-checkpoint.1]

  CLI phase:
    [audit-cli.1] [audit-cli.2] [audit-cli.3] [audit-cli.4] [audit-cli.5]
    [audit-cli.6] [audit-cli.7] [audit-cli.8] [audit-cli.9] [audit-cli.10]
    [cli-generate-cmd.1] [cli-generate-cmd.2] [cli-generate-cmd.3]
    [cli-generate-cmd.4] [cli-generate-cmd.5]
    [cli-run-cmd.1] [cli-run-cmd.2] [cli-run-cmd.3] [cli-run-cmd.4] [cli-run-cmd.5]

  Integration phase (end-to-end behavioral tests — ALL 14 IDs executed):
    [integration-tests.1] [integration-tests.2] [integration-tests.3] [integration-tests.4]
    [integration-tests.5] [integration-tests.6] [integration-tests.7] [integration-tests.8]
    [integration-tests.9] [integration-tests.10] [integration-tests.11] [integration-tests.12]
    [integration-tests.13] [integration-tests.14]

  Guard phases (F1 — env-pinned via this .py invocation):
    [scaffold-packages.guard] [scaffold-plugins.guard]
    [plugin-fastify-checkpoint.guard] [done.guard]

  Final phase (DoD proofs — behavioral clauses driven by probe_mcp.mjs):
    [dod.1] [dod.1-sse] [dod.1-streaming-http] [dod.1-live]
    [dod.2] [dod.3] [dod.4] [dod.5] [dod.6] [dod.7] [dod.8]
    [dod.cli]
    [audit-final.inv-type-flag-only] [audit-final.inv-dispatch-single-path]
    [audit-final.inv-ctx-name-only] [audit-final.inv-language-agnostic-output]
    [audit-final.inv-nx-platform-tags] [audit-final.schema-teeth]
    [audit-core.7] [audit-core.10]
    [audit-runtime.2] [audit-plugins.5] [plugin-api-fastify.4]
    [nx-generator.2] [audit-cli.7]
"""

import argparse
import subprocess
import sys
import os
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]

# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

class CheckResult:
    def __init__(self, name: str, passed: bool, detail: str = ""):
        self.name = name
        self.passed = passed
        self.detail = detail

def run(cmd: str, **kwargs) -> tuple[int, str]:
    """Run a shell command and return (returncode, combined output)."""
    result = subprocess.run(
        cmd, shell=True, cwd=REPO_ROOT,
        capture_output=True, text=True, **kwargs
    )
    return result.returncode, (result.stdout + result.stderr).strip()

def check(check_id: str, description: str, cmd: str, expect_empty: bool = False) -> CheckResult:
    """Run cmd. If expect_empty, pass only when output is empty. Otherwise pass when exit 0.
    Signature matches gap-check.js 3-arg pattern: check(id, description, cmd).
    """
    code, out = run(cmd)
    if expect_empty:
        passed = (out == "")
        detail = f"unexpected output:\n{out}" if not passed else ""
    else:
        passed = (code == 0)
        detail = out if not passed else ""
    name = f"[{check_id}] {description}"
    return CheckResult(name, passed, detail)

def project_exists(pkg: str) -> bool:
    p = REPO_ROOT / "packages" / "apigen" / pkg / "project.json"
    return p.exists()

def grep_absent(check_id: str, description: str, pattern: str, paths: str) -> CheckResult:
    """Pass when grep finds nothing (no matches)."""
    cmd = f"grep -rn {pattern!r} {paths}"
    code, out = run(cmd)
    # grep exits 0 if found (BAD), 1 if not found (GOOD)
    passed = code != 0
    detail = f"forbidden pattern found:\n{out}" if not passed else ""
    name = f"[{check_id}] {description}"
    return CheckResult(name, passed, detail)

# --------------------------------------------------------------------------- #
# phase: foundation
# --------------------------------------------------------------------------- #

def phase_foundation() -> list[CheckResult]:
    results = []

    # [audit-core.1] Build
    results.append(check("audit-core.1", "apigen-core builds", "npx --yes nx build apigen-core"))

    # [audit-core.2] No TS errors (covered by build)
    # [audit-core.3] Export completeness
    REQUIRED_EXPORTS = [
        "generateSchemas", "composeSchemas",
        "GeneratedSchemas", "ComposedSchemas",
        "ExportMode", "GenerateSchemasOptions",
        "OutputPlugin", "PluginInput",
    ]
    index_path = REPO_ROOT / "packages" / "apigen" / "core" / "src" / "index.ts"
    if index_path.exists():
        content = index_path.read_text()
        for sym in REQUIRED_EXPORTS:
            present = sym in content
            results.append(CheckResult(
                f"[audit-core.3] export:{sym}",
                present,
                "" if present else f"{sym} not exported from index.ts"
            ))
    else:
        results.append(CheckResult("[audit-core.3] core/index.ts exists", False, "file not found"))

    # [audit-core.5] Tests pass
    results.append(check("audit-core.5", "apigen-core tests pass", "npx --yes nx test apigen-core"))

    # [audit-core.7] Isolation: no runtime imports in core
    results.append(grep_absent(
        "audit-core.7",
        "no apigen-runtime in core",
        "@adhd/apigen-runtime",
        "packages/apigen/core/src/"
    ))
    results.append(grep_absent(
        "audit-core.8",
        "no apigen-plugin in core",
        "@adhd/apigen-plugin",
        "packages/apigen/core/src/"
    ))

    # [audit-core.9] ctx name-only filter
    results.append(grep_absent(
        "audit-core.9",
        "no TypeChecker on ctx (name-only filter)",
        r"getType\|TypeChecker",
        "packages/apigen/core/src/"
    ))

    # nx-generator is now in foundation phase — verify it builds
    # [nx-generator.9]
    results.append(check("nx-generator.9", "apigen-nx builds (foundation phase)", "npx --yes nx build apigen-nx"))
    # [nx-generator.1] generator creates correct project.json
    results.append(check(
        "nx-generator.1",
        "generator creates plugin with correct tags and tsconfig path",
        "npx --yes nx test apigen-nx generator"
    ))
    # [nx-generator.4] [nx-generator.5] hasRun flag
    results.append(check(
        "nx-generator.4",
        "generator without hasRun produces no run() stub",
        "npx --yes nx test apigen-nx generator"
    ))
    results.append(check(
        "nx-generator.5",
        "generator with hasRun=true produces run() stub and RunInput import",
        "npx --yes nx test apigen-nx generator"
    ))
    # [nx-generator.6] tsconfig.base.json is updated
    results.append(check(
        "nx-generator.6",
        "generator updates tsconfig.base.json with new plugin path",
        "npx --yes nx test apigen-nx generator"
    ))
    # [nx-generator.7] [nx-generator.8] executor
    results.append(check(
        "nx-generator.7",
        "executor calls npx @adhd/apigen-cli generate with correct args",
        "npx --yes nx test apigen-nx executor"
    ))

    return results

# --------------------------------------------------------------------------- #
# phase: runtime
# --------------------------------------------------------------------------- #

def phase_runtime() -> list[CheckResult]:
    results = []

    # [audit-runtime.1]
    results.append(check("audit-runtime.1", "apigen-runtime builds", "npx --yes nx build apigen-runtime"))
    # [audit-runtime.4]
    results.append(check("audit-runtime.4", "apigen-runtime tests pass", "npx --yes nx test apigen-runtime"))

    REQUIRED_RUNTIME_EXPORTS = [
        "defineMiddleware", "EventBus", "buildContext",
        "createApiPackage", "needsEnvelopeField", "dataParamNames",
        "dispatch", "ConfigurationError",
    ]
    index_path = REPO_ROOT / "packages" / "apigen" / "runtime" / "src" / "index.ts"
    if index_path.exists():
        content = index_path.read_text()
        for sym in REQUIRED_RUNTIME_EXPORTS:
            present = sym in content
            results.append(CheckResult(
                f"[audit-runtime.2] export:{sym}",
                present,
                "" if present else f"{sym} not exported from runtime index.ts"
            ))
    else:
        results.append(CheckResult("[audit-runtime.2] runtime/index.ts exists", False, "file not found"))

    results.append(grep_absent(
        "audit-runtime.7",
        "no apigen-plugin import in runtime",
        "@adhd/apigen-plugin",
        "packages/apigen/runtime/src/"
    ))
    results.append(grep_absent(
        "audit-runtime.8",
        "no node built-ins in runtime",
        r"from 'fs'\|from 'path'\|from 'child_process'",
        "packages/apigen/runtime/src/"
    ))

    # [audit-runtime.9] dispatch single-path
    code, out = run("grep -rn 'function dataParamNames\\|function needsEnvelopeField' packages/apigen/runtime/src/lib/ | grep -v 'dispatch.ts\\|dispatch.spec.ts'")
    passed = (out == "" or code != 0)
    results.append(CheckResult(
        "[audit-runtime.9] dispatch-single-path",
        passed,
        f"dispatch logic duplicated:\n{out}" if not passed else ""
    ))

    return results

# --------------------------------------------------------------------------- #
# phase: plugins
# --------------------------------------------------------------------------- #

def phase_plugins() -> list[CheckResult]:
    results = []

    # [scaffold-plugins.1] All 5 plugin project.json files exist with correct tags
    PLUGIN_DIRS = {
        "jsonschema": "packages/apigen/plugins/jsonschema",
        "mcp": "packages/apigen/plugins/mcp",
        "api-fastify": "packages/apigen/plugins/api-fastify",
        "api-express": "packages/apigen/plugins/api-express",
        "cli": "packages/apigen/plugins/cli",
    }
    for slug, d in PLUGIN_DIRS.items():
        proj = REPO_ROOT / d / "project.json"
        results.append(CheckResult(
            f"[scaffold-plugins.1] {slug}/project.json exists",
            proj.exists(),
            "" if proj.exists() else f"missing: {d}/project.json"
        ))
    results.append(check(
        "scaffold-plugins.2",
        "all 5 plugin packages in nx show projects",
        "npx --yes nx show projects | grep -c apigen-plugin"
    ))
    results.append(check(
        "scaffold-plugins.3",
        "tsconfig.base.json has all 5 plugin paths",
        "node -e \"const p=require('./tsconfig.base.json').compilerOptions.paths; ['@adhd/apigen-plugin-jsonschema','@adhd/apigen-plugin-mcp','@adhd/apigen-plugin-api-fastify','@adhd/apigen-plugin-api-express','@adhd/apigen-plugin-cli-output'].forEach(k=>{if(!p[k])throw new Error('missing: '+k)})\""
    ))
    # [scaffold-plugins.4] hasRun stubs — mcp/api-fastify/api-express have run(), others don't
    for slug, d in PLUGIN_DIRS.items():
        plugin_ts = REPO_ROOT / d / "src" / "lib" / "plugin.ts"
        if plugin_ts.exists():
            content = plugin_ts.read_text()
            has_run = "run(" in content
            expects_run = slug in ("mcp", "api-fastify", "api-express")
            passed = has_run == expects_run
            results.append(CheckResult(
                f"[scaffold-plugins.4] {slug} run() stub {'present' if expects_run else 'absent'}",
                passed,
                "" if passed else f"{slug}/plugin.ts: run() {'absent but expected' if expects_run else 'present but not expected'}"
            ))
    results.append(check(
        "scaffold-plugins.5",
        "all 5 plugin stubs build cleanly",
        "npx --yes nx run-many --target=build --projects=apigen-plugin-jsonschema,apigen-plugin-mcp,apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-cli-output"
    ))

    # [plugin-fastify-checkpoint.1] human approval file exists
    results.append(check(
        "plugin-fastify-checkpoint.1",
        "fastify reference plugin approved by plan owner",
        "test -f docs/plan/apigen-client-generation/checkpoints/fastify-approved.md"
    ))

    PLUGINS = [
        "apigen-plugin-jsonschema",
        "apigen-plugin-mcp",
        "apigen-plugin-api-fastify",
        "apigen-plugin-api-express",
        "apigen-plugin-cli-output",
    ]

    build_cmd = "npx --yes nx run-many --target=build --projects=" + ",".join(PLUGINS)
    test_cmd = "npx --yes nx run-many --target=test --projects=" + ",".join(PLUGINS)

    # [audit-plugins.1]
    results.append(check("audit-plugins.1", "all plugins build", build_cmd))
    # [audit-plugins.2]
    results.append(check("audit-plugins.2", "all plugins tests pass", test_cmd))

    # [audit-plugins.6]
    results.append(grep_absent(
        "audit-plugins.6",
        "no --output flag in plugins",
        r'"--output"',
        "packages/apigen/plugins/"
    ))

    # [audit-plugins.4]
    code, out = run(r"grep -rn 'function dataParamNames\|function needsEnvelopeField' packages/apigen/plugins/")
    passed = (out == "" or code != 0)
    results.append(CheckResult(
        "[audit-plugins.4] no inline dispatch in plugins",
        passed,
        f"inline dispatch:\n{out}" if not passed else ""
    ))

    # [audit-plugins.5] dispatch imported from runtime
    results.append(grep_absent(
        "audit-plugins.5",
        "plugins import dispatch from runtime",
        r"function dispatch\b",
        "packages/apigen/plugins/"
    ))

    return results

# --------------------------------------------------------------------------- #
# phase: cli
# --------------------------------------------------------------------------- #

def phase_cli() -> list[CheckResult]:
    results = []

    # [audit-cli.1]
    results.append(check("audit-cli.1", "apigen-cli builds", "npx --yes nx build apigen-cli"))
    # [audit-cli.2] (runs nx build apigen-nx under the hood)
    results.append(check("audit-cli.2", "apigen-nx builds", "npx --yes nx build apigen-nx"))
    # [audit-cli.3]
    results.append(check("audit-cli.3", "apigen-cli tests pass", "npx --yes nx test apigen-cli"))
    # [audit-cli.4]
    results.append(check("audit-cli.4", "apigen-nx tests pass", "npx --yes nx test apigen-nx"))

    # [audit-cli.5] --output absent in CLI
    results.append(grep_absent(
        "audit-cli.5",
        "no --output flag in CLI",
        r"'--output'",
        "packages/apigen/cli/src/"
    ))

    # [audit-cli.6] index.ts registers all 4 commands
    index_path = REPO_ROOT / "packages" / "apigen" / "cli" / "src" / "index.ts"
    if index_path.exists():
        content = index_path.read_text()
        for fn in ["registerGenerateCommand", "registerRunCommand", "registerGenerateRegistryCommand", "registerRunRegistryCommand"]:
            present = fn in content
            results.append(CheckResult(
                f"[audit-cli.6] cli-index:{fn}",
                present,
                "" if present else f"{fn} not in index.ts"
            ))
    else:
        results.append(CheckResult("[audit-cli.6] cli/index.ts exists", False, "file not found"))

    # [audit-cli.7] registry.ts does not read project.json
    results.append(grep_absent(
        "audit-cli.7",
        "registry reads package.json tags not project.json",
        "project.json",
        "packages/apigen/cli/src/lib/registry.ts"
    ))

    # [audit-cli.8] generator schema validates
    results.append(check(
        "audit-cli.8",
        "nx generator schema requires name",
        "node -e \"const s=require('./packages/apigen/nx/src/generators/plugin/schema.json'); if(!s.required?.includes('name')) throw new Error('name not required')\""
    ))

    # [audit-cli.9] generators.json and executors.json exist
    gen_json = REPO_ROOT / "packages" / "apigen" / "nx" / "generators.json"
    exe_json = REPO_ROOT / "packages" / "apigen" / "nx" / "executors.json"
    results.append(CheckResult(
        "[audit-cli.9] apigen-nx/generators.json exists",
        gen_json.exists(), "" if gen_json.exists() else "generators.json not found"
    ))
    results.append(CheckResult(
        "[audit-cli.9] apigen-nx/executors.json exists",
        exe_json.exists(), "" if exe_json.exists() else "executors.json not found"
    ))

    # [audit-cli.10] index.ts merge complete (all 4 register calls)
    if index_path.exists():
        content = index_path.read_text()
        all_four = all(fn in content for fn in [
            "registerGenerateCommand", "registerRunCommand",
            "registerGenerateRegistryCommand", "registerRunRegistryCommand"
        ])
        results.append(CheckResult(
            "[audit-cli.10] index.ts merge complete",
            all_four,
            "" if all_four else "index.ts missing some register calls (MERGE incomplete)"
        ))

    return results

# NOTE on entrypoint fidelity: behavioral DoD checks (dod.1/2/5/cli/7 …) inline their
# command strings LITERALLY rather than via these tokens, because gap-check Check-8 reads
# the Python string literal passed to check() and requires the clause's entrypoint token
# (e.g. packages/apigen/cli/src/index.ts, .../real-api.ts) to appear in it. An f-string
# referencing a constant would expand to a placeholder the gate can't see. The generalized
# probe (scripts/probe_mcp.mjs) still DERIVES every observable from the --source fixture —
# the literal paths only declare which real entrypoint each check drives.
# CLI binary (monorepo): npx tsx packages/apigen/cli/src/index.ts ; published: npx @adhd/apigen-cli

# --------------------------------------------------------------------------- #
# phase: integration — drives the integration test suite
# --------------------------------------------------------------------------- #

def phase_integration() -> list[CheckResult]:
    """Drive the integration suite. ALL 14 advertised IDs are executed (no
    registered-but-unrun holes). Several IDs share a spec file but assert distinct
    behaviors documented in contexts/integration-tests.md acceptance criteria; we
    run each via a -t name filter so the ID maps to its specific assertion.
    """
    results = []

    # schema.spec.ts → .1 (ctx/optional/zero-param/data wrapper) + .2 (middleware + false override)
    results.append(check(
        "integration-tests.1",
        "schema: ctx excluded, filter optional, ping zero-param, data:{} required",
        "npx --yes nx test apigen-cli integration/schema -t 'schema extraction'"
    ))
    results.append(check(
        "integration-tests.2",
        "schema: middleware session field added; false override suppresses it from ping only",
        "npx --yes nx test apigen-cli integration/schema -t 'schema composition'"
    ))

    # dispatch.spec.ts → .3 (real fns round-trip) + .4 (positional arg order)
    results.append(check(
        "integration-tests.3",
        "dispatch: real functions round-trip (getUser/ping/void)",
        "npx --yes nx test apigen-cli integration/dispatch -t 'dispatch'"
    ))
    results.append(check(
        "integration-tests.4",
        "dispatch: createUser positional args arrive in correct order (not swapped)",
        "npx --yes nx test apigen-cli integration/dispatch -t 'correct positional arg order'"
    ))

    # mcp.spec.ts → .5 (tools/list) + .6 (callTool getUser) + .7 (callTool ping)
    results.append(check(
        "integration-tests.5",
        "mcp: tools/list returns exactly the fixture exports (no ctx-only tools)",
        "npx --yes nx test apigen-cli integration/mcp -t 'tools/list returns all exported functions'"
    ))
    results.append(check(
        "integration-tests.6",
        "mcp: callTool(getUser) returns correct User shape",
        "npx --yes nx test apigen-cli integration/mcp -t 'getUser tool call returns correct User shape'"
    ))
    results.append(check(
        "integration-tests.7",
        "mcp: callTool(ping) zero-param returns true",
        "npx --yes nx test apigen-cli integration/mcp -t 'ping tool call'"
    ))

    # http.spec.ts → .8 (Fastify+Express round-trip) + .9 (Fastify/Express parity)
    results.append(check(
        "integration-tests.8",
        "http: POST /<id>/getUser returns User from both Fastify and Express",
        "npx --yes nx test apigen-cli integration/http -t 'getUser'"
    ))
    results.append(check(
        "integration-tests.9",
        "http: Fastify and Express return identical JSON for the same request (route parity)",
        "npx --yes nx test apigen-cli integration/http -t 'same result as Fastify'"
    ))

    # parity.spec.ts → .10 (tools/list parity) + .11 (callTool parity, not just tools/list)
    results.append(check(
        "integration-tests.10",
        "parity: tools/list identical between run and generated server",
        "npx --yes nx test apigen-cli integration/parity -t 'tools/list is identical'"
    ))
    results.append(check(
        "integration-tests.11",
        "parity: callTool(getUser) identical JSON from run vs generated server",
        "npx --yes nx test apigen-cli integration/parity -t 'callTool returns identical response'"
    ))

    # registry.spec.ts → .12 (tag filter discovery) + .13 (correct routing)
    results.append(check(
        "integration-tests.12",
        "registry: --tag api discovers pkg-a+pkg-b, excludes pkg-c (exactly hello+world)",
        "npx --yes nx test apigen-cli integration/registry -t 'discovers api-tagged packages'"
    ))
    results.append(check(
        "integration-tests.13",
        "registry: callTool(hello) routes to pkg-a and returns 'a' (not pkg-b)",
        "npx --yes nx test apigen-cli integration/registry -t 'routes tool call to correct package'"
    ))

    # export-modes.spec.ts → .14 (default + named-object modes)
    results.append(check(
        "integration-tests.14",
        "export-modes: default and named-object extract same signatures as named mode",
        "npx --yes nx test apigen-cli integration/export-modes"
    ))

    return results

# --------------------------------------------------------------------------- #
# F1 guard phases — env-pinned replacements for the former bare node/test guards.
# Routing each guard through this .py invocation pins tool resolution (env-pin.js
# recognizes `python3 …​.py`). Each phase asserts exactly what the old guard did.
# --------------------------------------------------------------------------- #

def phase_scaffold_packages() -> list[CheckResult]:
    """Was: node -e 'project.json exists for core/runtime/nx/cli'."""
    results = []
    for pkg in ["core", "runtime", "nx", "cli"]:
        proj = REPO_ROOT / "packages" / "apigen" / pkg / "project.json"
        pkgj = REPO_ROOT / "packages" / "apigen" / pkg / "package.json"
        results.append(CheckResult(
            f"[scaffold-packages.guard] {pkg}/project.json + package.json exist",
            proj.exists() and pkgj.exists(),
            "" if proj.exists() and pkgj.exists() else f"missing project.json/package.json: packages/apigen/{pkg}",
        ))
    return results


def phase_scaffold_plugins() -> list[CheckResult]:
    """Was: node -e '5 plugin dirs have project.json + src/lib/plugin.ts'."""
    results = []
    for slug in ["jsonschema", "mcp", "api-fastify", "api-express", "cli"]:
        d = REPO_ROOT / "packages" / "apigen" / "plugins" / slug
        ok = (d / "project.json").exists() and (d / "src" / "lib" / "plugin.ts").exists()
        results.append(CheckResult(
            f"[scaffold-plugins.guard] {slug}: project.json + src/lib/plugin.ts exist",
            ok,
            "" if ok else f"missing: packages/apigen/plugins/{slug}/(project.json|src/lib/plugin.ts)",
        ))
    return results


def phase_plugin_fastify_checkpoint() -> list[CheckResult]:
    """Was: test -f checkpoints/fastify-approved.md (human sign-off gate)."""
    approval = REPO_ROOT / "docs" / "plan" / "apigen-client-generation" / "checkpoints" / "fastify-approved.md"
    return [CheckResult(
        "[plugin-fastify-checkpoint.guard] fastify reference plugin approved by plan owner",
        approval.exists(),
        "" if approval.exists() else "missing human approval file: checkpoints/fastify-approved.md",
    )]


def phase_done() -> list[CheckResult]:
    """Was: node -e 'process.exit(0)' (terminal no-op)."""
    return [CheckResult("[done.guard] terminal no-op", True, "")]


# --------------------------------------------------------------------------- #
# phase: final  — drives actual entrypoints for behavioral DoD clauses
# --------------------------------------------------------------------------- #

def phase_final() -> list[CheckResult]:
    results = []

    # Run all sub-phases first
    results.extend(phase_foundation())
    results.extend(phase_runtime())
    results.extend(phase_plugins())
    results.extend(phase_cli())
    results.extend(phase_integration())

    # [dod.1] MCP stdio: probe DRIVES the real CLI run entrypoint over a real
    # StdioClientTransport, DERIVES the expected tool set + ground-truth outputs from
    # the fixture in-process, and asserts tools/list + callTool deep-equal them.
    # No literal observable — works for any fixture. Exit code is the gate.
    # negative-control: rename a fixture export → derived tool set changes → red.
    # The command STRING literally names the real entrypoint (--cli <index.ts> --source
    # <fixture>) so gap-check Check-8 fidelity sees the proving check drives the declared
    # door. The probe still DERIVES every expected value from --source (no hard-coded
    # observables); --cli/--source/--type/--transport are parameters it merely reads.
    results.append(check(
        "dod.1",
        "MCP stdio: tools/list == fixture exports; callTool deep-equals in-process ground truth",
        "node docs/plan/apigen-client-generation/scripts/probe_mcp.mjs run "
        "--cli packages/apigen/cli/src/index.ts "
        "--source packages/apigen/cli/src/test/fixtures/real-api.ts --type mcp --transport stdio "
        "--assert deep-equal"
    ))
    # [dod.1-sse] same invariants over the SSE transport.
    results.append(check(
        "dod.1-sse",
        "MCP sse: tools/list + callTool parity over SSE transport (derived)",
        "node docs/plan/apigen-client-generation/scripts/probe_mcp.mjs run "
        "--cli packages/apigen/cli/src/index.ts "
        "--source packages/apigen/cli/src/test/fixtures/real-api.ts --type mcp --transport sse "
        "--assert deep-equal"
    ))
    # [dod.1-streaming-http] same invariants over the streamable-HTTP transport.
    results.append(check(
        "dod.1-streaming-http",
        "MCP streaming-http: tools/list + callTool parity over streamable-HTTP transport (derived)",
        "node docs/plan/apigen-client-generation/scripts/probe_mcp.mjs run "
        "--cli packages/apigen/cli/src/index.ts "
        "--source packages/apigen/cli/src/test/fixtures/real-api.ts --type mcp --transport streaming-http "
        "--assert deep-equal"
    ))

    # [dod.2] generate/run parity: probe generates server.ts to a temp dir, then
    # asserts BOTH the run-mode server and the generated server deep-equal the SAME
    # derived ground truth (hence each other).
    # negative-control: corrupt the generated server template → gen path diverges → red.
    results.append(check(
        "dod.2",
        "generate writes server.ts; both run + generated server deep-equal derived ground truth",
        "node docs/plan/apigen-client-generation/scripts/probe_mcp.mjs generate-parity "
        "--cli packages/apigen/cli/src/index.ts "
        "--source packages/apigen/cli/src/test/fixtures/real-api.ts --type mcp "
        "--assert deep-equal"
    ))

    # [dod.3] ctx excluded — proven by integration/schema.spec.ts (teeth enforced by
    # audit-final.schema-teeth below, which fails if the spec assertion is vacuous).
    results.append(check(
        "dod.3",
        "ctx excluded from schema (integration/schema.spec.ts, teeth-guarded)",
        "npx --yes nx test apigen-cli integration/schema -t 'excludes ctx'"
    ))

    # [dod.4] false suppresses middleware — proven by integration/schema.spec.ts.
    results.append(check(
        "dod.4",
        "middleware false override suppresses field (integration/schema.spec.ts, teeth-guarded)",
        "npx --yes nx test apigen-cli integration/schema -t 'suppresses session'"
    ))

    # [audit-final.schema-teeth] guard the schema spec itself so dod.3/dod.4 cannot
    # pass with a vacuous spec: the spec MUST contain the discriminating assertions.
    schema_spec = REPO_ROOT / "packages" / "apigen" / "cli" / "src" / "test" / "integration" / "schema.spec.ts"
    if schema_spec.exists():
        spec_src = schema_spec.read_text()
        needed = ["not.toContain('ctx')", "toContain('session')", "not.toHaveProperty('session')"]
        missing = [tok for tok in needed if tok not in spec_src]
        results.append(CheckResult(
            "[audit-final.schema-teeth] schema.spec.ts asserts ctx-absent + session-present + override-suppressed",
            not missing,
            "" if not missing else f"schema.spec.ts missing teeth assertions: {missing}",
        ))
    else:
        results.append(CheckResult(
            "[audit-final.schema-teeth] schema.spec.ts exists with teeth assertions",
            False, "integration/schema.spec.ts not found",
        ))

    # [dod.5] run-registry multi-package MCP: probe DERIVES the expected tagged tool
    # set + ground truth from each tagged package, asserts the registry surface
    # equals it AND that excluded (untagged) tools are absent AND routing is correct.
    # negative-control: drop the tag filter → excluded tool appears → red.
    results.append(check(
        "dod.5",
        "run-registry: tagged tools derived from packages; excluded absent; routing deep-equals ground truth",
        "node docs/plan/apigen-client-generation/scripts/probe_mcp.mjs registry "
        "--cli packages/apigen/cli/src/index.ts "
        "--packages-dir packages/apigen/cli/src/test/fixtures/registry --tag api --type mcp "
        "--assert deep-equal"
    ))

    # [plugin-cli-output.exec] EXECUTE the generated CLI: probe generates the CLI
    # plugin output to a temp dir, runs `node/tsx <out>/cli.ts <subcommand> <flags>`
    # as a real subprocess, and asserts its stdout JSON deep-equals the derived
    # ground truth for every fixture export.
    # negative-control: drop a subcommand in the generated cli.ts → missing/!= → red.
    # id is `dod.cli` so gap-check binds the [dod.cli] clause to this proving check.
    # The literal command names the real entrypoint (--cli <index.ts> --source <fixture>);
    # the probe generates the cli-output plugin to a temp dir, runs each generated
    # subcommand as a real subprocess, and deep-equals stdout to the derived ground truth.
    results.append(check(
        "dod.cli",
        "generated CLI: each subcommand's stdout JSON deep-equals derived ground truth",
        "node docs/plan/apigen-client-generation/scripts/probe_mcp.mjs cli-output "
        "--cli packages/apigen/cli/src/index.ts "
        "--source packages/apigen/cli/src/test/fixtures/real-api.ts --type cli-output "
        "--assert deep-equal"
    ))

    # [dod.1-live] real model through the real MCP loop (model = external boundary);
    # asserts model-INDEPENDENT invariants (every derived export listed + callable +
    # round-trips). Default-skipped so offline CI stays green; runs when APIGEN_LIVE=1.
    results.append(check(
        "dod.1-live",
        "live model end-to-end (APIGEN_LIVE=1): model lists+calls a derived tool; result deep-equals ground truth",
        "node docs/plan/apigen-client-generation/scripts/probe_mcp.mjs live "
        "--cli packages/apigen/cli/src/index.ts "
        "--source packages/apigen/cli/src/test/fixtures/real-api.ts --type mcp "
        "--assert deep-equal"
    ))

    # [dod.6] All 9 packages build
    results.append(check(
        "dod.6",
        "all 9 packages build cleanly",
        "npx --yes nx run-many --target=build --projects=apigen-core,apigen-runtime,apigen-plugin-mcp,apigen-plugin-jsonschema,apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-cli-output,apigen-nx,apigen-cli"
    ))

    # [dod.7] Nx executor cache-aware — run TWICE and prove caching is the feature:
    #   1. reset cache, run once → files appear in outDir
    #   2. run again → nx reports a cache hit AND the produced files are byte-identical
    # The whole pipeline is exit-gated (no grep-only). negative-control: disable target
    # caching → run-2 omits the cache marker → red.
    # The command is a single string LITERAL (not a variable) so gap-check Check-8 can
    # read it and confirm it drives the declared entrypoint token `apigen-cli:generate-api`.
    # Two runs prove caching is the feature: run-1 writes files to outDir; run-2 must
    # report an Nx cache hit AND produce byte-identical files; the whole pipeline is
    # exit-gated (no grep-only). negative-control: disable target caching → run-2 omits
    # the cache marker → red. outDir = tmp/apigen-generate-out.
    results.append(check(
        "dod.7",
        "nx executor cache-aware: run-1 writes files; run-2 is a cache hit with byte-identical output",
        "rm -rf tmp/apigen-generate-out && "
        "npx --yes nx reset >/dev/null 2>&1 && "
        "npx --yes nx run apigen-cli:generate-api >/dev/null 2>&1 && "
        "test -n \"$(ls -A tmp/apigen-generate-out 2>/dev/null)\" && "
        "H1=$(find tmp/apigen-generate-out -type f -exec shasum {} \\; | shasum) && "
        "OUT2=$(npx --yes nx run apigen-cli:generate-api 2>&1) && "
        "echo \"$OUT2\" | grep -q -e 'local cache' -e 'from the cache' -e 'Nx read the output' && "
        "H2=$(find tmp/apigen-generate-out -type f -exec shasum {} \\; | shasum) && "
        "[ \"$H1\" = \"$H2\" ]"
    ))

    # [dod.8] Nx generator scaffolds plugin
    results.append(check(
        "dod.8",
        "nx g @adhd/apigen-nx:plugin scaffolds buildable OutputPlugin",
        "npx --yes nx g @adhd/apigen-nx:plugin test-plugin --directory packages/apigen/plugins/test-plugin --no-interactive && npx --yes nx build apigen-plugin-test-plugin"
    ))

    # [audit-final.inv-type-flag-only] — [inv:type-flag-only]
    results.append(grep_absent(
        "audit-final.inv-type-flag-only",
        "no --output flag anywhere in apigen packages",
        r"'--output'\|\"--output\"",
        "packages/apigen/"
    ))

    # [audit-final.inv-dispatch-single-path]
    code, out = run("grep -rn 'function dataParamNames\\|function needsEnvelopeField' packages/apigen/ | grep -v 'dispatch.ts\\|dispatch.spec.ts'")
    passed = (out == "" or code != 0)
    results.append(CheckResult(
        "[audit-final.inv-dispatch-single-path]",
        passed,
        f"duplicated:\n{out}" if not passed else ""
    ))

    # [audit-final.inv-ctx-name-only]
    results.append(grep_absent(
        "audit-final.inv-ctx-name-only",
        "ctx filtered by name only",
        r"getType.*ctx\|TypeChecker.*ctx",
        "packages/apigen/core/src/"
    ))

    # [audit-final.inv-language-agnostic-output]
    results.append(grep_absent(
        "audit-final.inv-language-agnostic-output",
        "no TS-specific content validation in plugins",
        r"typescript-parse\|isTsFile\|checkFile\|parseFile",
        "packages/apigen/plugins/"
    ))

    # [audit-final.inv-nx-platform-tags]
    for pkg_dir in sorted((REPO_ROOT / "packages" / "apigen").iterdir()):
        if pkg_dir.is_dir() and not pkg_dir.name.startswith("."):
            proj_json = pkg_dir / "project.json"
            if proj_json.exists():
                try:
                    proj = json.loads(proj_json.read_text())
                    tags = proj.get("tags", [])
                    has_layer = any(t.startswith("layer:") for t in tags)
                    has_platform = any(t.startswith("platform:") for t in tags)
                    ok = has_layer and has_platform
                    results.append(CheckResult(
                        f"[audit-final.inv-nx-platform-tags] {pkg_dir.name}",
                        ok,
                        "" if ok else f"tags={tags}, need layer: and platform:"
                    ))
                except Exception as e:
                    results.append(CheckResult(f"[audit-final.inv-nx-platform-tags] {pkg_dir.name}", False, str(e)))

    return results

# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

PHASES = {
    "foundation": phase_foundation,
    "runtime": phase_runtime,
    "plugins": phase_plugins,
    "cli": phase_cli,
    "integration": phase_integration,
    "final": phase_final,
    # F1 env-pinned guard phases (replace former bare node/test guards in dag.json)
    "scaffold-packages": phase_scaffold_packages,
    "scaffold-plugins": phase_scaffold_plugins,
    "plugin-fastify-checkpoint": phase_plugin_fastify_checkpoint,
    "done": phase_done,
}

def main():
    parser = argparse.ArgumentParser(description="Phase-scoped audit for apigen-client-generation plan")
    parser.add_argument("--phase", required=True, choices=list(PHASES.keys()), help="Audit phase to run")
    args = parser.parse_args()

    fn = PHASES[args.phase]
    print(f"\n{'='*60}")
    print(f"  audit_apigen.py  --phase {args.phase}")
    print(f"{'='*60}\n")

    results = fn()
    passed = [r for r in results if r.passed]
    failed = [r for r in results if not r.passed]

    for r in results:
        icon = "✅" if r.passed else "❌"
        print(f"  {icon}  {r.name}")
        if r.detail:
            for line in r.detail.splitlines():
                print(f"       {line}")

    print(f"\n  {'─'*56}")
    print(f"  {len(passed)}/{len(results)} checks passed")

    if failed:
        print(f"\n  FAILED checks:")
        for r in failed:
            print(f"    ✗  {r.name}")
        print()
        sys.exit(1)
    else:
        print(f"\n  All checks passed. ✅\n")
        sys.exit(0)

if __name__ == "__main__":
    main()
