#!/usr/bin/env python3
"""
audit_lt-final-audit.py — final DoD audit for the apigen-logical-types plan.

Every Definition-of-Done clause [dod.N] maps to ONE deterministic check here that
drives the clause's real entrypoint and exits 0 iff the observable holds. Behavioral
clauses are proven by `scripts/probe_logical.mjs`, which (like apigen-client-generation's
probe_mcp.mjs) DERIVES each expected observable from the fixture at runtime — no
hard-coded values — and keys the audit on the process EXIT CODE (never `| grep -q`).

Until the feature states are implemented these checks are RED by design: an unimplemented
clause MUST fail, and each clause names a `negative-control` (see README) that must turn it
red if the bug is reintroduced.

Usage:
  python3 docs/plan/apigen-logical-types/scripts/audit_lt-final-audit.py            # all DoD
  python3 docs/plan/apigen-logical-types/scripts/audit_lt-final-audit.py --phase dod
"""
import argparse
import subprocess
import sys

PASS = 0
FAIL = 0


def check(cid: str, desc: str, cmd: str) -> None:
    global PASS, FAIL
    rc = subprocess.run(cmd, shell=True).returncode
    ok = rc == 0
    print(f"[{'PASS' if ok else 'FAIL'}] {cid}  {desc}  (exit {rc})")
    if ok:
        PASS += 1
    else:
        FAIL += 1


def phase_dod() -> None:
    # Commands are INLINE (no variables) so the gap-check static scan sees each clause's
    # entrypoint token in its own check line. `probe_logical.mjs` DERIVES the observable
    # from the fixture; `--check` makes it ASSERT (exit non-zero on mismatch); CLI clauses
    # pass `--cli dist/packages/apigen/cli/index.js` to drive the REAL built bin.
    check("dod.1", "Date param/return round-trips over MCP/HTTP via the built bin",
          "node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 1 --cli dist/packages/apigen/cli/index.js --check")
    check("dod.2", "int64 beyond MAX_SAFE_INTEGER round-trips without precision loss",
          "node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 2 --check")
    check("dod.3", "user class round-trips TS->wire->Python->wire->TS as a real instance both hosts",
          "python3 docs/plan/apigen-logical-types/scripts/audit_lt-conformance-crosshost.py")
    check("dod.4", "Dog|Cat dispatches to the correct variant by wire discriminator",
          "node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 4 --check")
    check("dod.5", "full conformance vector set encodes byte-equal across TS and Python",
          "npx nx run apigen-conformance:conformance")
    check("dod.6", "validate-Layer rejects a malformed date-time (ajv-formats)",
          "node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 6 --check")
    check("dod.7", "schema-less any position round-trips a Date via the $apigen envelope",
          "node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 7 --check")
    check("dod.8", "unannotated source class transcodes via schema projection (Tenet 1)",
          "node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 8 --check")
    check("dod.9", "run/generate fail fast on 0 functions and on a missing optional rich-type dep",
          "node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 9 --cli dist/packages/apigen/cli/index.js --type api-fastify --check")
    check("dod.10", "generated surface using Decimal declares decimal.js and runs after clean install",
          "node docs/plan/apigen-logical-types/scripts/probe_logical.mjs --dod 10 --cli dist/packages/apigen/cli/index.js --mode generate --check")


PHASES = {"dod": phase_dod, "final": phase_dod}


def main() -> int:
    ap = argparse.ArgumentParser(description="apigen-logical-types final DoD audit")
    ap.add_argument("--phase", choices=sorted(PHASES), default="dod")
    args = ap.parse_args()
    PHASES[args.phase]()
    print(f"\n{PASS}/{PASS + FAIL} checks passed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
