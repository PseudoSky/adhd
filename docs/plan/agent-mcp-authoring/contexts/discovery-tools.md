# discovery-tools — the 11 read tools over the real registry/provider/policy stores

**Phase:** discovery · **Kind:** work · **Depends on:** name-slug-seam · **Guard:** `npx --yes nx test agent-mcp --testFile=entrypoint/agent-mcp/src/__tests__/discovery-tools.test.ts`

---

## Goal

A composing agent can now read the full registry vocabulary over MCP. The 11
discovery (read) tools from SPEC §6 are registered and serve real data over the
actual registry/tool/provider/policy stores via the `registry-bridge`:
`component_search` (hybrid FTS5+vector), `component_read`, `component_consumers`,
`prompt_types_list`, `tool_list`, `model_list`, `policy_list`, `usecase_list`,
`agent_read`, `agent_list`, and `agent_compile`. `component_search` runs **real
hybrid retrieval** (D6): an FTS5 keyword `textScore` (BM25 `MATCH` over component
content) **fused** with a vector `vecScore` (`@adhd/sox-vector-store` `knn` over the
enrichment embedding) via `@adhd/sox-hybrid-search`'s pure `normalize()` + `fuse()`,
returning cheap, auto-ranked summaries (not full bodies). The quality bar is a
**golden-set nDCG@5 ≥ 0.70 over a corpus salted with hard negatives** (the BEST
component ranks at/near position 1) — NOT the old 1-vs-1 "a match beats one unrelated
item" sanity check. Every result is `name`-keyed
with no `slug` on the wire. Critically, all 11 land OUTSIDE the runtime delegation
surface (`inv:11-tool-hot-path`): a delegated sub-agent still sees exactly the 11
runtime tools and 0 discovery tools. Before this state the registry was reachable
only via the `agent-store-prompts compile` CLI and direct store imports — invisible to
an agent over MCP.

**Every list/search tool is bounded by default (BUG-003).** `agent_list`,
`component_search`, and every `*_list` tool (`tool_list`, `model_list`,
`policy_list`, `usecase_list`, `prompt_types_list`) MUST apply a **default result
limit** and return a **summary projection** — name + type + one-line summary +
score, NEVER the full `systemPrompt`/body inline. The full body is returned ONLY by
an explicit single-item read (`agent_read`/`component_read`) or an explicit
`full:true`/over-limit opt-in. This is a real host constraint, not a nicety: against
the live 46-agent store, an unbounded `agent_list` returned 464,821 chars / 692
lines and **blew the host's tool-output token ceiling** (`entrypoint/agent-mcp/BACKLOG.md`
BUG-003), making the whole discovery lane unusable. A bounded default keeps every
discovery call cheap and within budget regardless of corpus size.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [discovery-tools.1] all 11 discovery tools return name-keyed results over the real registry stores

- [discovery-tools.2] agent_list/component_search/*_list are bounded by default: a store seeded N>>limit (e.g. 60) returns <=limit summary-projected items with NO full systemPrompt/body inline and total output under a KB-scale ceiling; full body only via agent_read/component_read/full:true (BUG-003)

- [discovery-tools.3] component_search retrieval QUALITY is proven by a golden-set nDCG@5>=0.70 over a corpus salted with hard negatives (distractors sharing query vocabulary but not the answer): ~15-30 graded-relevance tasks over an N>>k component corpus (reuse the >=60-item corpus from discovery-tools.2 where practical); the hybrid FTS5+vector ranker (fuse() of textScore+vecScore) scores nDCG@5>=0.70 (MRR reported alongside); NEGATIVE CONTROL WITH TEETH — reverting to a shuffled/insertion-order ranker drops nDCG below the floor and FAILS the test (proving a green nDCG means the BEST components are returned, not merely match>noise). Golden set + corpus are a fixture this state produces.
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/agent-mcp/src/tools/discovery.ts", "entrypoint/agent-mcp/src/server.ts", "entrypoint/agent-mcp/src/__tests__/discovery-tools.test.ts", "entrypoint/agent-mcp/src/__tests__/discovery-bounded-output.test.ts", "entrypoint/agent-mcp/src/__tests__/component-search-ndcg.test.ts", "entrypoint/agent-mcp/src/__tests__/fixtures/component-search-golden.json"]
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
- **`component_search` is HYBRID (FTS5 keyword + vector), not substring, not
  vector-only.** It must compute BOTH channels and fuse them: (1) `textScore` — a
  BM25 `MATCH` over the registry's own FTS5 virtual table on component content; (2)
  `vecScore` — `@adhd/sox-vector-store` `knn()` over the enrichment embedding (the
  same embedding that filed each component). Both channels key on the
  `registry_component_versions.version_id` integer surrogate. Fuse via
  `@adhd/sox-hybrid-search`'s pure `normalize()` + `fuse()` (normalize-before-combine;
  degrades to a single channel when one is absent). Join the fused top-`limit` ids
  back to the component row for the `name + type + summary + score` projection.
  **Fusion is MULTIPLICATIVE** — a strong single signal can outrank a mixed pair, so
  ranking quality MUST be measured (nDCG), never assumed.
- **Retrieval backend (decisions.md §D6 — DECIDED: ADOPT hybrid, Option B).** Consume
  `@adhd/sox-hybrid-search`'s pure fusion; the registry implements the channels over
  its OWN store (FTS5 + `@adhd/sox-vector-store`). Do NOT wire `SqliteSearchBackend`
  (it needs a `GraphBackend`, and graph-store's `node.kind` CHECK constraint —
  `episode|entity|claim|community|session` — structurally forbids storing a registry
  "component" as a node; Option A was rejected for exactly this). `@adhd/sox-graph-store`
  is installed transitively (a hard hybrid-search dep, so it must be published) but its
  runtime is NEVER loaded under Option B — you import only `fuse`/`normalize` from
  hybrid-search plus `knn` from vector-store. The publish set is now **5**.
- **Retrieval QUALITY is proven by a golden set (discovery-tools.3 / dod.2), with
  TEETH.** Author `entrypoint/agent-mcp/src/__tests__/fixtures/component-search-golden.json`:
  ~15–30 realistic tasks, each with graded relevance judgments over a component corpus
  SALTED WITH HARD NEGATIVES (distractors sharing the query's vocabulary/topic but not
  the answer — e.g. task "refresh an expired OAuth token" → relevant:[oauth-refresh,
  token-store], distractors:[oauth-login, jwt-verify, api-key-rotate]). The corpus is
  N≫k (reuse the ≥60-item corpus from discovery-tools.2 where practical). Assert
  **nDCG@5 ≥ 0.70** (primary; report MRR alongside) in
  `component-search-ndcg.test.ts`, driving the REAL `component_search` tool over the
  bridge + real store — no mocks. **Negative control with teeth:** swap the fused
  ranker for a shuffled/insertion-order ranker and the SAME test must go RED (nDCG
  below the floor). Per repo §6.2 prove the teeth by actually running the shuffled
  variant and confirming the failure — a grep that the token `nDCG` appears is not
  proof the assertion bites.
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
