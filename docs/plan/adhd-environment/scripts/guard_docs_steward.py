#!/usr/bin/env python3
"""guard_docs_steward.py — behavioral, environment-pinned guard for `docs-steward`.

Replaces the PROVEN NO-OP guard
    test -f packages/environment/environment-core-node/README.md
That README is declared as an artifact by NO state, already exists on disk, and
exits 0 while docs-steward is still pending — so it can never go red→green and
docs-steward could complete having produced nothing (BACKLOG ENV-PLAN-001). A
mere `test -f` on docs-steward's real artifacts (demo/DEMO.md, USE_CASES.md) is
the SAME bug in a new coat: both files already exist on disk.

This guard instead asserts CONTENT + BEHAVIOUR that is NOT yet true:

  (A) DEMO.md must contain runnable commands for the SHIPPED packages — the
      cold-start `nx build environment-*` sequence, at least one `adhd-env`
      CLI command, and the `require('@adhd/environment')` runtime command.
  (B) USE_CASES.md sections must resolve to the real entrypoints
      (`@adhd/environment` import + `adhd-env` CLI).
  (C) BEHAVIOUR: the demo's headline runtime command must actually execute —
      the shipped `@adhd/environment` node package, freshly built, must export a
      constructable `Environment` class exposing `.get()` (DEMO §2.1 / dod.5).
      Today the runtime is a scaffold stub (`environmentEnvironmentCoreNode`),
      so `Environment` is undefined → this guard is RED. It only goes GREEN once
      the runtime states ship the real typed client, which is exactly the state
      of the world docs-steward documents.

Toolchain is resolved EXPLICITLY (node + npx via shutil.which) and the guard
FAILS LOUDLY (non-zero + stderr) on any missing prerequisite — never a silent
skip. As a `python3 …​.py` invocation the guard STRING is env-pinned.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve()
PLAN_DIR = SCRIPT.parents[1]          # docs/plan/adhd-environment
REPO_ROOT = SCRIPT.parents[4]         # repo root
DEMO = PLAN_DIR / "demo" / "DEMO.md"
USE_CASES = PLAN_DIR / "USE_CASES.md"
DIST_DIR = REPO_ROOT / "dist" / "packages" / "environment" / "environment-core-node"


def fail(msg: str) -> int:
    sys.stderr.write(f"guard_docs_steward: RED — {msg}\n")
    return 1


def check_demo_content() -> str | None:
    if not DEMO.is_file():
        return f"DEMO.md missing at {DEMO}"
    text = DEMO.read_text(encoding="utf-8")
    needles = {
        "cold-start build of the shipped packages": "nx build environment-",
        "adhd-env CLI command": "adhd-env ",
        "runtime require of @adhd/environment": "require('@adhd/environment')",
    }
    for label, needle in needles.items():
        if needle not in text:
            return f"DEMO.md does not contain a runnable {label} ({needle!r})"
    return None


def check_use_cases_content() -> str | None:
    if not USE_CASES.is_file():
        return f"USE_CASES.md missing at {USE_CASES}"
    text = USE_CASES.read_text(encoding="utf-8")
    for needle in ('@adhd/environment', "adhd-env "):
        if needle not in text:
            return f"USE_CASES.md does not resolve to real entrypoint ({needle!r})"
    return None


def resolve_tool(name: str) -> str:
    tool = shutil.which(name)
    if not tool:
        sys.stderr.write(
            f"guard_docs_steward: FATAL — `{name}` not found on PATH. Cannot build "
            "or probe the shipped @adhd/environment package. Provision node/npm.\n"
        )
        sys.exit(2)
    return tool


def check_runtime_behaviour() -> str | None:
    npx = resolve_tool("npx")
    node = resolve_tool("node")
    # Build the shipped node package (pinned npx) so the probe runs against a
    # fresh dist — the demo's cold-start step, executed for real.
    build = subprocess.run(
        [npx, "--yes", "nx", "build", "environment-core-node"],
        cwd=str(REPO_ROOT),
    )
    if build.returncode != 0:
        return f"`npx --yes nx build environment-core-node` exited {build.returncode}"

    pkg_json = DIST_DIR / "package.json"
    if not pkg_json.is_file():
        return f"built package manifest missing at {pkg_json}"
    main_rel = json.loads(pkg_json.read_text(encoding="utf-8")).get("main", "./index.js")
    entry = (DIST_DIR / main_rel).resolve()
    if not entry.is_file():
        return f"built entrypoint missing at {entry}"

    # Execute the demo's headline command: require the shipped package and assert
    # the typed Environment client (with .get()) actually exists.
    probe = (
        "const m = require(process.argv[1]);"
        "if (typeof m.Environment !== 'function') { console.error('no Environment export'); process.exit(3); }"
        "if (typeof m.Environment.prototype.get !== 'function') { console.error('Environment#get missing'); process.exit(4); }"
    )
    run = subprocess.run([node, "-e", probe, str(entry)], cwd=str(REPO_ROOT))
    if run.returncode != 0:
        return (
            "shipped @adhd/environment does not expose a constructable Environment "
            f"with .get() (node probe exit {run.returncode}) — runtime client not implemented"
        )
    return None


def main() -> int:
    for checker in (check_demo_content, check_use_cases_content, check_runtime_behaviour):
        problem = checker()
        if problem:
            return fail(problem)
    return 0


if __name__ == "__main__":
    sys.exit(main())
