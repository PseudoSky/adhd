<!-- markdownlint-disable MD013 -->
# Final review — apigen-logical-types

**Reviewer:** plan-orchestrator · **Date:** 2026-06-26 · **Verdict:** ✅ DoD MET (re-verified on current code)

All 10 DoD clauses re-driven through their real entrypoints on the **current** built artifact + codecs
(not the 2026-06-25 audit snapshot — the codecs changed since via BUG-APIGEN-015 + DEBT-LT-001/002/003, so a
fresh re-verification was required per the stale-approval discipline). Every clause is green.

## DoD clause re-verification (current code, 2026-06-26)

| Clause | Entrypoint driven | Result |
|---|---|---|
| `[dod.1/scalar]` Date round-trips over the built bin | `probe_logical.mjs --dod 1 --cli dist/.../cli/index.js --check` | ✅ EXIT 0 |
| `[dod.2/int64]` int64 past 2^53 exact | `probe_logical.mjs --dod 2 --check` | ✅ EXIT 0 (9007199254740993 survives as exact BigInt) |
| `[dod.3/nominal]` class TS↔Python real-instance round-trip | `nx test apigen-runtime` (nominal-codec + host-ts) + conformance | ✅ 114/114 EXIT 0 |
| `[dod.4/union]` discriminated dispatch | `probe_logical.mjs --dod 4 --check` | ✅ EXIT 0 (`"cat"` → variant Cat) |
| `[dod.5/crosshost]` full vector set byte-equal TS↔Python | `nx run apigen-conformance:conformance` | ✅ 22 vectors, 0 failed, both hosts conformant, EXIT 0 |
| `[dod.6/validate]` validate-Layer rejects malformed date-time | `probe_logical.mjs --dod 6 --check` | ✅ EXIT 0 |
| `[dod.7/envelope]` schema-less Date via `$apigen` envelope | `probe_logical.mjs --dod 7 --check` | ✅ EXIT 0 |
| `[dod.8/no-annotation]` unannotated class via schema projection | `probe_logical.mjs --dod 8 --check` | ✅ EXIT 0 |
| `[dod.9/fail-fast + decimal guard]` | `probe_logical.mjs --dod 9 --cli … --type api-fastify --check` | ✅ EXIT 0 |
| `[dod.10/dep-manifest]` generated surface declares decimal.js | `probe_logical.mjs --dod 10 --cli … --mode generate --check` | ✅ EXIT 0 |

Negative-controls for each clause are encoded in the probe / conformance gate (reverting the relevant codec
turns the clause red) — they were exercised during execution and the probe asserts the derived observable.

## Post-audit finding (disclosed, resolved, strengthens the DoD)

After the original final audit, driving the **real HTTP hosts** (not just the codec layer) surfaced
**BUG-APIGEN-015**: the api-fastify host emitted scalar logical *returns* as `text/plain` (`123.456`) while
py-flask emitted canonical JSON (`"123.456"`) — a response-envelope drift that `[dod.5/crosshost]` did not
cover (that clause asserts the conformance *vectors/codecs* are byte-equal, which they are; it does not assert
each host's HTTP response serialization). Fixed (api-fastify now JSON-encodes results) and **guarded** by a
new default-running cross-host response-envelope test whose teeth were proven by negative control. The
polyglot "one wire, every language" guarantee now holds at the HTTP layer too — the DoD is stronger than when
the audit ran.

## Supporting gates (current code)

- `nx test` apigen-{schema,logical,cli,conformance,core,runtime} → EXIT 0 (25/186/131+/22/201/114).
- `nx lint` apigen projects → EXIT 0 (0 errors).
- `python3 run_tests.py` → 124/124 EXIT 0.
- Runnable user demo `docs/apigen/demo-logical-types.sh` (all four frameworks at once via `apigen serve`) → PASS=11 FAIL=0.

DoD provenance (planning gate) confirmed by pseudosky 2026-06-24 (10 clauses, negative-controls hardened).
This terminal review confirms those clauses are **delivered and verified** on the shipped code.
