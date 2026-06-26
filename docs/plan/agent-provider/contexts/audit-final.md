# audit-final — FINAL ACCEPTANCE GATE

**Phase:** audit · **Kind:** audit · **Depends on:** code-review · **Guard:** `python3 docs/plan/agent-provider/scripts/audit_provider.py --phase final`

---

## Goal

The acceptance gate for the whole plan. The `--phase final` audit re-runs every
schema-phase check PLUS the adapter / runtime / seed criteria AND emits a
`[dod.N]` PASS line per Definition-of-Done clause, each driving the clause's real
entrypoint (the behavioral `--testFile=…` tokens) or grep (structural). Exits 0
only when all six DoD clauses and every state criterion pass.

---

## Acceptance criteria

- [audit-final.1] final audit self-consistent (the `--phase final` run exits 0 with a PASS line for every [dod.1..6])

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-provider/scripts/audit_provider.py"]
```

---

## Notes for executor

- This is an AUDIT state — carry no deferrable work items. If a DoD check fails,
  fix the WORK state that owns it (see each clause's `delivered-by:`), never patch
  the audit to pass.
- Behavioral DoD checks (`dod.1`/`dod.2`/`dod.3`) DRIVE the vitest entrypoints
  named in the README and gate on EXIT CODES — better-sqlite3 can segfault on
  teardown, so never gate on stdout `grep -q passed`.
- Structural DoD checks (`dod.4`/`dod.5`/`dod.6`) are greps: `platform:node` in
  `project.json`, `provider_tool_formats` in `db/schema.ts`, `ProviderAdapter` in
  `agent-mcp-types/src/domain.ts`.
- The requesting engineer accepts the plan here.
