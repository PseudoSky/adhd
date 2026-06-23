# enforcement-plugin — AGENT-MCP PLUGIN THAT ENFORCES A RATE POLICY (THROWS)

**Phase:** enforcement · **Kind:** work · **Depends on:** policy-inheritance · **Guard:** `npx --yes nx test agent-policy --testFile=packages/ai/agent-policy/src/__tests__/enforcement-plugin.test.ts`

---

## Goal

`@adhd/agent-policy` exports an agent-mcp plugin (mirroring `@adhd/agent-mcp-budget`)
that, given a `rate` policy, registers an enforcement handler via
`hooks.registerEnforcement("pre:model_request", ...)` which THROWS an
`IEnforcementError` when the limit is crossed. A test drives this through the REAL
`HookRegistry` from `@adhd/agent-mcp-types` and asserts the throw propagates —
proving GOAL.md "Variable Policy Enforcement" reuses the existing plugin contract,
not a reimplementation.

---

## Semantic Distillation

- **Primitive:** ADD `src/plugin/{index,rate-policy}.ts` + `enforcement-plugin.test.ts`.
  See `[def:enforcement-plugin]`, `[ref:budget-plugin]`, `[ref:hook-registry]`,
  `[inv:enforcement-throws-propagate]`, `[inv:real-registry-not-mock]`,
  `[inv:enforcement-event-pre-model-only]`.
- **Delta Spec** (mirror `packages/ai/agent-mcp-budget/src/index.ts`):
  - `src/plugin/index.ts`:
    - `export const configSchema = z.object({ ... })` — the `rate` policy limit(s),
      e.g. `maxModelCalls: z.number().int().positive().optional()` (read from the
      template `rules` / per-agent `override_config` per the merge rule in
      `decisions.md`).
    - a `Plugin` class with `install(hooks: IHookRegistry)` that registers
      observational `register("task:start"|"post:model_response"|"task:completed", ...)`
      handlers (try/caught) to accumulate per-task model-call counts, AND one
      `hooks.registerEnforcement("pre:model_request", p => this.enforce(p))` with
      NO try/catch — so the throw propagates.
    - `this.enforce(p)` throws `{ isEnforcementError: true, code:
      "POLICY_VIOLATION", message }` when the accumulated count ≥ the configured
      limit.
    - `const createPlugin: PluginFactory = ({ db, config }) => new Plugin(db,
      config as ...)`; `export default createPlugin; export { createPlugin };`
  - `src/plugin/rate-policy.ts` — the pure limit-evaluation helper (effective limit
    from template `rules` + `override_config`; the throw decision), unit-testable
    apart from the hook wiring.
  - Test (`enforcement-plugin.test.ts`), named case `"rate policy throws through
    real IHookRegistry.enforce(pre:model_request) when the limit is crossed"`:
    1. `import { HookRegistry } from "@adhd/agent-mcp-types"` — the REAL registry;
    2. `const hooks = new HookRegistry(); createPlugin({ db: null, config: {
       maxModelCalls: 2 } }).install(hooks);`
    3. emit `task:start` then enough `post:model_response` turns to reach the
       limit (use real payload shapes);
    4. assert `await hooks.enforce("pre:model_request", payload)` REJECTS with an
       error whose `isEnforcementError === true`; assert the call UNDER the limit
       resolves without throwing.

---

## Acceptance criteria

- [enforcement-plugin.1] plugin exports configSchema (zod)
- [enforcement-plugin.2] plugin exports createPlugin + registers via hooks.registerEnforcement(pre:model_request)
- [enforcement-plugin.3] enforcement test: rate policy throws through real IHookRegistry.enforce(pre:model_request)
- [enforcement-plugin.4] enforcement test has teeth: removing the throw lets the over-limit call pass and fails the test

---

## Reservations

```text
read_only:  ["packages/ai/agent-policy/src/store/policy-template-store.ts", "packages/ai/agent-policy/src/store/agent-policy-store.ts"]
mutates:    ["packages/ai/agent-policy/src/plugin/index.ts", "packages/ai/agent-policy/src/plugin/rate-policy.ts", "packages/ai/agent-policy/src/index.ts", "packages/ai/agent-policy/src/__tests__/enforcement-plugin.test.ts"]
```

---

## Commit points

- `feat(agent-policy): rate-policy enforcement plugin on the agent-mcp hook contract`

## Notes for executor

- DO NOT reinvent the hook system. Reuse `IHookRegistry` / `HookRegistry` /
  `PluginFactory` from `@adhd/agent-mcp-types` (`[ref:budget-plugin]`,
  `[ref:hook-registry]`). The test instantiates the REAL `HookRegistry`, not a mock
  (`[inv:real-registry-not-mock]`) — a mock could fake a throw the real registry
  wouldn't propagate.
- **`EnforcementEvent` is `"pre:model_request"`-ONLY** (`[inv:enforcement-event-pre-model-only]`).
  This plugin can only enforce there — i.e. a `rate` policy on model-call budget. A
  policy needing `pre:tool_call`/`post:tool_call` enforcement is OUT OF SCOPE per
  README "Non-goals" and `decisions.md`; do not silently downgrade it to an
  observational hook without recording it.
- The enforcement handler MUST throw WITHOUT a try/catch wrapper — observational
  `register()` handlers swallow, `registerEnforcement()` handlers propagate
  (`[inv:enforcement-throws-propagate]`).
- `[enforcement-plugin.4]` is a NEGATIVE CONTROL: the audit runs
  `scripts/nc_break_enforcement.mjs` to replace the `throw` with a no-op `return`,
  confirms the over-limit `enforce(...)` no longer rejects so the test goes RED,
  then `scripts/nc_restore_enforcement.mjs` restores. Author both scripts.
- Proves `[dod.2]` and `[dod.5]` (configSchema + createPlugin contract).
