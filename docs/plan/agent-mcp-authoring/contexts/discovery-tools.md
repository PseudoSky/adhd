# discovery-tools — the 11 read tools over the real registry/provider/policy stores

**Phase:** discovery · **Kind:** work · **Depends on:** name-slug-seam · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/discovery-tools.test.ts`

---

## Goal

A composing agent can now read the full registry vocabulary over MCP. The 11
discovery (read) tools from SPEC §6 are registered and serve real data over the
actual registry/tool/provider/policy stores via the `registry-bridge`:
`component_search` (semantic), `component_read`, `component_consumers`,
`prompt_types_list`, `tool_list`, `model_list`, `policy_list`, `usecase_list`,
`agent_read`, `agent_list`, and `agent_compile`. `component_search` resolves
`query → use-cases → components` through the enrichment embedding and returns
cheap, auto-ranked summaries (not full bodies) — a query semantically matching a
seeded component ranks it above an unrelated one. Every result is `name`-keyed
with no `slug` on the wire. Critically, all 11 land OUTSIDE the runtime delegation
surface (`inv:11-tool-hot-path`): a delegated sub-agent still sees exactly the 11
runtime tools and 0 discovery tools. Before this state the registry was reachable
only via the `agent-registry compile` CLI and direct store imports — invisible to
an agent over MCP.

**Every list/search tool is bounded by default (BUG-003).** `agent_list`,
`component_search`, and every `*_list` tool (`tool_list`, `model_list`,
`policy_list`, `usecase_list`, `prompt_types_list`) MUST apply a **default result
limit** and return a **summary projection** — name + type + one-line summary +
score, NEVER the full `systemPrompt`/body inline. The full body is returned ONLY by
an explicit single-item read (`agent_read`/`component_read`) or an explicit
`full:true`/over-limit opt-in. This is a real host constraint, not a nicety: against
the live 46-agent store, an unbounded `agent_list` returned 464,821 chars / 692
lines and **blew the host's tool-output token ceiling** (`packages/ai/agent-mcp/BACKLOG.md`
BUG-003), making the whole discovery lane unusable. A bounded default keeps every
discovery call cheap and within budget regardless of corpus size.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [discovery-tools.1] all 11 discovery tools return name-keyed results over the real registry stores

- [discovery-tools.2] agent_list/component_search/*_list are bounded by default: a store seeded N>>limit (e.g. 60) returns <=limit summary-projected items with NO full systemPrompt/body inline and total output under a KB-scale ceiling; full body only via agent_read/component_read/full:true (BUG-003)
---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/tools/discovery.ts", "packages/ai/agent-mcp/src/server.ts", "packages/ai/agent-mcp/src/__tests__/discovery-tools.test.ts", "packages/ai/agent-mcp/src/__tests__/discovery-bounded-output.test.ts"]
```

---

## Notes for executor

- **Registration must not contaminate the delegation surface.** `server.ts`
  registers these as available tools, but the set a delegated sub-agent sees stays
  exactly the 11 runtime tools. Confirm the delegation-surface list is built from
  the runtime lane only — a discovery tool leaking into delegation is the
  `inv:11-tool-hot-path` violation `compat-shim`'s test also guards.
- **Route everything through the `registry-bridge`, not the stores directly**, so
  `name↔slug` translation and the outbound slug-strip happen for free. A tool that
  imports a store and returns a raw row will leak a `slug` and fail the dod.4 scan.
- **`component_search` is semantic, not substring.** It must embed the query and
  rank via cosine against use-case anchors → components (the same embedding that
  filed each component), returning summaries + scores. A negative control that
  swaps the ranker for insertion-order must flip the "match ranks above unrelated"
  assertion red.
- **`agent_compile` consumes Plan 6** (`compileAgent` + the `composed_prompts`
  cache); it reports `cache: HIT|MISS`. Those Plan-6 deliverables are
  `assumed_baseline` and must be built before this state goes green.
- **Read-only:** none of these tools mutate the registry. Keep them side-effect
  free so they are safe and cheap to call per slot.
- **Bounded output is a hard requirement (BUG-003, `discovery-tools.2`).** Give every
  list/search tool a `limit` (sane default, e.g. 20) and a summary projection;
  `agent_list`/`*_list` must NEVER inline a full `systemPrompt`/body. Prove it in a
  dedicated `discovery-bounded-output.test.ts` that **seeds N ≫ limit** agents (e.g.
  60) and asserts: (a) the default response returns ≤ limit items, (b) it carries NO
  full `systemPrompt`/body field (only summary projection), (c) total serialized
  output stays under a bounded ceiling (a few KB, not hundreds of KB), and (d)
  `full:true`/`agent_read` is the ONLY way to get a full body. Negative control:
  remove the limit/projection and the size-ceiling assertion goes red (reproducing
  the 464,821-char blowout). Drive the REAL tools over the bridge + real store — no
  mocks.
