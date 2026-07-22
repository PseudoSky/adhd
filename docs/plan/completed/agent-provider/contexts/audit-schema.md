# audit-schema — SCHEMA-PHASE AUDIT HOLD POINT

**Phase:** audit · **Kind:** audit · **Depends on:** provider-tool-formats · **Guard:** `python3 docs/plan/agent-provider/scripts/audit_provider.py --phase schema`

---

## Goal

A hold point: the foundation + schema phases are internally consistent before the
adapter/runtime phases begin. The `--phase schema` audit re-runs every
`scaffold-package` / `provider-and-model-schema` / `model-platform-bindings` /
`provider-tool-formats` criterion (structural greps + the three store tests) and
exits 0.

---

## Acceptance criteria

- [audit-schema.1] schema-phase audit self-consistent (the `--phase schema` run exits 0)

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-provider/scripts/audit_provider.py"]
```

---

## Notes for executor

- This is an AUDIT state — carry no deferrable work items. If a schema criterion
  fails, fix the offending WORK state, do not patch the audit to pass.
- The audit gates on EXIT CODES of the store-test commands, never on stdout
  (`grep -q passed`) — better-sqlite3 can segfault on teardown.
- No behavioral DoD is asserted in this phase; those land in `--phase final`.
