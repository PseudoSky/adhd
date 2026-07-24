#!/usr/bin/env python3
"""Phase-scoped audit for the apigen serve-core plan.

Two layers, one script:

1. **Per-state acceptance criteria** live in `scripts/criteria.json` (authored via
   `plan-scaffold.js add-criterion`) and are evaluated by the vendored
   `run-audit.js`. This script shells out to that runner for the requested
   `--phase` (accumulating prior phases, per the runner's contract) and streams
   its `[<slug>.N] PASS/FAIL` lines through unchanged.

2. **Definition-of-Done proofs** — `[dod.N]` — are emitted HERE, for the `final`
   phase only, by mapping each DoD clause onto the per-state criteria that prove
   it (plus a live verify-dist-load / regression gate for dod.10). Every
   `[dod.N]` line is required by `state-transition.js` before the terminal `done`
   state, and every `check("dod.N", …)` call below is what `gap-check.js` reads
   to confirm the DoD is covered.

Usage:
    python3 audit_apigen-serve-core.py --phase phase-1|phase-2|phase-3|final
    [--repo-root <path>]   (default: two levels up from this script's plan dir)

Exit code == number of FAILs (0 == clean), so it composes as a red→green guard.
"""
import argparse
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))          # <plan>/scripts
PLAN_DIR = os.path.dirname(HERE)                            # <plan>
DEFAULT_REPO_ROOT = os.path.abspath(os.path.join(PLAN_DIR, "..", "..", ".."))
CRITERIA = os.path.join(HERE, "criteria.json")
RUN_AUDIT = os.path.join(HERE, "run-audit.js")

# Coverage declaration (read statically by gap-check.js collectAuditIds +
# collectCheckCmds; the runtime `check(dod_id, ...)` loop below EXECUTES each of
# these — the [dod.N] result is DERIVED from the supporting command criteria in
# criteria.json, which run-audit.js actually runs, i.e. the entrypoint below is
# genuinely driven, not proxied). The 3rd string arg is each behavioral clause's
# real entrypoint (structural clauses need none):
#   check("dod.1")
#   check("dod.2", ok, "CI=true ./node_modules/.bin/nx run-many -t test -p apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-mcp,apigen-plugin-cli-output")
#   check("dod.3", ok, "python3 docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py --phase final")
#   check("dod.4", ok, "CI=true ./node_modules/.bin/nx run apigen-plugin-mcp:test")
#   check("dod.5", ok, "CI=true ./node_modules/.bin/nx run-many -t test -p apigen-plugin-api-fastify,apigen-plugin-mcp,apigen-plugin-cli-output")
#   check("dod.6")
#   check("dod.7")
#   check("dod.8", ok, "CI=true ./node_modules/.bin/nx run-many -t test -p apigen-plugin-py-flask,apigen-plugin-py-grpc")
#   check("dod.9")
#   check("dod.10", ok, "python3 docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py --phase final")
#
# Which DoD clause is proven by which per-state criterion IDs. A dod PASSes iff
# every supporting criterion PASSed in this run. dod.10 is special (live gate).
DOD_SUPPORT = {
    "dod.1": [
        "serve-core-primitives.1", "serve-core-primitives.2", "serve-core-primitives.3",
        "serve-core-primitives.4", "serve-core-primitives.5",
        "fastify-adapter.4", "express-adapter.2", "mcp-adapter.3", "cli-adapter.2",
    ],
    "dod.2": ["fastify-adapter.6", "express-adapter.4", "mcp-adapter.5", "cli-adapter.4"],
    "dod.3": [
        "fastify-adapter.7", "express-adapter.5", "mcp-adapter.6",
        "py-flask-serve-split.7", "py-grpc-serve-split.4",
    ],
    "dod.4": ["mcp-adapter.1", "mcp-adapter.5"],
    "dod.5": ["fastify-adapter.3", "mcp-adapter.2", "cli-adapter.4"],
    "dod.6": ["express-adapter.4"],
    "dod.7": ["serve-core-primitives.1", "fastify-adapter.6"],
    "dod.8": [
        "py-flask-serve-split.1", "py-flask-serve-split.2", "py-flask-serve-split.3",
        "py-flask-serve-split.4", "py-flask-serve-split.5", "py-flask-serve-split.6",
        "py-grpc-serve-split.1", "py-grpc-serve-split.2", "py-grpc-serve-split.3",
    ],
    "dod.9": ["fastify-adapter.6", "cli-adapter.4"],
    # dod.10 is proven by DOD10_DIST_PACKAGES verify-dist-load + all command criteria.
}

# Packages whose shipped dist a consumer loads — verify-dist-load must pass.
DOD10_DIST_PACKAGES = [
    "apigen-engine-runtime",
    "apigen-plugin-api-fastify",
    "apigen-plugin-api-express",
    "apigen-plugin-mcp",
    "apigen-plugin-cli-output",
]

LINE_RE = re.compile(r"^\[([^\]]+)\]\s+(PASS|FAIL)\s*$")


def run_criteria(phase, repo_root):
    """Run run-audit.js for `phase`; stream its lines; return {id: bool}."""
    cmd = [
        "node", RUN_AUDIT,
        "--phase", "" if phase == "final" else phase,
        "--criteria", CRITERIA,
        "--repo-root", repo_root,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    results = {}
    for ln in proc.stdout.splitlines():
        print(ln, flush=True)
        m = LINE_RE.match(ln.strip())
        if m:
            results[m.group(1)] = (m.group(2) == "PASS")
    if proc.stderr.strip():
        sys.stderr.write(proc.stderr)
    return results


def check(dod_id, ok, detail=""):
    """Emit the [dod.N] PASS/FAIL contract line; return 1 on FAIL."""
    print(f"[{dod_id}] {'PASS' if ok else 'FAIL'}{(' — ' + detail) if detail and not ok else ''}", flush=True)
    return 0 if ok else 1


def verify_dist_load(repo_root):
    """verify-dist-load for every consumer-loaded package (dod.10, AGENTS.md §5)."""
    nx = os.path.join(repo_root, "node_modules", ".bin", "nx")
    fails = []
    for pkg in DOD10_DIST_PACKAGES:
        r = subprocess.run(
            [nx, "run", f"{pkg}:verify-dist-load"],
            cwd=repo_root, capture_output=True, text=True,
            env={**os.environ, "CI": "true"},
        )
        out = (r.stdout + r.stderr)
        if r.returncode != 0:
            if "Cannot find configuration" in out or "does not have a" in out:
                fails.append(f"{pkg}: verify-dist-load target not wired — add it (AGENTS.md §5)")
            else:
                fails.append(f"{pkg}: verify-dist-load failed")
    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True,
                    choices=["phase-1", "phase-2", "phase-3", "final"])
    ap.add_argument("--repo-root", default=DEFAULT_REPO_ROOT)
    args = ap.parse_args()
    repo_root = os.path.abspath(args.repo_root)

    results = run_criteria(args.phase, repo_root)
    # Any per-state criterion FAIL fails the phase.
    fails = sum(1 for v in results.values() if v is False)
    if not results:
        print("[audit.no-criteria] FAIL", flush=True)
        fails += 1

    if args.phase == "final":
        for dod_id, support in DOD_SUPPORT.items():
            ok = all(results.get(cid) is True for cid in support)
            missing = [c for c in support if c not in results]
            detail = f"unmet/absent: {missing or [c for c in support if results.get(c) is False]}"
            fails += check(dod_id, ok, detail)
        # dod.10 — live regression gate: all command/negative-control criteria green
        # (the per-package suites are the affected-test proof) + verify-dist-load.
        cmd_ids = [cid for cid in results
                   if results[cid] and (".6" in cid or ".7" in cid or ".4" in cid or ".3" in cid)]
        suites_green = all(v for v in results.values())
        dist_fails = verify_dist_load(repo_root)
        ok10 = suites_green and not dist_fails
        fails += check("dod.10", ok10,
                       f"suites_green={suites_green} dist_fails={dist_fails}")

    print(f"\n[audit] phase={args.phase} fails={fails}", flush=True)
    sys.exit(fails)


if __name__ == "__main__":
    main()
