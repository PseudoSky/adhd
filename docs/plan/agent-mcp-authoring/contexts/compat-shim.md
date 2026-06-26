# compat-shim — flat systemPrompt as a deprecated permanent inline-component shim

**Phase:** compat · **Kind:** work · **Depends on:** agent-define · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/systemprompt-compat.test.ts`

---

## Goal

The flat `systemPrompt` authoring path survives as a deprecated, permanent compat
shim with no behavioral regression (SPEC §9). `agent_create({name, provider,
systemPrompt})` wraps the flat prompt as one private inline component
(`<name>-inline-<n>`) and composes it, running identically to 1.0.1
(`tools/agent-crud.ts`). `systemPrompt` and a `components` list are mutually
exclusive → `VALIDATION_ERROR` (`validation/agent.ts`). The `guide` text
(`tools/guide.ts`) marks `systemPrompt` as deprecated/optional and renders the new
authoring section. Crucially, the 11-tool runtime delegation surface is unchanged:
`agent({name})` still equals `agent({name, platform:'claude_code', context:{}})`
with required-arg count 1, and a delegated sub-agent sees exactly the 11 runtime
tools — 0 authoring/discovery tools (`inv:11-tool-hot-path`). All three touched
files (`agent-crud.ts`, `validation/agent.ts`, `guide.ts`) are inside the D3
modification manifest.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [compat-shim.1] agent_create({systemPrompt}) wraps inline component identically to 1.0.1; systemPrompt+components=VALIDATION_ERROR; 11-tool runtime delegation surface unchanged

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/tools/agent-crud.ts", "packages/ai/agent-mcp/src/validation/agent.ts", "packages/ai/agent-mcp/src/tools/guide.ts", "packages/ai/agent-mcp/src/__tests__/systemprompt-compat.test.ts"]
```

---

## Notes for executor

- **Do NOT change the 11-tool runtime delegation surface.** This is the highest
  footgun in the plan: the shim makes the *authoring* path richer, but a sub-agent
  delegated a task must still see exactly the 11 runtime tools and 0
  authoring/discovery tools. The negative control counts the delegation surface and
  fails if any `*_define`/`*_list`/`*_search` tool leaks in.
- **Behavior must be byte-for-byte identical to 1.0.1** for the `systemPrompt`
  path — wrapping it as one inline component is an internal representation change,
  not a behavioral one. Prove `agent_create({systemPrompt})` then `agent`/`task`
  yields the same run as today.
- **Only the three manifest files may change here** (`agent-crud.ts`,
  `validation/agent.ts`, `guide.ts`) — touching any other agent-mcp src file trips
  `check_manifest.py` (dod.8). The full pre-existing agent-mcp suite stays green
  (`nx test agent-mcp`).
- `agent({name})` invariant: do not add a required arg to session start;
  `platform`/`context` stay optional with safe defaults.
- The mutual-exclusion check is `VALIDATION_ERROR` at create time; the
  no-components / no-systemPrompt case surfaces `COMPILE_NO_COMPONENTS` later at
  session start (`agent`), per SPEC §9 — don't conflate the two.
