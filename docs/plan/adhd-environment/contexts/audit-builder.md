# audit-builder

**Phase:** audit · **Kind:** audit · **Depends on:** builder-snapshot-api · **Guard:** `true`

---

## Goal

Verify that the builder phase (contract-base-spec → builder-engine → builder-snapshot-api) is complete and correct. All 3 states must pass their acceptance criteria before runtime states begin.

---

## Acceptance criteria

- [audit-builder.1] `npx nx build environment-base-spec` exits 0
- [audit-builder.3] `build(spec)` returns `EnvironmentSnapshot` with correct `.get()`, `.set()`, `.configPath`, `.write()`
- [audit-builder.5] Atomic write integrity: simulated crash leaves no partial file



```text
read_only:  []
mutates:    ["scripts/audit_audit-builder.py"]
```

---

## Notes for executor

1. This is a hold point — do not advance to runtime states until all checks pass.
2. Run the full contract-base-spec, builder-engine, and builder-snapshot-api acceptance criteria as regression checks.
3. If any criteria fail, fix in the owning state, not in this audit.