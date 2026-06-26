# component-define — content-only upsert that enriches on write

**Phase:** authoring · **Kind:** work · **Depends on:** discovery-tools · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/component-define.test.ts`

---

## Goal

An agent can author a component over MCP with content only. The `component_define`
authoring tool (`tools/authoring.ts`, registered in `server.ts`) takes
`{name, type, content, shared?}` — content-bearing fields only — and runs the
`enrichComponent` pipeline on write, so the response carries an auto-derived
`summary` and weighted `use_cases` the agent never supplied (SPEC §5.3). It is a
name-keyed create-or-replace upsert (`inv:declarative-upsert`): a new name creates,
an existing name replaces, the `version` bumps only when the content actually
changes (content-hash compare), and re-defining byte-identical content is an
idempotent no-op (`changed:false`) that does NOT churn the index. A `type` not in
`prompt_types_list` raises `INVALID_TYPE`. The agent writes content and gets
discovery for free — no hand-assigned weights, use-cases, or summary.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [component-define.1] component_define name-keyed upsert runs enrichment on write, version-bumps on content change, idempotent on identical content

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/tools/authoring.ts", "packages/ai/agent-mcp/src/server.ts", "packages/ai/agent-mcp/src/__tests__/component-define.test.ts"]
```

---

## Notes for executor

- **This is a thin wrapper, not new enrichment logic.** The embed → links →
  summary work belongs to `enrichComponent` in `@adhd/agent-registry`
  (`inv:additive-registry`). This tool only validates input, calls the bridge +
  pipeline, and shapes the `name`-keyed response. Do not re-implement enrichment
  in agent-mcp.
- **Idempotence has teeth here too.** The proof must show a second identical
  `component_define` returns `changed:false` with no version bump AND no index
  churn (the enrichment is deterministic upstream). The negative control: stub the
  enrichment to skip embedding → `use_cases` comes back empty → the dod.1
  assertion fails.
- **Version-bump only on content change**, decided by content hash — not on every
  call, not on a `shared` flag flip alone unless that changes the resolved content.
- **Route name→slug through the `registry-bridge`** and strip slug outbound; the
  response must be slug-free (dod.4). `INVALID_TYPE` must validate `type` against
  the live `prompt_types` rows, not a hardcoded enum (`inv:lookup-not-enum`).
- Editing a `shared:true` component recompiles every consumer — note this in the
  tool's behavior, but the blast-radius check itself is `component_consumers`
  (discovery lane), not this tool's job.
