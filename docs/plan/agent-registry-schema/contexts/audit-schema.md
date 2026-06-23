# audit-schema — SCHEMA-PHASE AUDIT HOLD POINT

**Phase:** audit · **Kind:** audit · **Depends on:** composed-prompt-cache · **Guard:** `python3 docs/plan/agent-registry-schema/scripts/audit_registry_schema.py --phase schema`

---

## Goal

Every schema/composition-phase criterion is green: all tables exist with the
required fields, every store's reopen test passes, and the package builds clean.
No deferrable items — a failing check is fixed in source before advancing.

---

## Semantic Distillation

- **Primitive:** RUN `audit_registry_schema.py --phase schema`. The script is
  read-only over the codebase; fixes happen in the work states' source files,
  never by weakening a check.
- The script's `phase_schema()` runs: `scaffold-package.*`,
  `lookup-and-component-schema.*`, `agent-and-taxonomy-schema.*`,
  `composition-junction.*`, `usecase-and-context-rules.*`,
  `composed-prompt-cache.*`, `seed-and-roundtrip.*`, plus the architecture-phase
  decision checks.
- The audit runs without network or model — pure build + grep + vitest exit codes.

---

## Acceptance criteria

- [audit-schema.1] schema-phase audit script passes (all schema-state criteria green)

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-schema/scripts/audit_registry_schema.py"]
```

---

## Commit points

- `chore(agent-registry-schema): schema-phase audit green`

## Notes for executor

- The audit script is the read-only oracle. If a check fails, fix the SOURCE,
  re-run; never edit the check to pass. List every fix in the transition log.
- Gate on the script's EXIT CODE (it returns 1 on any failure), never on a
  `grep -q passed` of its stdout.
