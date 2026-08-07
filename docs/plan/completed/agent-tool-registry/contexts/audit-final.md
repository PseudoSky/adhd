# audit-final — FINAL AUDIT: PROVE EVERY [dod.N] THROUGH ITS REAL ENTRYPOINT

**Phase:** audit · **Kind:** audit · **Depends on:** code-review · **Guard:** `python3 docs/plan/agent-tool-registry/scripts/audit_tool_registry.py --phase final`

---

## Goal

The whole plan's Definition of Done is proven: every `[dod.N]` check executes its
real entrypoint and produces its named observable, and every prior-phase check is
still green. This is the acceptance gate.

---

## Semantic Distillation / Delta Spec

- **Primitive:** RUN `audit_tool_registry.py --phase final`. It runs everything in
  `phase_schema()` plus the behavioral DoD checks:
  - `[dod.1]` drives `binding-store.test.ts` (canonical → platform alias after
    reopen);
  - `[dod.2]` drives `roundtrip.test.ts` (seed idempotent + binding round-trips);
  - `[dod.3]` drives `agent-tool-store.test.ts` (grant queryable at permission
    level after reopen);
  - `[dod.4]` structural grep (platform:node + tsconfig path);
  - `[dod.5]` structural grep (required tables present) + `grep_absent` proving
    `tool_types` is NOT a SQL enum.
- `state-transition.js` will not advance to `done` unless every `[dod.N]` shows an
  executed PASS (exit 4 `dod_unconfirmed` otherwise).
- This is an audit state: NO deferrable items; writes only the audit script.

---

## Acceptance criteria

- [audit-final.1] final audit passes: every prior check green and DoD checks executed

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-tool-registry/scripts/audit_tool_registry.py"]
```

---

## Commit points

- `chore(agent-tool-registry): final audit green — DoD proven`

## Notes for executor

- DoD checks must DRIVE the real test entrypoints — the command strings literally
  name `--testFile=...binding-store.test.ts` / `roundtrip.test.ts` /
  `agent-tool-store.test.ts` so the proof is the real interaction, not a proxy.
- Before declaring done, run each DoD's negative-control mutation (README) and
  confirm the relevant test goes RED, then restore (CLAUDE.md verification
  standard #2). For `[dod.1]`: make `BindingStore.resolve` ignore the platform
  arg. For `[dod.3]`: make `grant` hardcode `full`.
- Gate on the EXIT CODE of the audit script, never on stdout grep
  (better-sqlite3 can segfault on teardown).
