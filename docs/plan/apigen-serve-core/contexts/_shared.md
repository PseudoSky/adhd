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

- **[fix:layerresult-return]** — DECISION (architect F1): `invoke()` ALWAYS returns a
  `Promise`; only the RESOLVED value is the `unknown | AsyncIterable` union, i.e.
  `LayerResult` (`apigen-engine-runtime/src/lib/invoke.ts:94-102,152-156`). So
  `dispatchForPlan` returns `Promise<LayerResult>`, `TransportAdapter.registerRoute`'s
  dispatch callback is `(call)=>Promise<LayerResult>`, and `writeResult` takes the
  resolved `LayerResult`. The proposal §3b/§3c bare-union sketch does NOT type-check —
  cite the corrected signatures ([iface:dispatch-for-plan], [iface:transport-adapter]).
- **[fix:transport-stamping]** — DECISION (architect F3): `OpPlan` carries a
  `transport: Transport` field, stamped per-package by the adapter. `dispatchForPlan`'s
  mount branch adapts the runtime `Call` (`domainArgs`/`ctx:LayerContext`) to the
  core-client `Call` (`data`/`ctx:Extensions`/`transport`/`raw`,
  `apigen-core-client/src/lib/plugin.ts:87-117`) and stamps `Call.transport` from
  `plan.transport` — NEVER a hardcoded `'http'` (which would mis-tag every non-HTTP
  transport's mount provenance once mcp/cli land). Decided AND tested in Phase 1.
- **[fix:invoker-promotion]** — DECISION (architect topology gap): the
  `UsePlugin`/`readUsePlugins`/`readUseOptions`/`adaptCoreLayer`/`buildInvokerForPackage`
  block (~120 identical lines, proposal §4) is PROMOTED into `apigen-engine-runtime`
  (`createPackageInvoker`) and DELETED from `apigen-plugin-api-fastify/src/lib/run.ts`;
  express then COLLAPSES onto `createPackageInvoker` instead of keeping its own copy.
  Named migration + deletion, not "extract OpPlan" — otherwise Phase-2 express silently
  keeps a divergent copy.
- **[fix:mcp-toolmeta-hoist]** — DECISION (team-lead, dod.4 add): the MCP tool table /
  `toolMetas` is computed ONCE at startup from `OpPlan`, never rebuilt per request in
  `streaming-http` mode (`apigen-plugin-mcp/src/lib/run.ts:269-276`). An observable,
  tested clause so it cannot silently regress.
- **[fix:use-capability-explicit]** — DECISION (team-lead, dod.11): every transport's
  `--use` capability — BOTH layer AND mount — is explicitly RESOLVED and DOCUMENTED, not
  left implicit. cli-output (zero `--use` today) either gains it or is declared
  `--use`-incapable WITH a filed follow-up. mcp must state whether it now hosts `--use`
  mount ops and pin it (dod.4 covers validate-layer, NOT mount capability).
- **[fix:pygrpc-streaming-deferral]** — DECISION (team-lead, dod.5 refine): py-grpc
  rejecting streaming ops is a DOCUMENTED, filed deferral (gRPC natively supports
  streaming; a consumer will want it) — a scope boundary for THIS epic, not a permanent
  capability verdict. File the follow-up; never a silent no.

> The `[fix:]` decisions above are the architect (F1-F4, GO §8.1/§8.2, topology) +
> team-lead verdict baked into the plan. This file is the ONE place to update; every
> citing state inherits it.

## Interface contracts

The new serve-core primitives are defined once in `interfaces.json` and cited by
states as `[iface:op-plan]`, `[iface:transport-adapter]`,
`[iface:create-package-invoker]`, `[iface:dispatch-for-plan]`. Never restate a
signature in a context — cite the iface slug.
