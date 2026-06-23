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
