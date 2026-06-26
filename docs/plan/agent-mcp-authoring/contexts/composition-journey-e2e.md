# composition-journey-e2e — the Cumulative Usability Gate, public surface only

**Phase:** e2e · **Kind:** work · **Depends on:** versioning · **Guard:** `npx --yes nx test agent-mcp --testFile=packages/ai/agent-mcp/src/__tests__/composition-journey-e2e.test.ts`

See `contexts/_shared.md` for invariants and the three lanes.

---

## Goal

The full SPEC §7 task-packet→agent journey runs over the **public MCP surface
only** — a zero-context user (an MCP client) drives `prompt_types_list` →
`component_search` → `component_read` → `tool_list`/`model_list`/`policy_list` →
`component_define` (for a missing slot) → `agent_define` → `agent` → `task` →
`result`, against a real registry + agent-mcp server, and a freshly-composed agent
runs a task and returns a result. This is the promotion of the throwaway demos
(`docs/plan/agent-registry/demo/*.ts`, which deep-import `factory.ts`,
`buildHarness`, store APIs and `compileAgent`) into a **maintained,
zero-internal-import** integration test. `compose-via-mcp.mjs` is the reusable
demo harness DEMO.md §9 specified but never had.

**The agent RUN step uses a REAL provider — NOT a scripted/mock provider (owner
amendment).** The discovery + `agent_define` WIRING is asserted deterministically
(the composed prompt contains the discovered components in `position` order — this
always runs and is what makes the test reliable offline). But the
`agent → task → result` RUN is executed against a REAL provider — the default is
`claudecli` (the locally-authenticated `claude` CLI). When no real provider is
available the RUN step **skips (not fails)** while every deterministic wiring
assertion still runs, so CI stays green and offline. The scripted/mock provider is
removed from the run path entirely; `live-model-e2e` then extends this to the full
`{anthropic, claudecli, lmstudio}` matrix.

**The tooth:** the test carries a static import-scan assertion — it imports NO
`packages/ai/**/src/**` path (only the MCP wire client + the compiler CLI bin at
`dist/packages/ai/agent-compiler/src/cli/compile.js`). Reintroducing a deep src
import (the exact author-perspective gap the team-lead flagged) flips it red.

---

## Notes for executor

- **Mock nothing on the run path** — never the registry, the compiler, the server,
  the tools under test, OR the provider. The `agent → task → result` run uses a
  REAL provider (default `claudecli`). The owner amendment removed the scripted/mock
  provider from the proof path: the deterministic part is the WIRING assertion (the
  composed prompt contains the discovered components in order), not a faked run.
- **Real-provider run, skip-not-fail.** Probe for the real provider at runtime
  (`claude` on PATH, or another matrix provider's prerequisite) and run the
  `agent → task → result` step against it; if no real provider is available,
  `it.skip` JUST the run step while the wiring assertions still execute. See the
  `live-provider-claudecli` human-blocker. Trust exit codes, never `grep -q passed`.
- **No-mock-on-live-path guard.** The test must carry an assertion that the run
  path is a real provider (e.g. assert the provider `type` is one of
  `{anthropic,claudecli,lmstudio}` and is not the scripted test double) so swapping
  a mock back in trips it.
- Seeding/ingest is the one step with no public registry-write entrypoint yet
  (the registry packages ship no CLI bin). Until that exists, seeding may use the
  store API in a **separate fixture file** that the e2e test does NOT import — the
  no-src-import assertion covers the journey, not the one-time fixture seed. Record
  this as the honest boundary (DEMO.md §6 carries it).
- Drive the agent-mcp tools **over the MCP wire** (start the server bin, connect a
  client) — do NOT import the tool functions from `tools/*.ts`.
- Assert the composed prompt contains the discovered components in `position`
  order — the consumer-visible outcome, not an implementation shape.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [composition-journey-e2e.1] SPEC §7 journey over MCP wire + compiler CLI with static no-src-import assertion; composed agent runs a task

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/src/__tests__/composition-journey-e2e.test.ts", "docs/plan/agent-registry/demo/compose-via-mcp.mjs"]
```

---

## Notes for executor

<footguns, ordering constraints, non-obvious decisions>
