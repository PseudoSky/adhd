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

### CORRECTION: cli-adapter.2 was never actually transient — a real regex bug

The "already resolved, transient race" read above was wrong. Re-running the
full phase-2 audit clean (nothing else running, `nx reset` first) kept
showing `[cli-adapter.2] FAIL` every single time regardless of file content.
Root-caused for real: criteria.json's pattern for this criterion was the
literal string `"project("` — an UNTERMINATED regex group. `new
RegExp("project(")` throws `Unterminated group`; `run-audit.js`'s
`runCriteria` catches evaluation errors and converts them to `pass:false`,
so this criterion could **never** pass, for any code state, since the plan
was authored. This is a plan-authoring bug in `criteria.json`, not a
cli-adapter code issue. Fixed by escaping to `"project\\("` (commit
`d748d4bf`). Also found and fixed a second, same-class bug while completing
py-extract-preflight: `py-extract-preflight.2`'s pattern `"^DECISION:"`
relies on `^` anchoring per-line, but `run-audit.js` compiles patterns via
`new RegExp(pattern)` with no `m` flag, so `^` only anchors to start-of-FILE
— and the findings doc's `DECISION:` line is line 47, not line 1. Dropped
the anchor (same commit); the state's real guard, `grep -q '^DECISION:'` in
dag.json, IS per-line-aware and still enforces the actual requirement.

Also separately confirmed the fastify two-assertion "flake" seen earlier
WAS genuine contention, not hiding a third regex bug: a `nx reset` +
single, nothing-else-running audit run reproduced it a second time, but a
fully isolated standalone `nx run apigen-plugin-api-fastify:test` (also
post-reset, so not a cache replay) came back 56/56 clean three times in a
row. The audit script's own sequential chain of ~8 heavy `nx test`
invocations within one long-lived process appears to occasionally perturb
one specific fastify assertion under load; the underlying code is proven
correct via true isolation. Worth a BACKLOG-style flag to `main` as a
test-infra flake, not a gate blocker.

### Wave 3 CLOSED — all four states `status: "complete"` in state.json

`--complete` calls were run sequentially, not parallel (they mutate shared
`state.json`). express-adapter's own `--complete` landed while both regex
bugs above were still being root-caused (its `done_at` predates the
criteria.json fix commit) — its 44/44-clean completion is consistent with
those fixes having already been applied to the working tree at that
instant. Final state for all four:
- `express-adapter`: complete, `done_at` 2026-07-24T09:07:04Z, end_ref `8bbe8dbe`
- `cli-adapter`: complete, `done_at` 2026-07-24T09:31:24Z, end_ref `59b6f4e3`
  — completed via a real exit-4 (`dod_unconfirmed`, all `dod.1..10`) that
  was a FALSE terminal-boundary trigger: `state-transition.js`'s `nextState`
  search only considers `status:"pending"` siblings, and at that moment
  mcp-adapter + py-extract-preflight were still `"in_progress"` (not
  `"pending"`), so the search found no candidate and mis-flagged this
  mid-wave completion as `wouldReachTerminal`. The DoD gate only fires
  meaningfully at the true final (`phase=final`) transition where `[dod.N]`
  lines are actually emitted; here it just produced a confusing exit code.
  `state.json` still correctly marked the state `complete` and correctly
  did NOT advance `current_state` to `done`. Audit itself: 44/44, genuinely
  clean.
- `mcp-adapter`: complete, `done_at` 2026-07-24T09:34:18Z, end_ref `0f77d10088`
  — clean completion, 44/44, `dod_confirmed:true`, `next_state:
  audit-transports` (by this point cli/express/mcp were all complete so a
  real pending candidate existed and the terminal-boundary bug didn't fire).
- `py-extract-preflight`: complete, `done_at` 2026-07-24T09:39:22Z, end_ref
  `ca4af702f1` — exit 4 (`audit_failed`, 50/59) is EXPECTED and correctly
  discriminated: phase-3's accumulated audit includes `py-flask-serve-split.*`
  (5 fails) and `py-grpc-serve-split.*` (3 fails) — both legitimately
  not-yet-implemented sibling states in the SAME phase (py-extract-preflight
  gates them; they haven't run). Verified via the events log that py-extract-
  preflight's OWN 3 criteria all show PASS after the regex fix — the 9
  remaining fails are 100% attributable to unstarted siblings, none to this
  state. `dod_confirmed:true`, `next_state: audit-transports`.

Token telemetry captured for all four via `--input-tokens`/`--output-tokens`
/`--tool-call-count` (forwarded to `emit-state-metrics.js`): cli-adapter
~145k/14k/75, express-adapter ~145k/14k/65, mcp-adapter ~150k/60k/150,
py-extract-preflight ~55k/6k/16 (all executor self-reported best-effort
estimates, not byte-proxy fallback).

## Next

Wave 4: `audit-transports` (gate, depends on cli/express/mcp-adapter — all
complete) + `py-flask-serve-split` (depends on py-extract-preflight —
complete). Then wave 5 (`py-grpc-serve-split`), wave 6 (`audit-python`),
wave 7 (`audit-final`).
