# audit-python — Phase-3 audit — py-flask/py-grpc extract/serve split

**Phase:** phase-3 · **Kind:** audit · **Depends on:** py-flask-serve-split, py-grpc-serve-split · **Guard:** `python3 docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py --phase phase-3`

---

## Goal

Every phase-3 criterion passes: the preflight DECISION is recorded, both Python servers serve from the injected TS plan, the three re-derivation functions are deleted, and both parity gates are green with negative controls proven. Accumulates phase-1.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py"]
```

---

## Notes for executor

Read-only audit: fixes go in SOURCE, never by weakening a check. Runs `audit_apigen-serve-core.py --phase phase-3` which proxies run-audit.js over criteria.json (accumulating prior phases) and, for `final`, emits every `[dod.N]` proof. Every fix made during this audit is listed in the transition log.
