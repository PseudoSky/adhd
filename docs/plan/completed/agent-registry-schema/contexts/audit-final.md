# audit-final — FINAL AUDIT: PROVE EVERY [dod.N] THROUGH ITS REAL ENTRYPOINT

**Phase:** audit · **Kind:** audit · **Depends on:** seed-and-roundtrip · **Guard:** `python3 docs/plan/agent-registry-schema/scripts/audit_registry_schema.py --phase final`

---

## Goal

The whole plan's Definition of Done is proven: every `[dod.N]` check executes
its real entrypoint and produces its named observable, and every prior-phase
check is still green. This is the acceptance gate.

---

## Semantic Distillation

- **Primitive:** RUN `audit_registry_schema.py --phase final`. It runs everything
  in `phase_schema()` plus the behavioral DoD checks:
  - `[dod.1]` drives `roundtrip.test.ts` (component round-trips after reopen);
  - `[dod.2]` drives `composition-store.test.ts` (ordered/pinned/context-filtered);
  - `[dod.3]` drives `roundtrip.test.ts` (seed idempotent);
  - `[dod.4]`/`[dod.5]` structural grep checks (platform:node, required tables).
- `state-transition.js` will not advance to `done` unless every `[dod.N]` shows
  an executed PASS (exit 4 `dod_unconfirmed` otherwise).

---

## Acceptance criteria

- [audit-final.1] final audit passes: every prior-phase check green and DoD checks executed

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry-schema/scripts/audit_registry_schema.py"]
```

---

## Commit points

- `chore(agent-registry-schema): final audit green — DoD proven`

## Notes for executor

- DoD checks must DRIVE the real test entrypoints — the command strings literally
  name `--testFile=...roundtrip.test.ts` / `composition-store.test.ts` so the
  proof is the real interaction, not a proxy.
- Confirm the negative controls in README bite: before declaring done, run each
  dod's negative-control mutation and confirm the relevant test goes red, then
  restore (CLAUDE.md verification standard #2).
