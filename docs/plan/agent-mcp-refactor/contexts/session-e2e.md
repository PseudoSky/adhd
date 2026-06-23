# session-e2e — real session start proves systemPrompt from compiler + cache reuse

**Phase:** e2e · **Kind:** work · **Depends on:** audit-integration · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/session-compiler-e2e.test.ts`

See `contexts/_shared.md` for definitions and invariants.

---

## Goal

The consumer-visible outcome is proven through the REAL agent-mcp session-start
path. After this state: a real session started against an agent resolves its
system prompt from `compileAgent` output (deep-equal), a second session for the
same agent + context reuses the cached `composed_prompts` row (no recompile,
proven by reopen), and the full agent-mcp unit suite is still green.

## Semantic Distillation

- **Primitive:** ADD two e2e tests that DRIVE the real path
  (`[inv:real-session-start]`); the production code is `read_only` here.
- **Delta spec** (proves `[dod.1]`, `[dod.2]`, `[dod.3]`):
  - `session-compiler-e2e.test.ts` ("session systemPrompt equals compileAgent
    output"): real on-disk SQLite + migrations; wire the REAL SessionStore +
    prompt-resolver + ComposedPromptStore; start a session via the `agent` tool
    with ONLY the LLM provider mocked; `expect` the resolved system prompt
    deep-equals `compileAgent({agentSlug,platform,context}).content` and
    `sessions.composed_prompt_id` is non-null.
  - `cache-reuse.test.ts` ("second session reuses cached composed_prompt without
    recompile"): count `compileAgent` invocations across two session starts for
    the same agent + context — assert exactly 1; REOPEN the DB and assert both
    sessions' `composed_prompt_id` reference the same row (`[inv:reopen-proves-cache]`).
  - Negative control (`session-e2e.3`): perturb `prompt-resolver`'s `compileAgent`
    call → the e2e deep-equal flips RED; restore via `git checkout`.
  - Non-regression (`session-e2e.4`): `npx --yes nx test agent-mcp` (full suite)
    exits 0.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [session-e2e.1] e2e: real session start resolves systemPrompt == compileAgent(...) output (real DB, LLM boundary mocked)

- [session-e2e.2] cache: second session with same agent+context reuses composed_prompt (no recompile; proven by reopen)
- [session-e2e.3] negative-control: breaking the compiler call in prompt-resolver turns the e2e clause RED
- [session-e2e.4] non-regression: full agent-mcp unit suite still passes after the refactor
---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/engine/prompt-resolver.ts", "packages/ai/agent-mcp/src/store/composed-prompt-store.ts", "packages/ai/agent-mcp/src/store/session-store.ts", "packages/ai/agent-mcp/src/tools/session.ts", "packages/ai/agent-mcp/src/db/schema.ts"]
mutates:    ["packages/ai/agent-mcp/src/__tests__/session-compiler-e2e.test.ts", "packages/ai/agent-mcp/src/__tests__/cache-reuse.test.ts"]
```

---

## Commit points

- `test(agent-mcp): e2e session-start resolves systemPrompt from compiler + composed_prompt cache reuse`

## Notes for executor

- Mock ONLY the LLM provider boundary. The resolver, stores, DB, and `agent` tool
  MUST be the real ones (`[inv:real-session-start]`) — a mocked resolver proves
  nothing.
- Prove the cache hit by COUNTING `compileAgent` invocations (a spy on the real
  resolver's dependency) AND by reopening the DB — not by reading in-memory state
  (`[inv:reopen-proves-cache]`).
- Before declaring green, run the negative control: break the `compileAgent` call
  in `prompt-resolver.ts`, confirm `session-compiler-e2e.test.ts` goes RED, then
  `git checkout --` to restore. A test that stays green when broken proves nothing
  (CLAUDE.md verification #2).
- Optionally add a live model gate (`AGENT_MCP_LIVE=1`) per CLAUDE.md verification
  #5 asserting model-independent invariants; keep CI offline by default.
- Gate on EXIT CODE (`[inv:exit-code-gate]`) — better-sqlite3 can segfault on
  teardown; a teardown crash must fail the gate.
