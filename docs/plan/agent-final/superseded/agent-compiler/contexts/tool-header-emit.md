# tool-header-emit — RESOLVE THE PLATFORM tools: HEADER

**Phase:** resolve · **Kind:** work · **Depends on:** composition-resolve · **Guard:** `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/tool-header.test.ts`

---

## Goal

The compiler turns an agent's `agent_tools` grants into the target platform's
`tools:` declaration by joining `tool_platform_bindings`. On `claude_code` a grant
of `shell_exec` becomes `Bash`; on `claude_api` it becomes `bash` (structured).
This is the platform-resolved set asserted by the headline `[dod.1]`.

---

## Semantic Distillation

- **Primitive:** ADD `resolve/tools.ts` exporting `resolveTools(db, agentSlug,
  platform) → ResolvedTool[]` (canonical → platform alias + availability).
- **Reference Pattern:** `[up:tools]`, `[ref:store-read]`, `[def:tools-header]`,
  `[inv:platform-shaped-observable]`.
- **Delta Spec:**
  - read the agent's `tool_*` `agent_tools` grants; for each, join
    `tool_platform_bindings` for the target platform to get the platform alias and
    `availability`; drop `unavailable` bindings (e.g. `human_input` on `claude_api`).
  - return the ordered, de-duplicated alias list; the markdown emitter renders it
    as `tools: Read, Grep, Glob, WebSearch`, the JSON emitter as a structured
    array (`provider_tool_formats` shaping is `model-and-policy-emit`/`json` work).
  - Test (`tool-header.test.ts`): seed an agent with grants
    (`file_read`,`file_grep`,`web_search`); assert `resolveTools(...,'claude_code')`
    returns `['Read','Grep','WebSearch']` and `(...,'claude_api')` returns the
    `claude_api` aliases, NOT canonical names.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [tool-header-emit.1] joins tool_platform_bindings to build platform tools header

- [tool-header-emit.2] resolved tools header test passes
---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/resolve/composition.ts"]
mutates:    ["packages/ai/agent-compiler/src/resolve/tools.ts", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/__tests__/tool-header.test.ts"]
```

---

## Commit points

- `feat(agent-compiler): resolve platform tools header from tool_platform_bindings`

## Notes for executor

- The `[dod.1]` negative-control "ignore platform, emit canonical names" bites
  here — `resolveTools` MUST be platform-keyed (the join's `WHERE platform = ?`).
- Seed `tool_*` rows via `agent-tool-registry`'s seed/store API
  (`[inv:real-rows-not-mocks]`).
