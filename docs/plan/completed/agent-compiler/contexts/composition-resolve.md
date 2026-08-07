# composition-resolve — ASSEMBLE BODY IN JUNCTION ORDER

**Phase:** resolve · **Kind:** work · **Depends on:** scaffold-package · **Guard:** `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/composition-resolve.test.ts`

---

## Goal

The compiler turns an agent + context into a FLAT BODY: it calls
`agent-registry`'s `resolveComposition(agentSlug, context)`, takes the ordered,
version-pinned, context-filtered component list it returns, and concatenates the
component `content` in ascending junction `position` order into the prompt body.
This is the spine of `[dod.1]` (body in junction order) and `[dod.2]`
(context-conditional inclusion).

---

## Semantic Distillation

- **Primitive:** ADD `resolve/composition.ts` exporting `resolveBody(db,
  agentSlug, context) → { body, componentVersions }`.
- **Reference Pattern:** `[up:registry]`, `[ref:store-read]`, `[def:junction-order]`,
  `[inv:context-precedence-consumed]`, `[inv:platform-shaped-observable]`.
- **Delta Spec:**
  - DELEGATE ordering + version-pin + context filtering to `resolveComposition` —
    do NOT re-implement `ORDER BY position` or the context evaluator here
    (`[inv:context-precedence-consumed]`).
  - Join each returned component to its `content` at the resolved version; emit the
    sections in the order returned (which is `position` order); collect the
    `componentVersions` map for the cache key.
  - The ACTUAL platform header (frontmatter / JSON) is NOT this state's job — here
    you return a flat, ordered body string + the version map.
  - Test (`composition-resolve.test.ts`): seed an agent with ≥3 components at
    distinct positions (one context-conditioned); assert `resolveBody` returns the
    component texts concatenated in `position` order, and that a
    context-conditioned component is included/excluded per the supplied context.

---

## Acceptance criteria

- [composition-resolve.1] assembles body from resolveComposition in junction order
- [composition-resolve.2] body-ordering test passes
---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/db/client.ts"]
mutates:    ["packages/ai/agent-compiler/src/resolve/composition.ts", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/__tests__/composition-resolve.test.ts"]
```

---

## Commit points

- `feat(agent-compiler): resolveBody assembles components in junction order`

## Notes for executor

- The negative-control for `[dod.1]`/`[dod.2]` bites HERE — keep ordering +
  context filtering as the single delegated call so removing it turns the e2e test
  red. Do not duplicate the filter.
- Seed rows via the `agent-registry` store APIs (or direct inserts into
  `registry_*`) — `[inv:real-rows-not-mocks]`.
