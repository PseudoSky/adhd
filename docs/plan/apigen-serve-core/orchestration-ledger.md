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
- **Resolved.** mcp-adapter fixed its own build (imported `ServerResult` from
  the SDK, asserted at the return site, documented why). Re-verified BOTH
  `CI=true nx run apigen-plugin-mcp:build` and `CI=true nx run
  apigen-cli:build` directly — both green (a momentary intervening
  `apigen-plugin-cli-output:lint` failure on one `apigen-cli:build` attempt
  was transient — cli-adapter mid-edit at that instant; re-ran seconds later
  and it passed clean). Told cli-adapter it is unblocked and may run its real
  guard now. express-adapter reports done: guard green 45/45, negative
  control proven RED→GREEN twice, and it independently re-ran
  `apigen-cli:test` (156/156) to self-check for mcp bleed-through before
  reporting — awaiting its full completion report with token telemetry.
  mcp-adapter still finishing (mount/--use tests, malformed-input negative
  control, transport-http-parity spec) — build won't regress again per its
  own note; awaiting its full report.

### Directive: stop editing BACKLOG.md/CHANGELOG.md

Per user simplification relayed by team-lead: the orchestrator (and its
executors) no longer touch BACKLOG.md/CHANGELOG.md at all — file every
discovered bug and every resolved-item hygiene note to `main` via
SendMessage instead. `main` now owns disclosure on those two files.
No closeout bookkeeping on them is required from this orchestrator.

### First real --complete attempt (express-adapter) — exit 4, audit_failed 42/44

All four wave-3 states' guards independently re-verified green by me before
attempting completion: py-extract-preflight (`DECISION:` line present,
well-cited), cli-output 70/70, express 45/45, mcp 85/85 (fresh, not cached).
Ran `state-transition.js express-adapter --complete` with express-adapter's
self-reported telemetry (~145k in / ~14k out / ~65 tool calls) — got exit 4,
42/44 phase-2-accumulated criteria. Root-caused the 2 failures directly
(never trusted the summary alone):

- `cli-adapter.2` (absent-pattern check: `"project("` must not appear in
  `apigen-plugin-cli-output/src/lib/run.ts`) — re-grepped fresh: **0
  occurrences now**. This was a transient snapshot — the audit's `runAudit`
  reads the LIVE working-tree file, not a git-committed one, and cli-adapter
  had already fixed this itself in commit `fe160ae7` ("reword run.ts doc
  comments to avoid literal project( substring") by the time I re-checked;
  the audit run that reported the failure must have raced a moment before
  that commit landed. No action needed — already resolved.
- `mcp-adapter.3` (absent-pattern check: `"findOperation"` must not appear in
  `apigen-plugin-mcp/src/lib/tool-naming.ts`) — re-grepped: **genuinely still
  present**, in mcp-adapter's own doc comment (line 10: `` // `findOperation`
  exports are DELETED and collapsed into `OpPlan.mcp.name`. ``). The
  absent-pattern check is a dumb string match, not comment-aware, so the
  self-referential comment trips its own criterion — the identical class of
  self-inflicted failure cli-adapter already hit and fixed for itself.
  Messaged mcp-adapter's executor with the exact fix pattern (mirror
  `fe160ae7`) and asked it to ping back once fixed.
- I also independently re-ran `apigen-plugin-api-fastify:test` (56/56 clean)
  because the raw audit stdout transiently showed two RED fastify assertions
  mid-run (`v2-fastify.run.verb.1`, golden-snapshot parity) — confirmed this
  was concurrent-process contention from my own overlapping verification
  runs, NOT a regression in the already-completed fastify-adapter state. Per
  the plan's own guidance, treated as a retry-not-fail signal and reproved
  clean.
- **Holding ALL FOUR wave-3 `--complete` calls**, including
  py-extract-preflight — corrected an initial assumption: `run-audit.js`
  accumulates phase X + every phase ordered before it, so py-extract-
  preflight's own completion (phase-3) would ALSO run the phase-2 criteria
  and hit the same `mcp-adapter.3` failure, even though its own guard (the
  standalone `grep -q '^DECISION:'` check) has nothing to do with mcp. Every
  phase-2-or-later state's `--complete` is blocked on this one criterion
  until mcp-adapter's executor fixes its comment.

## Next

Wave 4 (`audit-transports` + `py-flask-serve-split`), wave 5
(`py-grpc-serve-split`), wave 6 (`audit-python`), wave 7 (`audit-final`) —
per the team-lead's wave plan, pending wave-3 completion.
