# audit-foundation — Phase-1 audit — serve-core primitives + fastify reference

**Phase:** phase-1 · **Kind:** audit · **Depends on:** fastify-adapter · **Guard:** `python3 docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py --phase phase-1`

---

## Goal

Every phase-1 criterion (serve-core-primitives, parity-harness, fastify-adapter) passes: the primitives exist and are exported, the parity harness works, and the fastify reference adapter's parity gate is green with its negative control proven. No deferrable items.

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

Read-only audit: fixes go in SOURCE, never by weakening a check. Runs `audit_apigen-serve-core.py --phase phase-1` which proxies run-audit.js over criteria.json (accumulating prior phases) and, for `final`, emits every `[dod.N]` proof. Every fix made during this audit is listed in the transition log.
