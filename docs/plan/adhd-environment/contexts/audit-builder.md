# audit-builder

**Phase:** audit · **Kind:** audit · **Depends on:** builder-snapshot-api · **Guard:** `npx --yes nx build environment-base-spec && npx --yes nx build environment-builder`

---

## Goal

Verify that the builder phase (contract-base-spec → builder-engine → builder-snapshot-api) is complete and correct. All 3 states must pass their acceptance criteria before runtime states begin.

---

## Acceptance criteria

- [audit-builder.1] All builder-phase packages build successfully

---

## Reservations

```text
read_only:  []
mutates:    ["scripts/audit_audit-builder.py"]
```

---

## Notes for executor

1. This is a hold point — do not advance to runtime states until all checks pass.
2. Run the full contract-base-spec, builder-engine, and builder-snapshot-api acceptance criteria as regression checks.
3. If any criteria fail, fix in the owning state, not in this audit.