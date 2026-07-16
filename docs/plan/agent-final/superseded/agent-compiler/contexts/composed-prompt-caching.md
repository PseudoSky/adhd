# composed-prompt-caching — WRITE + HIT THE composed_prompts CACHE

**Phase:** cache · **Kind:** work · **Depends on:** platform-markdown-emit · **Guard:** `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-cache.test.ts`

---

## Goal

`compileAgent` WRITES a `composed_prompts` row (`agent_slug`, `context_hash`,
`content`, `component_versions`) on first compile, and a re-compile of the same
agent+context is served from that persisted row — proven by CLOSING and REOPENING
the DB before the second compile. This delivers the `[def:composed-output].id`
audit handle and the round-trip/caching `[dod.4]`. Mirrors `DATA_MODEL.md`
Domain 1 "Composed Prompts" + `GOAL.md` "Audit Trail".

---

## Semantic Distillation

- **Primitive:** ADD `cache/composed-prompt-cache.ts` (`lookup` + `write`) and wire
  it into `compile.ts`.
- **Reference Pattern:** `[def:context-hash]`, `[inv:reopen-proves-cache]`,
  `[up:registry]` (the `composed_prompts` / `registry_*` table from plan 1),
  `[inv:platform-shaped-observable]`.
- **Delta Spec:**
  - `context_hash` = canonical sorted-key hash over `(context, componentVersions)`
    per `decisions.md` (`[def:context-hash]`).
  - `compileAgent` flow: compute the hash → `SELECT` a matching `composed_prompts`
    row → on HIT, return its `{id, content}` WITHOUT re-running the resolve layers;
    on MISS, assemble, `INSERT` the row, return `{id, content}`.
  - Test (`compile-cache.test.ts`): seed an agent; first `compileAgent` writes the
    row; CLOSE the better-sqlite3 handle and REOPEN from the same file path; second
    `compileAgent` of the same agent+context returns the SAME `id` and the row
    count stays at 1 (and a resolver spy/counter shows assembly did NOT re-run).
    A DIFFERENT context produces a new row.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [composed-prompt-caching.1] writes composed_prompts row keyed by context hash

- [composed-prompt-caching.2] recompile hits cache; persistence proven by reopen
---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/emit/markdown.ts"]
mutates:    ["packages/ai/agent-compiler/src/cache/composed-prompt-cache.ts", "packages/ai/agent-compiler/src/compile.ts", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/__tests__/compile-cache.test.ts"]
```

---

## Commit points

- `feat(agent-compiler): write + hit composed_prompts cache (reopen-proven)`

## Notes for executor

- The `[dod.4]` negative-control "skip the SELECT, always INSERT" bites here —
  the lookup MUST run before assembly so removing it creates a duplicate row.
- Prove persistence by REOPEN, never by in-memory state (`[inv:reopen-proves-cache]`,
  CLAUDE.md verification standard #3).
- `compile.ts` is shared with `platform-markdown-emit`/`compile-cli`; this state
  appends the cache wiring — do not rewrite the emitter dispatch.
