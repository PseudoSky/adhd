# platform-markdown-emit — compileAgent: FULL PLATFORM ARTIFACT

**Phase:** emit · **Kind:** work · **Depends on:** code-review-engine · **Guard:** `npx --yes nx test agent-compiler --testFile=packages/ai/agent-compiler/src/__tests__/compile-agent.test.ts`

---

## Goal

The public `compileAgent({agentSlug, platform, context, db})` exists and produces a
REAL platform artifact from the resolved layers: for `claude_code` it emits
markdown with a `---` YAML frontmatter block (`name`, `description`, `tools:`
resolved aliases, `model:` resolved alias) followed by the junction-ordered body
with the policy constraint block; for `claude_api` it emits a `json_object`
(`systemPrompt` + structured `tools` array). This is the convergence point — the
state that makes the headline "compiler emits real platform output from real rows"
true. It assembles `[def:composed-output]`.

---

## Semantic Distillation

- **Primitive:** ADD `emit/markdown.ts` (`yaml_frontmatter`), `emit/json.ts`
  (`json_object`), and `compile.ts` exporting `compileAgent`.
- **Reference Pattern:** `[ref:compile-agent]`, `[def:compile-input]`,
  `[def:header-format]`, `[def:composed-output]`,
  `[inv:platform-shaped-observable]`, `[inv:one-db-handle]`.
- **Delta Spec:**
  - `compileAgent` orchestrates: `resolveBody` (composition) + `resolveTools` +
    `resolveModel` + `resolvePolicyConstraints`, then dispatches on the platform's
    `header_format` (`SEED_DATA.md` §5) to `emit/markdown.ts` or `emit/json.ts`.
  - `emit/markdown.ts`: render `---\n name: …\n tools: <aliases>\n model: <alias>\n---\n`
    then the body. `emit/json.ts`: `JSON.stringify({ systemPrompt, tools, model })`.
  - returns `{ id?, content, tools, componentVersions }` (the `id` is null until
    `composed-prompt-caching` wires the cache write).
  - Test (`compile-agent.test.ts`): seed a real agent (components + tools + model +
    policy); `compileAgent(...,'claude_code')` → assert the output STARTS with `---`,
    its `tools:` line equals the resolved aliases, the body sections are in junction
    order, and the policy constraint text is present; `(...,'claude_api')` → assert
    `JSON.parse` yields `{systemPrompt, tools}` with the structured tools array.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [platform-markdown-emit.1] compileAgent entrypoint exported

- [platform-markdown-emit.2] markdown emitter writes YAML frontmatter
- [platform-markdown-emit.3] compileAgent emits real markdown+json from rows
---

## Reservations

```text
read_only:  ["packages/ai/agent-compiler/src/resolve/composition.ts", "packages/ai/agent-compiler/src/resolve/tools.ts", "packages/ai/agent-compiler/src/resolve/model.ts", "packages/ai/agent-compiler/src/resolve/policy.ts"]
mutates:    ["packages/ai/agent-compiler/src/emit/markdown.ts", "packages/ai/agent-compiler/src/emit/json.ts", "packages/ai/agent-compiler/src/compile.ts", "packages/ai/agent-compiler/src/index.ts", "packages/ai/agent-compiler/src/__tests__/compile-agent.test.ts"]
```

---

## Commit points

- `feat(agent-compiler): compileAgent emits yaml_frontmatter + json_object output`

## Notes for executor

- This state delivers `[dod.1]`/`[dod.2]`/`[dod.3]` jointly with the resolve layers
  and `compile-fixtures-e2e`; the e2e test drives the seeded fixtures, this test
  is the focused unit-of-emit. Both must assert the platform-shaped observable, not
  "an emit function exists" (`[inv:platform-shaped-observable]`).
- `emit/json.ts` MUST exist as a separate `json_object` emitter so `[dod.7]`'s grep
  for both formats passes.
