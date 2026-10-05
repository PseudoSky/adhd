# agent-mcp multi-surface migration — DESIGN + decomposition

> **Status:** design + decomposition. Resolves `d78c8b1a` and folds in its
> near-duplicate `333656c6` (they are already `relates_to`). **No runtime behavior
> changes in this document.**
>
> This is the "brief → design" answer `d78c8b1a` asked for: *decide the shape;
> push back on anything here you think is wrong.* It is written to be executable
> by a follow-on implementer without further architectural choices.

## 0. The ask, restated

`@adhd/agent-mcp` is an MCP server and **only** an MCP server. `@adhd/backlog`
already derives **CLI + MCP + HTTP from one code-first apigen definition**. Give
agent-mcp the same property, so its ~16 operations are reachable from a terminal
and over HTTP, not only from an MCP host.

The operational motivation is concrete (2026-08-07): twelve resident agent-mcp
processes held a DB open and there was **no non-MCP surface** to ask what they
were doing, list sessions, or shut one down — `kill` by PID via `lsof` was the
only option, and MCP hosts respawned them within seconds. An `mcp__agent-mcp__*`
tool surface disappears exactly when you most need to inspect it. A CLI does not.

## 1. What exists today (verified)

- **One hand-written MCP server:** `entrypoint/agent-mcp/src/server.ts`
  `createServer(deps)` (line 309) registers 16 tools in two places — `ListTools`
  (472–566) and a `CallTool` switch (568–732) — **plus** a second, delegation-only
  copy of the 11 runtime ops as `inProcessDescriptors` / `inProcessHandler`
  (321–470). The same op wiring is therefore written twice.
- **Zod input schemas** already exist per op, imported from
  `@adhd/agent-engine-orchestrator` (`agentCreateInputSchema`, `taskToolInputSchema`,
  …), and are converted to JSON Schema by a local `toMcpInputSchema()` (144–171).
- **Two additional hand-written HTTP surfaces** already exist:
  `src/streaming/sse-server.ts` (`GET /tasks/:id/stream`) and
  `src/streaming/chat-gateway.ts` (`GET /v1/models`,
  `POST /v1/chat/completions`).
- **Boot** is `src/index.ts` `main()` (219): stores → queue/orchestrator/policy →
  SSE server (307) → MCP server (`startServer`, 320). Consequence of the
  `computeIsMainModule()` guard (424): importing `./index.js` for a library
  function must not boot a server, so the op surface cannot simply live in
  `index.ts`.
- **No apigen dependency** in `entrypoint/agent-mcp/package.json`.

## 2. The reference pattern (what backlog actually does)

`entrypoint/backlog` mounts **one** code-first definition to three transports:

- `entrypoint/backlog/src/server.ts:2-3` — *"apigen MOUNT wiring (DESIGN.md §7):
  extract() → composeSchemas() → plugin.run(). NO apigen generate, no nx codegen
  executor…"*.
- Extraction reads the built `api.d.ts`, validates a baked IR artifact
  (`dist/api.ir.json`), and falls back to a dynamic `import('./extract-live.js')`.
- Each transport mounts plugins: Fastify
  (`server.ts:878`, `usePlugins: [tracingPlugin, openapiPlugin, batchPlugin]`),
  MCP stdio (`server.ts:906`, `usePlugins: [tracingPlugin, batchPlugin]`), and the
  CLI plugin (`cli.ts`, `cliPlugin.run()` with `USE_PLUGINS`).
- The MCP tools take a **`data` envelope** — `{"data": { …domain params… }}` — a
  calling convention apigen derives, not hand-written.

The reusable pieces (`@adhd/apigen-core-client`, `-plugin-mcp`,
`-plugin-cli-output`, `-plugin-api-fastify`, `-plugin-openapi`, `-plugin-batch`)
are already shipped and are dependencies of `backlog`.

## 3. Where agent-mcp genuinely differs (and what that changes)

The brief named three; here is the resolution for each.

1. **Stateful & long-lived (sessions, running tasks, streaming/SSE, HITL).**
   apigen projects **request/response CRUD** well. It does not model live streams.
   **Decision:** only the ~16 **request/response ops** go through apigen. The
   SSE task stream and the OpenAI-compat gateway **stay hand-written and in
   place** (`src/streaming/*`). This matches `333656c6`'s own risk clause: *"the
   refactoring is for the CRUD/query operations, not for streaming."*
2. **Process supervision & a queue.** The queue/orchestrator/DagEngine are
   constructed in `main()` and injected via `ServerDeps`. **Decision:** the
   apigen surface receives the **same deps bag**; it does not construct or own
   lifecycle. A `serve` command builds deps then mounts.
3. **`@adhd/environment` config/ports/DB paths.** Already centralized in
   `src/config.ts`. **Decision:** unchanged; the CLI/MCP/HTTP mounts read the same
   `env`. The SSE port already resolves per-instance with an ephemeral fallback
   (`resolveInitialSsePort`, `sse-server.ts`), so a second HTTP surface must not
   assume a fixed port.

## 4. Compatibility stance (additive, not breaking)

- **MCP tool names and payload shapes are a public compatibility surface**
  (wired into MCP host configs; published at 2.3.x). **Decision: additive.** The
  migrated MCP mount must expose the **same 16 tool names** and **the same
  response shapes**. Existing hand-written handlers are kept as the oracle until
  the apigen mount is proven byte-for-byte equivalent by a parity test, then the
  hand-written switch is deleted in a later packet.
- The apigen `data`-envelope convention is an **additive** calling style; the MCP
  mount may accept both the legacy flat params and the envelope during a
  transition window.
- Therefore **no major-version bump is required for the migration itself**. A
  major is only forced if a later packet changes existing tool payloads, which
  this design forbids.

## 5. Target architecture

```
entrypoint/agent-mcp/src/
  client.ts          ← NEW: op surface (plain async fns over a deps bag)   [P1]
  api.ts             ← NEW: apigen extraction surface (JSDoc'd fns → client) [P2]
  mounts/
    mcp.ts           ← apigen MCP mount (replaces hand-written tool switch)  [P3]
    cli.ts           ← apigen cli-output mount (+ `serve` command)           [P4]
    http.ts          ← apigen Fastify/express mount                          [P4]
  streaming/*        ← UNCHANGED (SSE + gateway stay hand-written)
  server.ts          ← unchanged until P3 parity, then reduced to mount glue
  index.ts           ← main(): constructs deps; `serve` selects transports
```

- **`client.ts`** exports one plain async function per operation
  (`agentCreate`, `agentRead`, `agentList`, `task`, `taskList`, `taskCancel`,
  `taskResume`, `result`, `sessionList`, `sessionClose`, `sessionClear`,
  `usageQuery`, `guide`, …), each taking `(params, deps)`. It is a pure
  extraction of the bodies already in `server.ts`'s `CallTool` switch — the
  duplication between `inProcessHandler` and `CallTool` collapses to **one**
  implementation.
- **`api.ts`** is the apigen extraction file: thin JSDoc'd wrappers with
  JSON-Schema-representable parameter types (no interfaces with methods, no
  function-typed params — mirroring `dispatch-cli/src/api.ts`'s header contract).
- **`mounts/*.ts`** call `extract → composeSchemas → plugin.run` with the
  appropriate plugin, exactly as `backlog/src/server.ts` does.

## 6. Decomposition — independently shippable packets

Each packet is independently mergeable and testable; later packets depend only
on earlier ones' *outputs*, not on their internals.

### P1 — extract `src/client.ts` (foundational slice, no transport change)

- **Deliverable:** `client.ts` with every op as a plain async fn over a `deps`
  bag; `server.ts`'s `inProcessHandler` **and** `CallTool` switch both delegate to
  it (single implementation, two call sites).
- **Exit criteria:** existing agent-mcp MCP behavior unchanged — the current test
  suite (incl. `wiring.test.ts`, `main-entry-symlink.test.ts`) stays green;
  `nx build agent-mcp` + `verify-dist-load` green. **No new public surface.**
- **Risk:** low. Purely additive-then-delegate; reversible.

### P2 — `src/api.ts` extraction surface

- **Deliverable:** JSDoc'd `api.ts` wrappers; a `jsonschema`/`extract` target that
  produces the IR without booting the server (must be store-free, like backlog's
  `ir-artifact`).
- **Exit criteria:** extraction succeeds for all ops; a test asserts the op count
  and that the derived schemas match the zod schemas in use.

### P3 — apigen MCP mount (parity-gated)

- **Deliverable:** `mounts/mcp.ts` serving the 16 tools via
  `@adhd/apigen-plugin-mcp`; a **parity test** that compares, per tool, the apigen
  mount's response to the legacy hand-written handler's response.
- **Exit criteria:** parity test green for all 16 ops; driven as a real MCP host
  (`.mcp.json` → built artifact → tool call), per AGENTS.md. Only after this is
  the hand-written tool switch removed.
- **Depends on:** P1, P2.

### P4 — CLI + HTTP mounts (+ `serve`)

- **Deliverable:** `mounts/cli.ts` (`@adhd/apigen-plugin-cli-output`) giving
  `agent-mcp <op>` from a terminal; `mounts/http.ts`
  (`@adhd/apigen-plugin-api-fastify`) giving REST; a `serve` command mirroring
  backlog's `serve` that selects transports.
- **Exit criteria:** `agent-mcp --help` lists ops; a smoke test invokes a read-only
  op over the built CLI and over HTTP; the ops-reachable-without-MCP requirement
  is met (list sessions / stop agent from a terminal).
- **Depends on:** P2.

### P5 — compatibility cleanup + docs

- **Deliverable:** remove the superseded hand-written wiring; update
  `entrypoint/agent-mcp/AGENTS.md`, `README.md`, `llms.txt`.
- **Depends on:** P3.

### P6 — decompositions of the *streaming* surfaces (explicitly out of apigen)

- Keep SSE/chat-gateway hand-written; optionally add an SSE client renderer
  (already delivered separately as `c667a213`).

## 7. What we are NOT doing (and why)

- **Not** routing streaming/SSE/HITL through apigen — it has no stream model;
  forcing it would break live visibility, the exact thing that motivated the work.
- **Not** changing existing MCP tool names/payloads — that is a published
  compatibility surface; the migration is additive.
- **Not** merging agent-mcp's runtime internals into apigen's conventions.
- **Not** touching `dispatch-cli` here — its `AgentMcpRunner` keeps calling the
  MCP `task`/`result` tools, which P3 preserves by construction.
- **Not** proposing a service split or a separate process for the CLI/HTTP mounts;
  they mount on the existing process, reusing the same deps (matching backlog).

## 8. Prerequisites & risks

- **BUG-020 (HIGH, OPEN):** agent-mcp's built `dist/package.json` says
  `type: commonjs` while source is `type: module`, so `dist/src/index.js` can fail
  to load under a symlinked launch. **A broken dist entry undermines any new mount.**
  Treat as a blocking prerequisite for P3/P4.
- **BUG-021:** the agent-mcp e2e suite currently blocks its own publish (2.2.2
  built/bumped but not on npm). P1/P3 must not deepen this debt; the parity test
  for P3 should run by default.
- **Verification stance:** per AGENTS.md, every new mount is proven by driving the
  **real built artifact as a consumer** — a real MCP host for P3, the built CLI for
  P4 — never by importing the build and calling functions.
- **Coupling to `@adhd/environment`:** new mounts must not hardcode the SSE port;
  reuse `resolveInitialSsePort` / `setSseBoundPort`.

## 9. Relationship to sibling efforts

- **`FEAT-BACKLOG-011`** — backlog's own three-surface product-architecture effort.
  Align on conventions (envelope shape, mount namespaces) so the two entrypoints
  do not diverge.
- **`cb2cec85`** — the three-dispatcher reconciliation; this design keeps
  agent-mcp's runtime boundary intact, consistent with that document's
  "intentionally separate" list.
- **`c667a213`** — the SSE `--follow` renderer; P6 leaves streaming in place for it.

---

*Folds in `333656c6` (identical goal: CLI-as-full-client + `serve` for MCP; its
"keep streaming on the custom path" risk is honoured in §3/§7). Citations:
`entrypoint/agent-mcp/src/server.ts:309,321-470,472-566,568-732,144-171`;
`entrypoint/agent-mcp/src/index.ts:219,307,320,424`;
`entrypoint/agent-mcp/package.json:1-37`; `entrypoint/backlog/src/server.ts:2-3,878,906`;
`entrypoint/backlog/src/cli.ts`; `entrypoint/dispatch-cli/src/api.ts:1-29`;
`entrypoint/agent-mcp/src/streaming/sse-server.ts:34`;
`docs/agent-mcp/agent-mcp-chat-gateway/SPEC.md`.*
