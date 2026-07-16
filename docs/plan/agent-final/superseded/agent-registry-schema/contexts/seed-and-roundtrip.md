# seed-and-roundtrip — SEED THE COMPONENT LIBRARY + PROVE END-TO-END ROUND-TRIP

**Phase:** seed · **Kind:** work · **Depends on:** audit-schema · **Guard:** `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/roundtrip.test.ts`

---

## Goal

A `seed()` function populates every `prompt_type` and shared `prompt_component`
from `SEED_DATA.md` into a fresh DB, idempotently. The `roundtrip.test.ts`
suite proves the whole package end-to-end: seed → reopen → read components →
compose an agent → assert order; and that a second seed is idempotent.

---

## Semantic Distillation

- **Primitive:** ADD `src/seed/{prompt-types,components,index}.ts` + the
  end-to-end `roundtrip.test.ts`. Proves `[dod.1]` and `[dod.3]`.
- **Delta Spec:**
  - `seed/prompt-types.ts` — array of EVERY seed type from `SEED_DATA.md` §1:
    `role, identity, capability, rule, style, personality, process, invocation,
    success_criteria, handoff, escalation, posture, boundary, convergence,
    deliverable, evidence, context_pull, risk_posture` (each with description +
    `is_system: true`).
  - `seed/components.ts` — the shared components with REAL text from `SEED_DATA.md`
    §7+ (e.g. `default-skeptic`, `no-credentials`, `sox-handoff`). Use the actual
    seed content, not placeholders.
  - `seed/index.ts` — `seed(db)`: idempotent upsert (`INSERT OR IGNORE` / `ON
    CONFLICT DO NOTHING`) of types then components. Running twice is a no-op
    (`[inv:version-retained]` — never bump version on re-seed).
  - `roundtrip.test.ts` — three named cases:
    1. `"component round-trips after reopen"` — seed, CLOSE handle, reopen from
       same path, `ComponentStore.read('default-skeptic')` deep-equals the seed
       row (proves `[dod.1]`, `[inv:reopen-proves-persistence]`).
    2. `"seed is idempotent on re-run"` — count rows after one seed; run seed
       again; counts + versions identical (proves `[dod.3]`).
    3. `"agent composes seeded components in order"` — create an agent, attach 3
       seeded components at positions 1-3, `resolveComposition` returns them in
       order.
  - Export `seed` from `src/index.ts`.

---

## Acceptance criteria

- [seed-and-roundtrip.1] seed + reopen + idempotency round-trip suite passes
- [seed-and-roundtrip.2] prompt-types seed lists every DATA_MODEL seed type
- [seed-and-roundtrip.3] round-trip test has teeth: corrupting persisted content fails the reopen assertion

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry/src/store/component-store.ts", "packages/ai/agent-registry/src/db/schema.ts"]
mutates:    ["packages/ai/agent-registry/src/seed/prompt-types.ts", "packages/ai/agent-registry/src/seed/components.ts", "packages/ai/agent-registry/src/seed/index.ts", "packages/ai/agent-registry/src/__tests__/roundtrip.test.ts", "packages/ai/agent-registry/src/index.ts"]
```

---

## Commit points

- `feat(agent-registry): seed component library + end-to-end round-trip suite`

## Notes for executor

- The `[seed-and-roundtrip.3]` criterion is a NEGATIVE CONTROL: the audit will
  run `scripts/nc_mutate.mjs` to corrupt a persisted row, confirm the round-trip
  test goes RED, then `nc_restore.mjs` to restore. Author both tiny scripts (they
  are in this state's audit wiring) so the teeth are real, per CLAUDE.md
  verification standard #2. If you skip them, the criterion can't fail and proves
  nothing.
- Pull real component text from `SEED_DATA.md` — placeholders fail the intent of
  `[dod.3]` (idempotency of the actual library).
