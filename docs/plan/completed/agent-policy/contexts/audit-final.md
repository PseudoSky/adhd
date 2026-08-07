# audit-final — FINAL AUDIT: PROVE EVERY [dod.N] THROUGH ITS REAL ENTRYPOINT

**Phase:** audit · **Kind:** audit · **Depends on:** code-review · **Guard:** `python3 docs/plan/agent-policy/scripts/audit_policy.py --phase final`

---

## Goal

The whole plan's Definition of Done is proven: every `[dod.N]` check executes its
real entrypoint and produces its named observable, and every prior-phase check is
still green. This is the acceptance gate.

---

## Semantic Distillation

- **Primitive:** RUN `audit_policy.py --phase final`. It runs everything in
  `phase_schema()` plus the behavioral DoD checks:
  - `[dod.1]` drives `inheritance.test.ts` (new category member inherits after reopen);
  - `[dod.2]` drives `enforcement-plugin.test.ts` (rate policy throws through the
    real `IHookRegistry.enforce("pre:model_request")`);
  - `[dod.3]` drives `roundtrip.test.ts` (seed idempotent + multi-value enforcement
    round-trips);
  - `[dod.4]`/`[dod.5]` structural checks (platform:node + path; lookup-not-enum
    grep_absent; required tables; `configSchema` + `createPlugin` plugin contract).
- `state-transition.js` will not advance to `done` unless every `[dod.N]` shows an
  executed PASS (exit 4 `dod_unconfirmed` otherwise).

---

## Acceptance criteria

- [audit-final.1] final audit passes: every prior-phase check green and DoD checks executed

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-policy/scripts/audit_policy.py"]
```

---

## Commit points

- `chore(agent-policy): final audit green — DoD proven`

## Notes for executor

- DoD checks must DRIVE the real test entrypoints — the command strings literally
  name `--testFile=...inheritance.test.ts` / `enforcement-plugin.test.ts` /
  `roundtrip.test.ts` so the proof is the real interaction, not a proxy.
- Confirm the negative controls bite before declaring done: run each dod's
  negative-control mutation (`nc_break_inheritance.mjs`, `nc_break_enforcement.mjs`,
  `nc_break_seed.mjs`) and confirm the relevant test goes red, then restore
  (CLAUDE.md verification standard #2).
- `[dod.2]` must drive the REAL `HookRegistry` from `@adhd/agent-mcp-types`, not a
  mock — a mock could fake a propagating throw the real registry wouldn't
  (CLAUDE.md verification standard #1).
