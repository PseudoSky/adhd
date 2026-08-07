# audit-schema — SCHEMA-PHASE AUDIT HOLD POINT

**Phase:** audit · **Kind:** audit · **Depends on:** enforcement-plugin · **Guard:** `python3 docs/plan/agent-policy/scripts/audit_policy.py --phase schema`

---

## Goal

Every schema-phase criterion is green before seeding begins: the package builds
`platform:node`, the `policy_types` lookup + `policy_templates` + `agent_policy`
tables exist with the required shape, both stores round-trip after reopen,
inheritance is observable, and the enforcement plugin throws through the real
registry. This is a hold point — no deferrable items.

---

## Semantic Distillation

- **Primitive:** RUN `audit_policy.py --phase schema`. It runs the architecture
  checks plus every work-state criterion (`scaffold-package.*`,
  `policy-type-and-template-schema.*`, `agent-policy-junction.*`,
  `policy-inheritance.*`, `enforcement-plugin.*`, `seed-and-roundtrip.*` — the
  test entrypoints are already authored) and `audit-schema.1`.
- Every guard the audit runs is env-pinned (`npx --yes nx ...`, `python3 ...`).

---

## Acceptance criteria

- [audit-schema.1] schema-phase audit self-consistent

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-policy/scripts/audit_policy.py"]
```

---

## Commit points

- `chore(agent-policy): schema-phase audit green`

## Notes for executor

- An audit state carries no deferrable work. If a check is red, fix the offending
  WORK state — never weaken the audit.
- `better-sqlite3` vitest teardown can segfault — the audit keys on the runner's
  EXIT CODE, not stdout `grep -q passed` (CLAUDE.md verification standard #4).
