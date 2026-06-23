# Agent Registry — Prompt Component Schema (@adhd/agent-registry)

<one-paragraph statement of what this plan delivers>

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **A prompt component round-trips through the real store: created via ComponentStore against a real SQLite DB, it is read back byte-identical after the store is reopened (persistence proven by reopen, not in-memory state). (behavioral)** — A prompt component round-trips through the real store: created via ComponentStore against a real SQLite DB, it is read back byte-identical after the store is reopened (persistence proven by reopen, not in-memory state)..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/roundtrip.test.ts`
  - observable: `vitest exit 0 and reporter shows the 'component round-trips after reopen' test passing`
  - delivered-by: `seed-and-roundtrip, lookup-and-component-schema`

- `[dod.2]` **An agent composed from ordered component rows yields its components in assembly order with version pins and context conditions honored, queried back through CompositionStore against a real DB. (behavioral)** — An agent composed from ordered component rows yields its components in assembly order with version pins and context conditions honored, queried back through CompositionStore against a real DB..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/composition-store.test.ts`
  - observable: `vitest exit 0 and the 'resolveComposition returns ordered, pinned, context-filtered components' test passes`
  - delivered-by: `composition-junction`

- `[dod.3]` **Seeding populates every prompt_type and shared component from SEED_DATA into a fresh DB, and a second seed run is idempotent (no duplicate rows, version unchanged). (behavioral)** — Seeding populates every prompt_type and shared component from SEED_DATA into a fresh DB, and a second seed run is idempotent (no duplicate rows, version unchanged)..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/roundtrip.test.ts`
  - observable: `vitest exit 0 and the 'seed is idempotent on re-run' test passes`
  - delivered-by: `seed-and-roundtrip`
