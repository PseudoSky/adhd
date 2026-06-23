# Agent Registry — Migration & Removal (@adhd/agent-registry-migration)

Builds `@adhd/agent-registry-migration`: the tooling that imports the existing
file-based agent corpus (346 `.md` agent definitions plus `.claude/skills/*/SKILL.md`)
into the relational Agent Registry, then **retires** the superseded file-based
systems — but only after a round-trip equivalence gate proves the registry is a
lossless replacement for every file. This is the **final** plan (7 of 7) of the
Agent Registry initiative: it consumes `@adhd/agent-registry` (plan 1) through
`@adhd/agent-compiler` (plan 5) and the refactored `@adhd/agent-mcp` (plan 6),
and it does the migration + removal phase that the whole initiative builds toward.

> **Plan set & ordering.** Plan 7 of 7 (source spec: `docs/plan/agent-registry/`).
> Ordering: `agent-registry-schema` → `agent-tool-registry`, `agent-provider`,
> `agent-policy` (parallel) → `agent-compiler` (plan 5; depends on the four) →
> `agent-mcp-refactor` (plan 6; depends on compiler) → **`agent-registry-migration`
> (plan 7; depends on compiler + refactor; does the migration AND the final
> removal)**. See `docs/plan/plan-index.json`. This plan is LAST in the set —
> nothing depends on it.

## Consumer

A platform/registry engineer running the one-time corpus migration. Today they
have 346 hand-authored `.md` agent files and a tree of `.claude/skills/*/SKILL.md`,
each carrying YAML frontmatter (`name`, `description`, `tools`, `model`) plus a
markdown body. They have no way to (a) get those into the normalized registry, or
(b) safely delete the files afterward without risking that the compiler emits
something different from what the file said. After this plan they run the import
tool, read a per-agent PASS/FAIL equivalence report, and retire files only for the
agents that round-trip — with the tool *refusing* to delete anything whose
compiled output differs from its source.

## Value delta

- **Before:** an agent's source of truth is a flat `.md` file in a separate repo;
  there is no programmatic path from file → registry, and "is it safe to delete
  this file?" is answered by hand. Skills live as loose `SKILL.md` files outside
  the registry entirely.
- **After:** the migration tool parses each file's frontmatter + body into typed
  `AGENT` / `PROMPT_COMPONENT` / `AGENT_TOOL` rows through the **real** registry
  stores; a round-trip gate runs `agent-registry compile <slug> --platform
  claude_code` and proves the emitted markdown is byte/behaviorally equivalent to
  the original; and removal is **forced** to depend on an all-PASS equivalence
  report so nothing is deleted until every agent round-trips. The output survives a
  process restart (imports are re-read after the registry DB is reopened).

## Execution model

- **Parallel execution:** No — a mostly linear pipeline (parse → import → verify →
  removal) with two audit hold points. `src/index.ts` is a shared mutable barrel
  written by every work state in sequence, so serialization is required.
- **Implementer:** one `backend-developer` / `typescript-pro`-class executor with
  Nx + better-sqlite3 + Drizzle in the environment, and the published
  `@adhd/agent-registry` + `@adhd/agent-compiler` packages on the workspace path.
- **Review:** `architect-reviewer` reviews `migration-design` output (the parse
  strategy, the equivalence definition, the zero-loss gate contract, and the
  cross-repo removal boundary) before any code; the final audit is the acceptance
  gate, accepted by the requesting engineer.
- **Automatic dispatch:** No — authored by the planner, executed by a separate
  executor agent across sessions.

## Cross-repo safety boundary (read before executing removal)

The actual 346 `.md` agent files and the `.claude/skills/` tree live in a
**separate repository** — `~/dev/ai/claude-agents` (REFERENCES.md "Primary
Source: claude-agents") — **not** in this `adhd` monorepo. Therefore:

- This plan builds and verifies the migration **tool** in
  `@adhd/agent-registry-migration` (this repo) against a **representative sample of
  FIXTURE `.md` files copied into the package** (`src/__fixtures__/`,
  e.g. `code-reviewer.md` — the canonical worked example from SEED_DATA §0 — and
  `ticket-creation.SKILL.md`).
- Every behavioral DoD and every removal DoD operates on the **in-repo fixtures**
  and the tool's verified-equivalence report. The audit guards NEVER reach into
  `~/dev/ai/claude-agents` and NEVER delete files in another repo.
- The actual cross-repo `claude-agents` removal is a **documented runbook step**
  (`RUNBOOK.md`) gated on an all-PASS equivalence report for the full corpus —
  executed by an operator, outside these guards, never automatically.

## Definition of Done

> Behavioral clauses are proven by vitest entrypoints that drive the REAL
> migration tool (parser → importer → compiler → equivalence gate → removal
> runbook) against a REAL on-disk registry SQLite DB and the REAL
> `@adhd/agent-compiler`, asserting persistence by REOPENING the store. Each names
> a `negative-control:` that must turn the clause red if the guarantee regresses.
> Mock only the absent external boundary (none here — even the compiler is real);
> never mock the thing under test.

- `[dod.1]` **A migrated fixture agent compiles to equivalent markdown vs. its
  original `.md`** — import `code-reviewer.md` into a real registry DB, run
  `agent-registry compile code-reviewer --platform claude_code`, and the normalized
  diff against the original fixture is empty. THE headline byte/behavioral
  equivalence gate. (behavioral)
  - given: the fixture `code-reviewer.md` is imported into a real registry DB
  - when: the equivalence gate runs `agent-registry compile code-reviewer --platform claude_code` and normalized-diffs the output against the original `.md`
  - then: the normalized diff is empty and the gate reports `code-reviewer = PASS`
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/roundtrip-equivalence.test.ts`
  - observable: `vitest exits 0 and the case 'fixture agent round-trips to equivalent markdown' asserts the normalized diff between compile output and the original .md is empty`
  - negative-control: `nc_mutate.mjs corrupts a persisted PROMPT_COMPONENT row → the normalized diff is non-empty → the roundtrip-equivalence.test.ts case goes red (proven by the [roundtrip-equivalence-gate.4] negative-control criterion in the audit)`
  - delivered-by: `migration-design, import-pipeline, roundtrip-equivalence-gate`

- `[dod.2]` **Importing a fixture agent persists agent + prompt-component +
  agent-tool rows recoverable after the registry DB is closed and reopened.**
  Persistence is proven by reopen, not in-memory state. (behavioral)
  - given: a fresh on-disk registry SQLite DB
  - when: `import-agent` imports `code-reviewer.md` then the DB handle is closed and reopened from the same path
  - then: `AgentStore`/`ComponentStore`/`AgentToolStore` read back the agent, its typed components in order, and its tools
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/import-pipeline.test.ts`
  - observable: `vitest exits 0 and the case 'import persists agent+components+tools after reopen' reopens the DB and deep-equals the read-back rows`
  - negative-control: `drop the component-insert in import-agent (or have it skip AGENT_COMPONENT rows) → reopened read returns no/incomplete components → import-pipeline.test.ts goes red`
  - delivered-by: `frontmatter-parser, body-section-splitter, import-pipeline`

- `[dod.3]` **A fixture `SKILL.md` migrates to a `PROMPT_COMPONENT` of type
  process/invocation recoverable after DB reopen.** (behavioral)
  - given: a fresh on-disk registry DB and the fixture `ticket-creation.SKILL.md`
  - when: `import-skill` imports the skill then the DB is reopened from the same path
  - then: the component is read back typed `process` or `invocation` with the skill body content preserved
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/skills-migration.test.ts`
  - observable: `vitest exits 0 and the case 'skill migrates to process/invocation component after reopen' reopens the DB and asserts the component type and content`
  - negative-control: `have import-skill write the wrong prompt_type (e.g. 'role') → the type assertion fails → skills-migration.test.ts goes red`
  - delivered-by: `skills-migration`

- `[dod.4]` **Removal is GATED on zero data loss** — with a deliberately
  non-equivalent migrated agent (the equivalence report is not all-PASS), the
  removal runbook *refuses* to remove the fixture `.md`. Nothing is deleted until
  the round-trip is verified for every agent. (behavioral)
  - given: an equivalence report containing at least one `FAIL` entry
  - when: the removal runbook's `retire()` is invoked against that report
  - then: `retire()` refuses (throws / returns blocked) and the fixture `.md` still exists
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/removal-runbook.test.ts`
  - observable: `vitest exits 0 and the case 'retire refuses when report is not all-PASS' asserts retire throws/aborts and the fixture path is untouched; a sibling case asserts an all-PASS report removes the fixture AND compile still produces the agent`
  - negative-control: `remove the all-PASS guard in retire() → retire deletes the fixture despite a FAIL entry → removal-runbook.test.ts goes red`
  - delivered-by: `removal-runbook, roundtrip-equivalence-gate`

- `[dod.5]` **`@adhd/agent-registry-migration` is a `platform:node` Nx library,
  registered in `tsconfig.base.json`, that depends on `@adhd/agent-registry` +
  `@adhd/agent-compiler` and builds clean.** (structural)
  - Proven by `[scaffold-package.1..5]` in the audit: `project.json` exists and is
    tagged `platform:node`, the tsconfig path is present, `package.json` declares
    the `@adhd/agent-registry` + `@adhd/agent-compiler` deps, and
    `nx build agent-registry-migration` exits 0.
  - delivered-by: `scaffold-package`

- `[dod.6]` **After an all-PASS removal, the fixture `.md` is gone AND
  `agent-registry compile` still produces the agent** — removal didn't break the
  agent. (structural)
  - Proven by the `removal-runbook.test.ts` cases (the `[dod.4]` entrypoint): after
    an all-PASS `retire()` the fixture path no longer exists (`!existsSync` /
    `! test -e`) AND `compile` still emits the agent. The audit `[dod.6]` /
    `[removal-runbook.1]` checks confirm both halves are asserted.
  - delivered-by: `removal-runbook`

---

## State graph

`migration-design` → `scaffold-package` → `frontmatter-parser` →
`body-section-splitter` → `import-pipeline` → `skills-migration` →
`roundtrip-equivalence-gate` → `audit-migration` → `removal-runbook` →
`audit-final` → done. See `state-machine.md` and `dag.json`.

`audit-migration` is the hold point that proves the tool is correct (parse →
import → round-trip equivalence) BEFORE the removal phase touches anything;
`removal-runbook` depends on it, so removal cannot start until the migration tool
is verified.

## Design questions handed to `migration-design`

Resolved (recorded in `decisions.md`) before any code:

1. **Equivalence definition** — byte-equivalent vs. behaviorally-equivalent.
   What normalization (trailing whitespace, blank-line runs, frontmatter key
   ordering, `tools:` list ordering) is applied before the diff, and why each
   normalization is sound (does not hide a real content loss). SEED_DATA §0 step 7
   calls the round-trip diff "the migration's correctness gate."
2. **Parse strategy** — YAML frontmatter parser + markdown body section splitter;
   the heading → `prompt_type` table (SEED_DATA §0 "Body → prompt components"); how
   the un-headed opening `You are a…` paragraph maps to `role`.
3. **Zero-loss gate contract** — the report shape (per-agent PASS/FAIL), and the
   forcing function: `retire()` MUST require an all-PASS report.
4. **Cross-repo removal boundary** — the in-repo fixtures vs. the external
   `claude-agents` corpus; what the guards may touch (fixtures only) and what is a
   documented operator runbook step (`RUNBOOK.md`).
