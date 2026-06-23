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

- `[dod.2]` **Importing a fixture agent persists agent + prompt-component + agent-tool rows recoverable after the registry DB is closed and reopened. (behavioral)** — Importing a fixture agent persists agent + prompt-component + agent-tool rows recoverable after the registry DB is closed and reopened..
  - given: a fresh on-disk registry SQLite DB
  - when: import-agent imports code-reviewer.md then the DB handle is closed and reopened from the same path
  - then: AgentStore/ComponentStore/AgentToolStore read back the agent, its typed components in order, and its tools
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/import-pipeline.test.ts`
  - observable: `vitest exits 0 and the case 'import persists agent+components+tools after reopen' reopens the DB and deep-equals the read-back rows`
  - negative-control: `drop the component-insert in import-agent (or have it skip AGENT_COMPONENT rows) -> reopened read returns no/incomplete components -> import-pipeline.test.ts goes red`
  - delivered-by: `frontmatter-parser, body-section-splitter, import-pipeline`

- `[dod.3]` **A fixture SKILL.md migrates to a PROMPT_COMPONENT of type process/invocation recoverable after DB reopen. (behavioral)** — A fixture SKILL.md migrates to a PROMPT_COMPONENT of type process/invocation recoverable after DB reopen..
  - given: a fresh on-disk registry DB and the fixture ticket-creation.SKILL.md
  - when: import-skill imports the skill then the DB is reopened from the same path
  - then: the component is read back typed process or invocation with the skill body content preserved
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/skills-migration.test.ts`
  - observable: `vitest exits 0 and the case 'skill migrates to process/invocation component after reopen' reopens the DB and asserts the component type and content`
  - negative-control: `have import-skill write the wrong prompt_type (e.g. 'role') -> the type assertion fails -> skills-migration.test.ts goes red`
  - delivered-by: `skills-migration`

- `[dod.4]` **Removal is GATED on zero data loss: with a deliberately non-equivalent migrated agent (report not all-PASS), the removal runbook refuses to remove the fixture .md. (behavioral)** — Removal is GATED on zero data loss: with a deliberately non-equivalent migrated agent (report not all-PASS), the removal runbook refuses to remove the fixture .md..
  - given: an equivalence report containing at least one FAIL entry
  - when: the removal runbook's retire() is invoked against that report
  - then: retire() refuses (throws/returns blocked) and the fixture .md still exists
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/removal-runbook.test.ts`
  - observable: `vitest exits 0 and the case 'retire refuses when report is not all-PASS' asserts retire throws/aborts and the fixture path is untouched; a sibling case asserts an all-PASS report removes the fixture AND compile still produces the agent`
  - negative-control: `remove the all-PASS guard in retire() -> retire deletes the fixture despite a FAIL entry -> removal-runbook.test.ts goes red`
  - delivered-by: `removal-runbook, roundtrip-equivalence-gate`
