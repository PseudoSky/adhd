# seed-and-roundtrip — SEED THE POLICY LIBRARY + PROVE IDEMPOTENT ROUND-TRIP

**Phase:** seed · **Kind:** work · **Depends on:** audit-schema · **Guard:** `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/roundtrip.test.ts`

---

## Goal

A `seed()` function populates every `policy_type` and the system `policy_templates`
from `SEED_DATA` (including templates with MULTI-VALUE `enforcement` arrays) into a
fresh DB, idempotently. The `roundtrip.test.ts` suite proves it end-to-end: seed →
reopen → read a template (with its `enforcement` array intact) → assert; and that a
second seed is a no-op.

---

## Semantic Distillation

- **Primitive:** ADD `src/seed/{policy-types,policy-templates,index}.ts` + the
  end-to-end `roundtrip.test.ts`. Proves `[dod.3]`. See `[inv:enforcement-is-array]`,
  `[inv:reopen-proves-persistence]`.
- **Delta Spec:**
  - `seed/policy-types.ts` — every type from `SEED_DATA.md` §3: `permission`,
    `safety`, `audit`, `rate`, `scope`, `compliance`, `quality` (each with
    description). LOOKUP rows (`[inv:lookup-not-enum]`).
  - `seed/policy-templates.ts` — the system templates with REAL `rules` JSON from
    `SEED_DATA.md` §9, at minimum: `reviewer-posture` (`safety`, `["agent"]`),
    `no-credentials` (`safety`, `["agent","ci"]` — the multi-value case),
    `sox-audit-trail` (`audit`, `["hook"]`), `max-rework-3` (`rate`,
    `["runtime"]`). Each `is_system: true`, `version: 1`. Use the actual seed
    `rules` content, not placeholders.
  - `seed/index.ts` — `seed(db)`: idempotent upsert (`INSERT OR IGNORE` / `ON
    CONFLICT DO NOTHING`) of types then templates. Running twice is a no-op (never
    bump `version` on re-seed).
  - `roundtrip.test.ts` — named cases, real on-disk DB:
    1. `"policy template round-trips after reopen"` — seed, CLOSE handle, reopen
       from same path, `PolicyTemplateStore.read("no-credentials")` deep-equals the
       seed row INCLUDING its `enforcement` array `["agent","ci"]` (proves
       `[dod.3]`, `[inv:reopen-proves-persistence]`, `[inv:enforcement-is-array]`).
    2. `"seed is idempotent on re-run"` — count `policy_types` + `policy_templates`
       rows after one seed; run seed again; counts + versions identical.
  - Export `seed` from `src/index.ts`.

---

## Acceptance criteria

- [seed-and-roundtrip.1] seed + reopen + idempotency round-trip suite passes
- [seed-and-roundtrip.2] seed lists the SEED_DATA policy templates incl. multi-value enforcement
- [seed-and-roundtrip.3] round-trip has teeth: plain INSERT (non-idempotent) duplicates rows and fails the second-seed assertion

---

## Reservations

```text
read_only:  ["packages/ai/agent-policy/src/store/policy-template-store.ts", "packages/ai/agent-policy/src/db/schema.ts"]
mutates:    ["packages/ai/agent-policy/src/seed/policy-types.ts", "packages/ai/agent-policy/src/seed/policy-templates.ts", "packages/ai/agent-policy/src/seed/index.ts", "packages/ai/agent-policy/src/__tests__/roundtrip.test.ts", "packages/ai/agent-policy/src/index.ts"]
```

---

## Commit points

- `feat(agent-policy): seed policy library + idempotent end-to-end round-trip suite`

## Notes for executor

- Pull REAL `rules` text from `SEED_DATA.md` §9 — placeholders defeat the intent
  of `[dod.3]` (idempotency + reopen of the actual library). `no-credentials` MUST
  carry `enforcement: ["agent","ci"]` so the multi-value round-trip is exercised.
- `[seed-and-roundtrip.3]` is a NEGATIVE CONTROL: the audit runs
  `scripts/nc_break_seed.mjs` to switch `seed()` to plain `INSERT` (non-idempotent),
  confirms the second-seed assertion goes RED, then `scripts/nc_restore_seed.mjs`
  restores. Author both tiny scripts so the teeth are real (CLAUDE.md verification
  standard #2).
- `better-sqlite3` vitest teardown can segfault — gate on EXIT CODE, not stdout.
- Proves `[dod.3]`.
