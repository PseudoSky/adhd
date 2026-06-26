# agent-define — transactional declarative composition upsert

**Phase:** authoring · **Kind:** work · **Depends on:** component-define · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/agent-define.test.ts`

---

## Goal

An agent can compose a NEW agent from registry components in ONE declarative
upsert. `agent_define({name, model, components[], tools?, policy?})`
(`tools/authoring.ts` + a `registry/composition-writer.ts`) is a single
transactional upsert across the registry agent + composition + tool-grant +
policy-attach stores (D4, SPEC §5.2). It is **create-or-replace** — a full replace
of `components`/`tools`/`policy`, not a merge — version-bumped only when the
resolved composition changes (content-hash compare), and idempotent
(`changed:false`) on no-change. It returns a `compiled_preview` (each component's
content in `position` order) plus a `composed_prompt_id` via Plan 6's
`compileAgent` + `composed_prompts` cache, and busts that cache when the
composition changes. Referenced names are resolved through the discovery stores
before commit, raising typed `COMPONENT_NOT_FOUND` / `TOOL_NOT_FOUND` /
`POLICY_NOT_FOUND` / `MODEL_NOT_FOUND`. Grants and binds are declarative
by-reference inside the spec — there is no standalone `tool_grant`/`model_bind`/
`policy_attach` verb. The write fully commits or rolls back; a partial compose
never leaves the registry inconsistent.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [agent-define.1] agent_define declarative upsert: full-replace, version-bump-on-change, idempotent, compiled_preview+composed_prompt_id, typed *_NOT_FOUND errors

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/tools/authoring.ts", "packages/ai/agent-mcp/src/registry/composition-writer.ts", "packages/ai/agent-mcp/src/server.ts", "packages/ai/agent-mcp/src/__tests__/agent-define.test.ts"]
```

---

## Notes for executor

- **Depends on Plan 6 being BUILT.** `compileAgent`, the `composed_prompts` cache,
  and the `(agent, context_hash)` keying are Plan-6 (`agent-mcp-refactor`)
  deliverables consumed here — `assumed_baseline`. The `compiled_preview` /
  `composed_prompt_id` path can't go green until Plan 6's packages are built and
  its tsconfig paths resolve. If a Plan-6 detail is missing, record the assumption
  and escalate (planner amendment) — do not invent registry internals.
- **Transaction must be atomic.** Resolve every referenced name (component, tool,
  policy, model) to a typed `*_NOT_FOUND` BEFORE the transaction commits; the
  store writes either all commit or all roll back. Prove the rollback: a spec with
  one bad reference must leave the registry byte-identical to before the call.
- **Full-replace, not merge.** The supplied `components`/`tools`/`policy` IS the
  desired state — dropping a component from the spec removes it from the agent.
  Version bumps only on a changed *resolved* composition (content hash), and an
  identical re-define must report `changed:false` with no bump. The negative
  control removes the content-hash compare → identical re-define reports
  `changed:true` → assertion fails.
- **No standalone grant/bind/attach verbs** (`inv:declarative-upsert`, Decision C):
  privilege grants live inside the reviewed agent definition by reference only.
- Route names through the `registry-bridge`; the response is `name`-keyed and
  slug-free (dod.4).
