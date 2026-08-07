# audit-engine — SCHEMA-PHASE HOLD POINT

**Phase:** audit · **Kind:** audit · **Depends on:** compile-cli, composed-prompt-caching · **Guard:** `python3 docs/plan/agent-compiler/scripts/audit_compiler.py --phase schema`

---

## Goal

The whole engine is built and self-consistent BEFORE the e2e convergence test: the
schema-phase audit runs every architecture + work-state check (scaffold, the four
resolve/emit layers, the CLI, the cache) and they are all green. This is the
mid-plan hold point — it gates entry to `compile-fixtures-e2e`.

---

## Semantic Distillation

- **Primitive:** RUN `audit_compiler.py --phase schema`. It runs
  `phase_architecture()` + all work-state criteria through `composed-prompt-caching`.
- No code here — this state only proves the engine is internally consistent.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [audit-engine.1] schema-phase audit self-consistent

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-compiler/scripts/audit_compiler.py"]
```

---

## Commit points

- `chore(agent-compiler): schema-phase audit green`

## Notes for executor

- Audit state — carries no deferrable items. If a check fails, fix the offending
  work state; do not weaken the check.
- The behavioral DoD checks (`dod.*`) run in `--phase final`, not here — this hold
  point precedes the e2e proof.
