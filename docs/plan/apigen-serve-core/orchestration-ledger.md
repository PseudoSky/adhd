# Orchestration ledger — apigen-serve-core

Maintained by the live orchestrator session. Not part of the plan-state-machine
schema; a human-readable trail alongside `state.json`/`events.ndjson`.

## Claim

- Took over a STALE claim (held by `apigen-serve-core-orchestrator` since
  2026-07-24T03:30:07.886Z, age ~16229s > 1800s stale-after threshold — no
  renewal, treated as abandoned per `state-transition.js --claim`'s own
  self-healing policy).
- New claimant: `apigen-serve-core-orchestrator-1784880036-85755`, claimed_at
  2026-07-24T08:00:36.690Z.

## Wave 2 — audit-foundation (gate)

- Ran directly (no LLM dispatch — deterministic `run-audit.js` via
  `audit_apigen-serve-core.py --phase phase-1`). Script was already authored
  at plan-authoring time; nothing to fix. 21/21 criteria PASS, exit 0.
- `--start` → `--complete` both run by the orchestrator itself.
- next_state per tool: `express-adapter` (informational; wave-3 fans out to 4
  states, not just that one).

## Wave 3 — cli-adapter, express-adapter, mcp-adapter, py-extract-preflight (parallel)

- `compile-wave.js --stats`: reduction_ratio 0.2347 (≥ 0.08 threshold) → built
  a shared wave pack (`shared_invariants: 4`, `shared_snapshots: 8`).
- All 4 states `--start`'d by the orchestrator before dispatch (start_ref
  captured per state). Disjoint `mutates` sets confirmed from each context.md
  — no file-overlap risk between the 4 parallel executors.
- Dispatched as 4 parallel background agents (self-contained inline prompts:
  full goal/criteria/reservations/semantic-distillation/contract-promise from
  each context.md, PLUS the 4 core primitive files' source
  (op-plan.ts/transport-adapter.ts/package-invoker.ts/dispatch-for-plan.ts)
  and the fastify reference run.ts pattern inlined verbatim, PLUS the
  parity-harness.ts API surface, PLUS explicit pointers to the 1484-line
  fastify plugin.spec.ts and the committed fastify neg-control patch as
  worked examples for the driver/neg-control pattern each must reproduce for
  their own transport):
  - `cli-adapter` → typescript-pro (sonnet) — agent `ae58cd72d2b4dfecd`
  - `express-adapter` → typescript-pro (sonnet) — agent `ab12a27e85f6a022d`
  - `mcp-adapter` → typescript-pro (sonnet) — agent `ac596c46233ed1bbd`
  - `py-extract-preflight` → python-pro (sonnet) — agent `ac42d0b666ba7ac37`
- Each was instructed: commit with explicit pathspec only (never `git add -A`
  / `-a`), do NOT call `state-transition.js` themselves (orchestrator runs
  `--complete` after ingesting their reported real token usage via
  `--input-tokens`/`--output-tokens`/`--tool-call-count`, which
  `state-transition.js` forwards to `emit-state-metrics.js` internally), file
  any newly-discovered bugs to repo `BACKLOG.md` immediately with citations,
  never mock the thing under test (real spawned CLI child process / real
  fetch against a live express server / real `@modelcontextprotocol/sdk`
  client against the built mcp server), and never touch files outside their
  own `mutates` reservation.
- Status: dispatched, awaiting completion notifications. Will update this
  ledger with outcomes + run `--complete` per slug once each reports back.

### Hazard: mcp-adapter's in-flight build breakage transitively couples to cli-adapter's guard

Routed via team-lead (originally surfaced by the cli-adapter executor). Verified
state-side, not from executor prose:

- `CI=true nx run apigen-plugin-mcp:build` — confirmed RED right now. Root
  cause verified by reading the actual compiler output: a `McpCallToolResult`
  type mismatch at `run.ts:451` (the SDK's `CallToolRequestSchema` handler
  now expects a `task` property mcp-adapter's in-flight handler return type
  doesn't supply) — **not** the `deriveToolName`/`findOperation` import the
  routed report guessed (grepped: `run.ts` imports only `operationFor` from
  `./tool-naming` now; `tool-naming.ts` has already dropped the old exports
  cleanly; the only surviving `deriveToolName` reference is in
  `src/test/run.spec.ts`, itself inside mcp-adapter's own `mutates` set and
  expected to be mid-update).
- `CI=true nx run apigen-cli:build` — confirmed RED, transitively, because
  `entrypoint/apigen-cli/src/index.ts:8` statically imports
  `@adhd/apigen-plugin-mcp`.
- `apigen-plugin-cli-output`'s `test` target project.json has a REAL,
  pre-existing explicit `dependsOn: [{projects:["apigen-cli"], target:
  "build"}]` (needed because its real-consumer-protocol tests spawn
  `entrypoint/apigen-cli/dist/index.js` as a subprocess — confirmed by
  reading `run-cli-integration.spec.ts`). So cli-adapter's guard IS
  genuinely coupled to mcp-adapter's build health right now.
- `apigen-plugin-api-express`'s `test` target has **no** such `dependsOn`
  (only the default `^build`, i.e. express's own upstream deps) and its test
  files don't spawn the built apigen-cli — **express-adapter is NOT
  affected**, contrary to the routed report's broader claim.
- Action taken (sequencing, not worktree-isolation — the 3 TS agents are
  already mid-flight in the shared tree, converting to worktrees now would
  cost more than it saves): messaged all 3 running agents directly.
  mcp-adapter told to prioritize getting `apigen-plugin-mcp:build` (not just
  `:test`) green since it blocks a sibling. cli-adapter told the coupling is
  real, not to touch `apigen-plugin-mcp` (outside its reservation) if it hits
  this, and to sanity-check `apigen-plugin-mcp:build` standalone before
  running its own guard. express-adapter told it is unaffected.
- Will re-verify `apigen-plugin-mcp:build` + `apigen-cli:build` directly
  (not from agent prose) before treating cli-adapter's guard result as
  trustworthy.

## Next

Wave 4 (`audit-transports` + `py-flask-serve-split`), wave 5
(`py-grpc-serve-split`), wave 6 (`audit-python`), wave 7 (`audit-final`) —
per the team-lead's wave plan, pending wave-3 completion.
