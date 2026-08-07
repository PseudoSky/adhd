# audit-schema — MID-PLAN HOLD POINT: SCHEMA PHASE GREEN

**Phase:** audit · **Kind:** audit · **Depends on:** agent-tool-junction · **Guard:** `python3 docs/plan/agent-tool-registry/scripts/audit_tool_registry.py --phase schema`

---

## Goal

All structural and store-level work through `agent-tool-junction` is proven: every
schema table is present, every store test passes against a real reopened DB, the
package builds clean and imports no browser code, and `tool_types` is a lookup
table not an enum. This is the hold point before seeding.

---

## Semantic Distillation / Delta Spec

- **Primitive:** RUN `audit_tool_registry.py --phase schema`. It runs the
  `phase_schema()` block:
  - `[scaffold-package.1..5]` — package exists, tagged `platform:node`, tsconfig
    path present, builds clean, no browser globals.
  - `[tool-and-type-schema.1..3]`, `[platform-and-binding-schema.1..3]`,
    `[mcp-server-schema.1..2]`, `[agent-tool-junction.1..2]` — tables present +
    store tests pass (each store test reopens the DB).
  - `[seed-and-roundtrip.1..3]` are also listed in `phase_schema()`; before the
    seed state runs they will be RED, which is correct — this audit gate is
    crossed once the schema states are green and is re-crossed clean only at
    `audit-final`. (The state machine advances per-state guard; this audit's own
    guard is the schema-phase subset that is green at this point.)
- This is an audit state: it carries NO deferrable items and writes no package
  code — only the audit script (already authored).

---

## Acceptance criteria

- [audit-schema.1] schema-phase audit passes

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-tool-registry/scripts/audit_tool_registry.py"]
```

---

## Commit points

- `chore(agent-tool-registry): schema-phase audit green`

## Notes for executor

- Gate on the EXIT CODE of the audit script, never on stdout grep
  (`feedback_plan_execution_pitfalls`; better-sqlite3 can segfault on teardown).
- If a store test is RED here, fix the store/schema — do NOT relax the audit.
