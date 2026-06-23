# audit-final — FINAL AUDIT: PROVE EVERY [dod.N] THROUGH ITS REAL ENTRYPOINT

**Phase:** audit · **Kind:** audit · **Depends on:** code-review · **Guard:** `python3 docs/plan/agent-registry-migration/scripts/audit_migration.py --phase final`

---

## Goal

The whole plan's Definition of Done is proven: every `[dod.N]` check executes its
real entrypoint and produces its named observable, and every prior-phase check is
still green. This is the acceptance gate for the FINAL plan of the initiative.

---

## Semantic Distillation

- **Primitive:** RUN `audit_migration.py --phase final`. It runs everything in
  `phase_migration()` plus the removal checks and the behavioral DoD checks:
  - `[dod.1]` drives `roundtrip-equivalence.test.ts` (migrated fixture compiles to
    equivalent markdown — THE headline);
  - `[dod.2]` drives `import-pipeline.test.ts` (rows recoverable after reopen);
  - `[dod.3]` drives `skills-migration.test.ts` (skill → process/invocation);
  - `[dod.4]` drives `removal-runbook.test.ts` (removal gated on all-PASS);
  - `[dod.5]`/`[dod.6]` structural grep checks (platform:node + deps; removal test
    asserts fixture-gone AND still-compiles).
- `state-transition.js` will not advance to `done` unless every `[dod.N]` shows an
  executed PASS (exit 4 `dod_unconfirmed` otherwise).

---

## Acceptance criteria

- [audit-final.1] final audit self-consistent

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-migration/scripts/audit_migration.py"]
```

---

## Commit points

- `chore(agent-registry-migration): final audit green — DoD proven`

## Notes for executor

- DoD checks must DRIVE the real test entrypoints — the command strings literally
  name `--testFile=...roundtrip-equivalence.test.ts` / `import-pipeline.test.ts` /
  `skills-migration.test.ts` / `removal-runbook.test.ts` so the proof is the real
  interaction, not a proxy.
- Before declaring done, confirm each negative control BITES: corrupt a migrated
  component (round-trip red), drop the component-insert (import red), write the
  wrong skill type (skills red), remove the all-PASS guard (removal red); then
  restore (CLAUDE.md verification standard #2).
- This is the LAST plan in the initiative — there is no downstream plan. The
  cross-repo corpus removal remains a documented RUNBOOK.md operator step, gated on
  a full-corpus all-PASS report, NOT executed by this audit (`[inv:cross-repo]`).
