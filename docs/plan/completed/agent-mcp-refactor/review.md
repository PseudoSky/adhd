# code-review — agent-mcp-refactor (Plan 6 of 7), FINAL gate (wave 8)

**Reviewer:** code-reviewer (opus) · **State:** `code-review` (depends on `session-e2e`)
**Scope:** full refactor diff `agent-mcp-baseline-pre-registry..HEAD` for `packages/ai/agent-mcp/src`,
with focus on the e2e proofs (`session-e2e`) and overall plan completeness.
**Posture:** default NEEDS-WORK; an APPROVED verdict is explicitly justified below.
**Mutates only:** this `review.md`. Source was read-only — defects would be NEEDS-WORK findings, not patches.

This is the second of two review gates. The integration/retire core was APPROVED in
`code-review-integration` (`review-integration.md`); this gate scrutinises the behavioral
DoD teeth against the project standard (CLAUDE.md "Proving features actually work":
real components, teeth, exit-code-gated, no proxy) and confirms plan completeness.

---

## Evidence (run this session; gated on EXIT CODE, never stdout grep)

| Check | Result |
|---|---|
| `npx --yes nx test agent-mcp` | **exit 0** — 252 passed, 4 skipped (31 files passed, 3 skipped) |
| `npx --yes nx build agent-mcp` | **exit 0** — clean |
| `…--testFile=…/session-compiler-e2e.test.ts` | **exit 0** — 2 passed |
| `…--testFile=…/cache-reuse.test.ts` | **exit 0** — 2 passed |
| Real negative control (`session-e2e.3`): `sed` rename `compileAgent`→`__noCompile` in `prompt-resolver.ts`, rerun positive e2e | **exit 1 (RED) under mutation**, restored clean via `git checkout` — teeth confirmed |
| Ghost-pass guard: raw `nx test --testFile=<missing>` | exits **0** (ghost pass); the hardened `check()` `test -f` prefix short-circuits to **non-zero** — hardening is load-bearing |
| Back-out tag `agent-mcp-baseline-pre-registry` | resolves (`af424c1`); diff scoped to agent-mcp + types — clean revert point intact |

---

## What I verified for the focus items

### dod.1 — `session-compiler-e2e.test.ts` drives the REAL path (not a re-implementation)
- The test wires the REAL `agentTool` (`tools/session.ts`), REAL `AgentStore` /
  `SessionStore` / `ComposedPromptStore`, and REAL `PolicyEngine` against an
  **on-disk** SQLite file (`mkdtempSync` → `agents.db`) with migrations applied via
  `runMigrationsOn`. Only `compileAgentFn` (the compiler/LLM boundary) is stubbed
  (`session-compiler-e2e.test.ts:92-99,106-124,135-141`).
- The resolve→create sequence is NOT inlined: `agentTool` itself calls
  `resolveComposedPrompt` (`tools/session.ts:79-91`) → `ComposedPromptStore.upsert`
  → `SessionStore.create({ composedPromptId })`. The test never re-runs that logic.
- Assertion has teeth and is reopen-proven: the handle is `close()`d, the DB is
  REOPENED from the same path, and `SessionStore.getAgentDefinition(sessionId)
  .systemPrompt` is asserted `toBe(COMPILED_CONTENT)` and `.not.toBe` the authored
  string (`session-compiler-e2e.test.ts:144-157`). It further reads raw
  `sessions.composed_prompt_id` (non-null string) and joins
  `composed_prompts WHERE id = ?` to assert `content === COMPILED_CONTENT`
  (`:160-181`) — `composed_prompt_id` set + content match proven by reopen.
- Negative control present (`:200-231`) and the REAL production-mutate control
  (`criteria.json` `session-e2e.3`) was independently re-run this session: it went
  RED under mutation and restored — confirming the assertion fails if the wiring breaks.

### dod.2 — `cache-reuse.test.ts` proves single-compile reuse
- Drives the REAL `agentTool` TWICE for the same agent + context with a
  call-counting `compileAgentFn` stub (`cache-reuse.test.ts:87-102,133-154`).
- Asserts `callCount() === 1` across the two starts (`:158`), then REOPENS the DB
  and asserts both sessions' `composed_prompt_id` are non-null, equal
  (`cpId2 === cpId1`, `:181`), and that exactly ONE `composed_prompts` row exists
  (`COUNT(*) === 1`, `:188`). The cache semantics backing this are real:
  `resolveComposedPrompt` checks `findByAgentContext` before compiling
  (`prompt-resolver.ts:126-133`) and `upsert` double-checks before insert
  (`composed-prompt-store.ts:26-29`).
- Negative control (`:213-269`): two isolated in-memory caches force a cold lookup
  on the second start → `callCount() === 2`, explicitly `.not.toBe(1)` — proving the
  `toBe(1)` assertion goes RED when the cache is bypassed.

### Audit hardening (no ghost-passes) — INTACT
- `audit_mcp_refactor.py:80-82`: `check()` extracts `--testFile=(\S+)` and, unless the
  command already starts with `test -f`, prepends `test -f <file> && …`. I confirmed
  empirically that a raw `nx test --testFile=<missing>` exits 0 (`passWithNoTests:true`)
  while the `test -f` short-circuit yields a non-zero exit — so a `--testFile` criterion
  CANNOT pass against a missing proof file. Hardening is present and effective.

### Plan completeness — all 6 DoD clauses backed by real teeth
- **dod.1 / dod.2** — behavioral, real-path, reopen-proven, teeth confirmed (above).
- **dod.3** — non-regression: full suite exit 0, 252 passed.
- **dod.4** — flat-`systemPrompt` AUTHORING path gone: `validation/agent.ts:115` is
  `systemPrompt: z.optional(z.string())` with a COMPUTED-COMPAT-SHIM JSDoc; the patch
  schema likewise (`:146-147`). `grep_absent` of `systemPrompt: z\.string\(\)` holds.
- **dod.5** — runtime sink schema + compiler dep: `composed_prompts` +
  `experiment_assignments` tables and `sessions.composed_prompt_id` column present
  (`db/schema.ts:44,131,158`; migration `drizzle/0006_composed_prompts_cache.sql`);
  `@adhd/agent-compiler` declared in package.json + tsconfig.base.json paths.
- **dod.6** — claudecli reconciled onto the compiled-tools model:
  `computeClaudeBuiltinArgs` derives the effective allowed set from `compiledTools`
  (AGENT_TOOL / `compileAgent().tools`) when present, with `allowedBuiltinTools` as a
  legacy fallback — not a competing third permission model (`providers/claudecli.ts:184-213`,
  with the `[inv:no-third-tool-model]` note on the schema field, `validation/agent.ts:65-80`).

### Design-intent fidelity (what the structural audit can't catch)
- **AgentStore retired with NO competing source of truth** (Decision 1): retained as a
  thin compiled-agent cache; `systemPrompt` is the snapshot's compat shim populated
  from `compileAgent().content` at session start (`tools/session.ts:94-103`), never
  user-authored. Source of truth is the registry/compiler.
- **systemPrompt is a computed compat shim** (Decision 3): authoring `z.string()`
  removed; legacy flat agents still work because `resolveComposedPrompt` returns `null`
  when `compileAgentFn` throws and `agentTool` falls back to the stored prompt with
  `composed_prompt_id = NULL` (`prompt-resolver.ts:146-155`, `tools/session.ts:87-97`).
- **Session/cache topology matches the decision** (Decision 2): `composed_prompts`
  keyed by `(agent_slug, context_hash)` via a UNIQUE index; `sessions.composed_prompt_id`
  is the trace link. Proven behaviorally by the e2e join. PolicyEngine reads
  agent-policy `rate`/`permission` templates with the `PolicyConfig` defaults as
  fallback (`engine/policy.ts:76-107,135-199`).
- **Live server wiring ACTIVE** (Decision 5): `index.ts` reads `AGENT_MCP_REGISTRY_DB_PATH`,
  builds `PromptResolverDeps` wiring the REAL `compileAgent` from `@adhd/agent-compiler`
  (`index.ts:80-101`); `server.ts` forwards `promptResolver` to both `agentTool`
  callsites (`:499,:678`). Default (env absent) → `undefined` → legacy path unchanged.

---

## Observations (non-blocking)

- **OBS-1 (design note, not a defect):** `sessions.composed_prompt_id` is a nullable
  *soft* reference (no SQL `FOREIGN KEY` constraint) while `decisions.md` Decision 2 /
  DATA_MODEL.md use the word "foreign key". This is correct and forced by SQLite —
  `ALTER TABLE … ADD COLUMN` cannot attach a column-level FK to an existing table, and
  a nullable additive column is the backward-compatible choice for legacy sessions
  (`db/schema.ts:41-44`, `drizzle/0006_composed_prompts_cache.sql:24`). Referential
  integrity is proven behaviorally by the e2e join on it. No action required; "FK" in
  the decision text reads as the logical reference, not a hard constraint.

---

## Verdict

The behavioral DoD proofs drive REAL components against a REAL on-disk DB, mock only
the compiler boundary, are reopen-proven, exit-code-gated, and have independently
re-verified teeth (the production-mutate negative control goes RED and restores). The
audit ghost-pass hardening is present and load-bearing. All 6 DoD clauses are backed,
the live server resolves via the compiler with a flat-`systemPrompt` compat fallback,
the full suite (252) is green, the build is clean, and the back-out tag gives a clean
revert. No competing source of truth, no third tool-permission model, topology matches
the recorded decisions. No blocking findings.

VERDICT: APPROVED
