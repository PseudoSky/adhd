# Agent Registry — Migration & Removal (@adhd/agent-registry-migration)

<one-paragraph statement of what this plan delivers>

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **A migrated fixture agent compiles to equivalent markdown vs. its original .md (import -> agent-registry compile <slug> --platform claude_code -> normalized diff is empty). (behavioral)** — A migrated fixture agent compiles to equivalent markdown vs. its original .md (import -> agent-registry compile <slug> --platform claude_code -> normalized diff is empty)..
  - given: the fixture code-reviewer.md is imported into a real registry DB
  - when: the equivalence gate runs agent-registry compile code-reviewer --platform claude_code and normalized-diffs the output against the original .md
  - then: the normalized diff is empty and the gate reports code-reviewer = PASS
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/roundtrip-equivalence.test.ts`
  - observable: `vitest exits 0 and the case 'fixture agent round-trips to equivalent markdown' asserts the normalized diff between compile output and the original .md is empty`
  - negative-control: `nc_mutate.mjs corrupts a persisted PROMPT_COMPONENT row -> the normalized diff is non-empty -> the roundtrip-equivalence.test.ts case goes red`
  - delivered-by: `import-pipeline, roundtrip-equivalence-gate`
