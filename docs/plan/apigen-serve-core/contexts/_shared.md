# Shared context — apigen transport-neutral serve-core + thin adapters

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## Glossary

- **[def:parity-gate]** — the acceptance mechanism for every transport migration
  (proposal §6). Three steps, all mandatory: (1) BEFORE migrating, drive the
  CURRENT live server/CLI through its REAL consumer protocol and commit the capture
  as `<plugin>/src/test/golden/<transport>.snapshot.json`; (2) after migrating,
  re-capture through the adapter-based server and assert deep-equality vs the
  committed snapshot; (3) prove the negative control (see [inv:negative-control]).
  Fixture classes: safe/scalar (GET-hoist), unsafe/mutating-scalar (the
  `BUG-APIGEN-SAFE-OP-MUTATIONS-OVER-GET-001` shape — included to prove it is NOT
  silently changed), session/envelope, `streaming:true`, `--use` mount, plus one
  validation-failure and one domain `ApiError` per class.
- **[def:real-consumer-protocol]** — parity is driven the way a consumer drives it,
  never through plugin internals (AGENTS.md §7): HTTP → `fetch`; MCP → a real
  `@modelcontextprotocol/sdk` client against the BUILT server; CLI → a spawned child
  process (argv in, stdout + exit-code out); Python → an HTTP/gRPC client of a real
  spawned Python server (`grpcurl` may self-skip WITH a visible warning, and only
  when it never masks a failure in the code under test).

## Cross-cutting invariants

- **[inv:byte-identical]** — this refactor changes NO on-the-wire contract for
  existing consumers except the explicitly-flagged behavior changes: express
  `undefined→null` (`[dod.6]`), MCP malformed-input `invalid_argument` (`[dod.4]`),
  and streaming now served/rejected instead of mis-serialized (`[dod.5]`). Every
  other route/verb/tool-name/response-byte/error-status is preserved and PROVEN so
  by [def:parity-gate].
- **[inv:negative-control]** — a parity suite that has never been shown to fail is
  not a gate (AGENTS.md §7 pt 2). Each migration commits a one-line regression as
  `neg-control/<slug>.patch`; the audit applies it (`git apply`), asserts the parity
  suite goes RED, reverts it (`git apply -R`), and asserts GREEN. Never `git stash`
  / `git reset --hard`.
- **[inv:trust-exit-codes]** — gate on process exit status, never `| grep -q passed`
  (AGENTS.md §7 pt 4). Guards use `./node_modules/.bin/nx`; audits use `python3`.
- **[inv:out-of-scope-bugs]** — `BUG-APIGEN-SAFE-OP-MUTATIONS-OVER-GET-001`
  (`apigen-engine-naming/src/lib/naming.ts:150-151`) and
  `BUG-APIGEN-CLI-SERVE-FRONT-PROXY-DOUBLE-SEGMENT-001` are NOT fixed here. Their
  CURRENT behavior is pinned unchanged by a dedicated parity fixture (`[dod.9]`).

## Resolved decisions (architect-reviewed, Step 1c)

- **[fix:mount-through-layers]** — DECISION (proposal §8.1): `--use` mount ops now
  flow through `--use` layer composition like source ops. Safe because
  `makeValidateLayer` no-ops on a schema-less op
  (`apigen-engine-runtime/src/lib/validate-layer.ts:~231-235`). This is a reviewed,
  flagged behavior change (auth/logging layers now also see mount calls), NOT an
  implicit side effect — call it out in the fastify-adapter DoD/PR.
- **[fix:streaming-wired]** — DECISION (proposal §8.2): Phase 1 (fastify
  `sendStreamSse`) and Phase 2 (mcp `projectStreamMcp`) WIRE the existing-but-dead
  streaming code live now; CLI/py-flask/py-grpc explicitly REJECT a `streaming:true`
  op (never silently stringify an `AsyncIterable`). Not deferred.

> The two `[fix:]` decisions above are the architect verdict baked into the plan.
> If the architect-reviewer's returned verdict differs, this file is the ONE place
> to update and every citing state inherits it.

## Interface contracts

The new serve-core primitives are defined once in `interfaces.json` and cited by
states as `[iface:op-plan]`, `[iface:transport-adapter]`,
`[iface:create-package-invoker]`, `[iface:dispatch-for-plan]`. Never restate a
signature in a context — cite the iface slug.
