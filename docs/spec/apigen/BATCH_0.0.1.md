<!-- markdownlint-disable MD013 MD033 MD024 -->
# apigen — Batch/Bulk Fan-Out Operation Spec (v0.0.1, draft)

> **Status:** Implemented (2026-07-27) — F1-F5 closed against `tmp/apigen-batch-architect-review.md`;
> see §8 revision history for what changed per finding and the real file paths. F6 (Tenet-1
> compliance) required no code change — §2.1 already stated it correctly. **0.0.3 (2026-07-27):** a
> real, shipped `@adhd/apigen-plugin-batch` package now exists and `--use batch` resolves end-to-end
> — see §2.2 for the `MountHostBridge` runtime-wiring resolution and §8's 0.0.3 entry for the full
> shipped diff. Supplements `docs/apigen/SPEC.md` (the canonical apigen spec); every section below
> cites the parent spec section it extends or relies on. Tracked in the backlog as
> `FEAT-APIGEN-BULK-OPS-001`.

---

## 0. Problem statement

Two distinct things get conflated under "bulk operations," and only one of them is a real gap:

1. **Batch-shaped, author-written operations** (e.g. `batchCreateItems(items: ItemInput[]): Item[]`)
   need **zero apigen changes**. They are ordinary functions with array-typed params/returns; the
   existing extract/composeSchemas pipeline (`SPEC §3`/`§4`) already handles them as ordinary
   `Operation`s — one CLI command, one MCP tool, one HTTP route, ordinary codegen. If a consumer
   wants atomicity, that is the author's own implementation detail inside that one function, not a
   framework concern.
2. **Generic N-way fan-out of an existing, unmodified single-item operation** — this is the actual
   gap this spec addresses. A consumer (e.g. an apigen-refactored `agent-mcp`, per `FEAT-AGENT-001`)
   has an operation like `task(prompt: string): TaskResult` that dispatches to a slow external
   service per call. Batching it is a call-orchestration problem (concurrency, partial failure,
   backpressure, cancellation) — not a data-shape problem — and nothing in the existing pipeline
   solves it generically today.

This spec defines the mechanism for (2).

**Motivating incident:** `BUG-AGENTMCP-TRIAGE-CONCURRENCY-001` — a 29-way concurrent hand-rolled
fan-out (manual `agent()`+`task()` calls, one pair per item) produced a 72% first-pass failure rate
under shared-resource contention, resolved only by hand-building a `depends_on`-chained serial
execution. This spec generalizes that lesson: concurrency must be a first-class, bounded,
consumer-configurable property of the mechanism, not something every consumer rediscovers by
failing first.

---

## 1. Shape — one synthetic operation per distinct `kind`, injected via `MountCapability`

**F1 (closed 2026-07-27):** the 0.0.1 draft proposed **one** omnibus `_batch` mount for every
batchable operation, with a single hardcoded `kind: 'action', safe: false`. The architect review's
F1 finding rejected this: `Operation.kind`/`.safe` are static, per-op classifications that
transports read to make wire decisions (HTTP verb/cacheability, gRPC idempotency-level —
`SPEC §4`/`§5`), and `_batch`'s actual behavior depends on the runtime `operation` string selected
inside `call.data` — it may fan out over a `query` op one call and an `action` op the next. No
static `Operation` object can carry that truthfully.

Per `SPEC §7.1`/`§7.2b`, a `MountCapability` contributes synthetic `Operation`s to the descriptor —
the existing, documented mechanism (precedent: `/meta/health`, `/meta/openapi`). Batch is this,
but **one synthetic operation PER DISTINCT `kind` present in the batchable set** — `_batch/query`,
`_batch/action`, etc. — each with a truthful static `kind`/`safe` and an `operation` enum restricted
to ids of that kind. The common case (a single-kind entrypoint, e.g. agent-mcp's `task`) still costs
exactly one extra tool/route/command; only a genuinely mixed-kind entrypoint pays for a second mount.

Implemented in `@adhd/apigen-core-client`'s `src/lib/batch.ts` (host-agnostic; §5's portable half):

- `groupBatchableOperationsByKind(operations, opts)` — groups by `Operation.kind`, honoring
  `opts.exclude` (§2.1's Tenet-1 opt-out).
- `buildBatchKindSchema(ops)` — the input/output schema pair (+ `InlineDiscriminator`, when
  applicable) for one kind's mount (§1.1).
- `buildBatchMountedOperations(descriptor, opts)` — the top-level entry point: one
  `Omit<MountedOperation, 'handler'>` per distinct kind, refusing to mount anything for a
  descriptor with zero batchable operations (returns `[]`).

A real `MountCapability` plugin composes `{ ...buildBatchMountedOperations(...)[i], handler }` —
wiring the handler to `invokeBatch` (§3) is the one piece left to the plugin, since `invokeBatch`
is TS-runtime plumbing this host-agnostic module deliberately does not depend on (§5).

### 1.1 Input/output — discriminated union, not a generic envelope

`_batch`'s input and output use apigen's own established discriminated-union wire shape
(`oneOf` + `discriminator`; see also `docs/plan/apigen-logical-types`), **not** a generic
`items: unknown[]` envelope. **Correction (round-2 revision):** the citation in the 0.0.1 draft
(`apigen-core-client/src/lib/schema-builders/union.ts`) pointed at the wrong of the two real
conventions apigen already has for this shape. `union.ts`'s `buildUnionSchema` (verified
`union.ts:111-139`) only emits `$ref`-based branches into `#/$defs/<ClassName>` — it requires each
variant to already be a *nominal* type registered by `nominal.ts`, and it throws
(`union.ts:114-118`) if given fewer than 2 variants. `_batch`'s branches are **not** nominal
classes extracted from real TS source; they are synthetically constructed per batchable operation
at plugin-mount time (`deriveBatchOperationBranch`, §1.2), and each branch is an *inline* object
schema (`{operation, items, concurrency, mode, itemTimeoutMs}`), not a `$ref`. The actual precedent
for this — same-document inline branches with an advisory, auto-detected discriminator — is
`morph-walk.ts`'s `InlineDiscriminator`/`detectDiscriminator` (`morph-walk.ts:276-287`,
`298-309`), whose own doc comment explicitly contrasts itself with `union.ts`: *"Inline branches
have no `$ref`/`$defs` identity of their own, so — unlike `union.ts`'s `$ref`-based
`buildUnionSchema` — the mapping target is a same-document pointer"* (`morph-walk.ts:283-284`,
verbatim). `deriveBatchOperationBranch` must therefore emit the `InlineDiscriminator` mapping shape
(`"createItem": "#/oneOf/0"`, a same-document JSON Pointer into `_batch`'s own `oneOf` array — this
is what the example below already shows correctly) and must **not** call `buildUnionSchema` or
attempt to register batch branches as `nominal.ts` `$defs`. This is a correction to the citation
and the derivation mechanism, not to the wire shape itself — the shape shown below was already
right.

**Edge case the 0.0.1 draft missed:** both real discriminator builders require ≥2 variants
(`union.ts:114-118`; `detectDiscriminator` returns `undefined` below 2, `morph-walk.ts:301`) because
a one-branch `oneOf` is not a union. If an entrypoint's descriptor has exactly zero or one batchable
operation, `_batch` cannot be a valid discriminated union — the plugin's `capabilities.mount.operations`
implementation MUST refuse to mount `_batch` at all in that case (return `[]`, not a malformed
single-branch schema), and this refusal needs to be a stated part of the mount contract, not an
implementation-time surprise. Filed as a §9 correction below rather than left implicit.

Each batchable operation contributes one discriminator branch, carrying its own real input/output
schema:

```jsonc
// input
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "operation": { "const": "createItem" },
        "items": { "type": "array", "items": /* createItem's real input schema */ },
        "concurrency": { "type": "number" },
        "mode": { "enum": ["parallel", "serial", "chained"] },
        "itemTimeoutMs": { "type": "number" }
      },
      "required": ["operation", "items"]
    },
    { /* one branch per other batchable operation */ }
  ],
  "discriminator": { "propertyName": "operation", "mapping": { "createItem": "#/oneOf/0", "...": "..." } }
}
```

```jsonc
// output — mirrors the input branches, same discriminator
{ "oneOf": [ { "type": "array", "items": /* BatchItemResult<createItem's output>, see §3 */ } ] }
```

**Rationale — why one mount PER KIND, not one omnibus mount:** the operation identity
(`_batch/<kind>`), the mount point, the MCP tool/CLI command/HTTP route are singular **per kind**.
The discriminated union lives entirely *inside* that one operation's schema, scoped to the
operations sharing that kind — exactly analogous to any other operation in the system whose input
happens to be a tagged union of several shapes. This is not a new concept invented for batch; it
reuses `SPEC §6`'s "one core IR, everything fans out from it" principle and the pre-existing union
convention verbatim, just applied once per kind instead of once globally (F1 correction).

**Rationale — why `kind`/`safe` are truthful per mount, never hardcoded (F1):** `Operation.kind`/
`.safe` are static classifications transports read to make wire decisions (HTTP verb/cacheability,
gRPC idempotency-level — `SPEC §4`/`§5`). The 0.0.1 draft declared a single `_batch` mount's
`kind: 'action', safe: false` **unconditionally**, regardless of which branch was selected at
request time — this doesn't hold up: a `_batch/query` mount over safe, cacheable reads and a
`_batch/action` mount over unsafe mutations are genuinely different wire-decision inputs, and
conflating them into one hardcoded-unsafe mount would make every batched query un-cacheable for no
reason. Per-kind mounting fixes this at the root: `_batch/query` is `kind: 'query'`
(`safe: true` by the existing `Operation.safe` default-from-kind rule — `SPEC §4`), `_batch/action`
is `kind: 'action'` (`safe: false`) — genuinely no bulk API conflates these either (Stripe/GitHub
GraphQL batch mutation endpoints are never exposed as cacheable `GET`s, and neither is a batched
read forced into an unsafe verb). Each mount's classification is now derived from its kind, not a
single hardcoded compromise across all kinds.

### 1.2 The shared derivation helper(s) — F2 (closed 2026-07-27)

Two distinct real, exported helpers ship as part of this work — the round-2 revision below
correctly separated them; both are now implemented rather than hypothetical:

**`syntheticOp(id, descriptor, fields)`** — `apigen-core-client/src/lib/plugin.ts`. This is the
generic ~10-field `MountedOperation` (sans `handler`) boilerplate builder the F2 finding asked for:
`id`/`host`/`namespace`/`path`/`kind`/`async`/`streaming`/`safe`/`input`/`output`/`envelope`/
`typeText`, with sane per-field defaults (`kind` defaults `'action'`, `safe` defaults from `kind`,
schema fields default `{}`). **`apigen-plugin-health` is retrofitted onto it** in this change,
replacing its locally hand-built `Operation` literal + local `seg()` helper — the exact "two
independently-maintained implementations" F2 flagged. Health's own behavior is unchanged (its
existing test suite, `apigen-plugin-health/src/test/plugin.spec.ts`, passes unmodified — only the
*construction path* changed, not the output shape).

**`deriveBatchOperationBranch(op: Operation)`** — `apigen-core-client/src/lib/batch.ts`:

```ts
function deriveBatchOperationBranch(op: Operation): {
  operationConst: string;
  itemsSchema: JSONSchema;      // op.input
  resultSchema: JSONSchema;     // BatchItemResult<op.output>, see §3
}
```

This is a pure `Operation → schema fragment` transform — **host-agnostic**, since `Operation` is
already the canonical, host-neutral IR (`SPEC §2`/`§4`) regardless of which extractor produced it.

**Round-2 revision's correction stands and is now moot in practice:** health's `buildHealthOperations`
still does not derive from any *existing* `Operation` (it authors a fixed, zero-input `_meta/health`
operation) — so it was never a candidate for retrofitting onto `deriveBatchOperationBranch`
specifically, and it isn't. What health legitimately shares with batch is `syntheticOp` (the
generic field-boilerplate builder, above) — a categorically different, more general helper than
`deriveBatchOperationBranch` (which additionally wraps a REAL existing operation's `input`/`output`
into a discriminator branch, something health has no analogue of). Both helpers are real; each is
used for what it actually solves.

---

## 2. Injection & consumption paths

> **Scope note (0.0.3, superseding 0.0.2's deferral) — RESOLVED, shipped 2026-07-27:** the
> `MountedOperation.handler` cross-op-invocation gap 0.0.2 deferred (`batchPlugin` needing a way to
> call another already-mounted operation from inside its own handler) is now closed. `@adhd/apigen-
> plugin-batch` is a real, shipped package; `--use batch` resolves via `BUILTIN_USE_PLUGINS`
> (`entrypoint/apigen-cli/src/lib/commands/run.ts`). See §2.2 below for the resolution (the
> `MountHostBridge` mechanism) and §8's 0.0.3 entry for the full change list and citations.

Two legitimate consumption paths exist for the same plugin artifact, and they **must** produce
identical `MountedOperation[]` output for the same `(descriptor, opts)` — stated here as a hard
invariant. **F5 (closed 2026-07-27):** verified by
`entrypoint/apigen-cli/src/test/integration/mount-delegation-conformance.spec.ts`, which proves
STRUCTURAL DELEGATION rather than output-equality alone (per §7 open-question 2's stronger
recommendation, below) — it `vi.spyOn`s the real, live `healthPlugin.capabilities.mount.operations`
method (health stands in for any mount plugin here, batch included, since it is the one plugin with
both paths already real and load-bearing today) and asserts BOTH the real CLI `--use` loader's
server-startup path (a live `apigen-plugin-api-fastify` server built with
`usePlugins: await loadUsePlugins(['health'])`) and a hand-wired direct
`capabilities.mount.operations()` call invoke that exact same function reference. A reimplementation
of either path would leave the spy uncalled even if it happened to reproduce identical output today —
this is what makes the test structural rather than a regression-only diff.

1. **CLI `--use` loader** (real, load-bearing today — `entrypoint/apigen-cli/src/lib/commands/serve.ts`
   already does this for the `health` mount): `apigen serve --use batch --opt batch.exclude=opId1,opId2`.
2. **Hand-wired direct invocation** (the pattern `entrypoint/backlog/src/server.ts` actually uses —
   it hand-calls `extract()` → `composeSchemas()` → `plugin.run()` per transport, never going through
   the CLI's `--use` loader or `createApiPackage`): the consumer imports `batchPlugin` directly and
   calls `batchPlugin.capabilities.mount.operations(composedDescriptor, { exclude: [...] })` itself,
   merging the result into its own schemas before calling each transport plugin's `run()` — the same
   explicit-list pattern it already uses for `[openapiPlugin, mcpPlugin, apiFastifyPlugin]`.

### 2.1 Configuration — both switches are "by source," never a runtime flag or config file

- **Per-op opt-out**: the plugin's own `opts.exclude: string[]`, passed as `--opt batch.exclude=...`
  (path 1) or as a literal argument at the direct-invocation call site (path 2).
- **Whole-service disable**: literal omission of `batch`/`batchPlugin` from that entrypoint's own
  checked-in source — its CLI script's `--use` flags, or its hand-wired plugin list. Not a runtime
  toggle, not an `apigen.config` file (checked: no such loader exists in the codebase today — it is
  referenced in exactly one doc comment as an aspiration, not real infrastructure to build on).

This satisfies `SPEC` Tenet 1 (all configuration is out-of-source, at the projection layer — never
a source annotation on an individual operation) while still being visible and editable at the exact
call site a developer reading that entrypoint's source would look. **F6 (architect review) —
confirmed, no code change required:** the `exclude` opt-out (a CLI flag/`--opt` or a direct-call
argument) and deferring per-item validation to the existing runtime validation layer both correctly
avoid any source annotation, stated explicitly here per the review's request so it isn't
re-litigated by a future reviewer.

### 2.2 Runtime wiring — the hostBridge gap and its resolution (SHIPPED 2026-07-27)

`§2`'s `batchPlugin.capabilities.mount.operations()` describes the plugin's *schema/registration*
shape — deriving and mounting `_batch/<kind>` operations. It does not, on its own, explain how that
plugin's `handler` actually invokes the N target operations a batch call fans out to. This turned
out to be a real, previously-unaddressed structural gap, not a detail:

**The gap.** `MountedOperation.handler: (call: Call) => unknown | Promise<unknown> |
AsyncIterable<Chunk>` (`apigen-core-client/src/lib/plugin.ts`) is a self-contained closure built at
mount time, before any host request exists. `health`/`openapi`'s handlers are pure (no dependency on
invoking other operations), so this was never exercised before batch. Batch's handler fundamentally
needs to call `invokeBatch(invoke, fnName, calls, opts, batchOptions)` (`§3`) against a real
`InvokeFn`/`InvokeOptions` pair — and nothing in `MountCapability`'s contract, nor any of the four
hosts' `run.ts` (`apigen-plugin-{api-fastify,api-express,mcp,cli-output}`), threads that runtime
context into a mount plugin's `operations()` call. Each host's `collectMountedOperations` calls
`mount.operations(descriptor, opts)` with exactly two arguments today, and the mount-registration
section that follows builds only an always-empty placeholder `InvokeOptions` (`{fns:{}, schemas:{}}`)
— confirmed by direct reading of all four hosts, not assumed.

**Resolution (architect-reviewed, `tmp/apigen-batch-rollout-review.md`, verdict GO-WITH-CHANGES,
2026-07-27):** widen `MountCapability.operations()` with an additive, **optional** third parameter —
a duck-typed (never imported from `apigen-engine-runtime`, which would violate the core→engine tier
direction) `hostBridge` carrying the real `InvokeFn`+`InvokeOptions`-equivalent pair:

```ts
operations(
  descriptor: Descriptor,
  opts?: Record<string, unknown>,
  hostBridge?: {
    invoke(fnName: string, call: { domainArgs: Record<string, unknown>; envelope: Record<string, unknown>; signal?: AbortSignal },
           opts: { fns: Record<string, unknown>; schemas: Record<string, unknown>; createClient?: (envelope: Record<string, unknown>) => Promise<unknown> }): Promise<unknown>;
    invokeOptions: { fns: Record<string, unknown>; schemas: Record<string, unknown>; createClient?: (envelope: Record<string, unknown>) => Promise<unknown> };
  }
): MountedOperation[]
```

This is backward-compatible (health/openapi's existing 2-argument calls are unaffected) and keeps
`MountCapability` the single capability type — a separate `BatchCapability` was considered and
rejected (it would duplicate the registration/collection machinery §2's four hosts already share,
for no isolation benefit).

**The real remaining cost, sized correctly (revised upward from an earlier draft's "4 small edits"
estimate):** none of the four hosts currently accumulate a package-spanning `fns`/`schemas` table at
the point `mount.operations()` is called — each host's `schemasByOpId`/`fnsByOpId` are built and
discarded *inside* its per-package loop. Each host needs that accumulation hoisted to host scope,
merged across every package it serves, and used to build the real `hostBridge` (replacing the
always-empty placeholder) before the mount-registration section runs. This is real, tractable,
per-host structural work — not free, but not a transport-projection rewrite either (§2's four hosts'
*registration* machinery, `collectMountedOperations`, needs zero changes; only the *invocation*
context threaded into it does).

Full reasoning: `tmp/apigen-batch-rollout-design.md` (the original design note) and
`tmp/apigen-batch-rollout-review.md` (the review that corrected it — read this one as authoritative
where the two differ).

**Shipped (2026-07-27), citing the design note + review above:**

- `MountCapability.operations()` widened with the additive, optional `hostBridge` third parameter
  exactly as designed — `MountHostBridge`/`MountHostBridgeInvokeOptions`, exported from
  `apigen-core-client/src/lib/plugin.ts` (also re-exported from the package's `src/index.ts`).
  `health`/`openapi`'s existing 2-argument calls verified unaffected (their test suites pass
  unmodified). `apigen-engine-runtime/src/lib/package-invoker.ts`'s internal `UsePlugin` mount-shape
  type was widened identically (it duck-types the same signature independently, per Finding 3's tier
  separation — it does not import `MountHostBridge` from `apigen-core-client`).
- All four hosts (`apigen-plugin-{api-fastify,api-express,mcp,cli-output}`) hoisted their
  per-package `schemasByOpId`/`fnsByOpId` accumulation to host-scoped, package-spanning
  `mergedSchemasByOpId`/`mergedFnsByOpId` maps (Finding 2), then build a real `hostBridge` from them
  (a `createPackageInvoker(mergedSchemasByOpId, usePlugins)`-composed invoke, wrapped to adapt the
  duck-typed call shape into the real runtime `Call`) and thread it as the third argument to
  `collectMountedOperations`'s `cap.operations(descriptor, opts, hostBridge)` call — replacing the
  previously always-empty `mountInvokeOpts` for hostBridge purposes.
- **A second, previously-undiscovered gap was found and fixed while wiring the first real non-trivial
  mount (`_batch/<kind>`'s handler needs real request input; `health`/`openapi` never did):** every
  host's `readCall` (or MCP equivalent) unconditionally treated a mount op's domain input as `{}` —
  `apigen-plugin-api-fastify`/`apigen-plugin-api-express`'s `readCall` special-cased `plan.isMount` to
  always return an empty `domainArgs` regardless of the real request body/query, and
  `apigen-plugin-mcp`'s `readCall` unconditionally read `raw.args['data']` (the *composed-schema*
  convention) even though a mount's real advertised `inputSchema` is `mountedOp.input` **directly**,
  never data-wrapped. This was invisible before batch because `health`/`openapi`'s mounts are
  zero-input — reading "nothing" and reading "the real, empty request" were indistinguishable. Fixed
  in all three (CLI-output's mount input is separately, already-and-explicitly out of scope per §6's
  `BUG-APIGEN-CLI-ROOT-ONEOF-UNSUPPORTED-001` — CLI mount commands get zero domain flags for a
  `oneOf`-shaped input regardless of this fix, tracked there, not re-litigated here).
- `@adhd/apigen-plugin-batch` (`packages/apigen/apigen-plugin-batch`) is a real, shipped package
  composing `buildBatchMountedOperations` (§1) + `invokeBatch` (§3) via the `hostBridge`, registered
  in `entrypoint/apigen-cli/src/lib/commands/run.ts`'s `BUILTIN_USE_PLUGINS` — `--use batch` resolves.
  A missing `hostBridge` (an un-upgraded host, or a hand-wired consumer that forgot to supply one)
  throws a clear, actionable `ApiError('internal', …)` at request time rather than silently no-op'ing.
- Proven end-to-end (not just unit-level) by
  `entrypoint/apigen-cli/src/test/integration/batch-plugin-e2e.spec.ts`: a real `apigen-plugin-api-
  fastify` server, started with `usePlugins: await loadUsePlugins(['batch'])` (the exact real
  `--use batch` resolution path), serving a real domain package/operation
  (`catalog.getItem(id): {id, name}`), driven over real HTTP `POST /_batch/action` with a multi-item
  request — asserting the real fanned-out results come back in order, a real per-item failure
  surfaces as `status: 'rejected'` without aborting the batch (`onItemError: 'continue'`, the
  default), and an unrecognized `operation` value is rejected `400` (proving the mount is bound to
  the real descriptor's real batchable set, not a stub).
- Mount-delegation structural-conformance test suite
  (`entrypoint/apigen-cli/src/test/integration/mount-delegation-conformance.spec.ts`, F5) verified
  still green, unmodified, after the hostBridge widening — confirming the widening is genuinely
  additive.
- A pre-existing negative-control fixture
  (`docs/plan/apigen-serve-core/neg-control/mcp-adapter.patch`) needed its hunk 1 context/line numbers
  regenerated after `apigen-plugin-mcp/src/lib/run.ts`'s `readCall` was restructured for the mount-
  input fix above — the negative-control's semantic assertion (swapping `field.mcpMetaKey` for
  `field.field` must turn the envelope-binding test red) is unchanged, only the patch's line
  anchoring was refreshed to the file's current shape.

---

## 3. Execution — pure orchestration over the existing harness

**Implemented in `apigen-engine-runtime/src/lib/batch.ts`** (F1's execution half — TS-runtime
plumbing, per §5's portable/non-portable split; F4 closed 2026-07-27, see below). The existing
runtime harness (`apigen-engine-runtime/src/lib/invoke.ts`,
`createInvoker(layers) → invoke(fnName, call, opts)`, `SPEC §8`/`§8.1`) is unchanged. Batch adds a
pure orchestration function that calls `invoke()` N times:

```ts
interface BatchOptions {
  concurrency?: number;          // caller-requested; default 4; HARD-CAPPED (e.g. 32) regardless of request
  mode?: 'parallel' | 'serial' | 'chained';   // 'chained' = DAG depends_on-style, see §0's motivating incident
  onItemError?: 'continue' | 'abort';         // default 'continue' — Promise.allSettled semantics
  itemTimeoutMs?: number;        // per-item; the item's signal is derived/linked from the batch's own signal
}

type BatchItemResult<T = unknown> =
  | { index: number; status: 'fulfilled'; value: T }
  | { index: number; status: 'fulfilled'; chunks: unknown[] }   // streaming op, collected — see §4
  | { index: number; status: 'rejected'; reason: unknown; chunksDelivered?: number };

function invokeBatch(
  fnName: string, calls: Call[], opts: InvokeOptions, batch?: BatchOptions
): Promise<BatchItemResult[]>
```

Every Layer (auth, logging, sanitize, `SPEC §8.1`) still runs per-item, unchanged — batch is sugar
over N invocations with concurrency control, never a bypass of the Layer stack.

**Concurrency ceiling is framework-enforced, not advisory.** The hard cap exists specifically because
of `§0`'s motivating incident: unbounded fan-out against a possibly-contended shared resource is a
footgun every consumer would otherwise rediscover independently. Implemented as
`BATCH_DEFAULT_CONCURRENCY = 4` / `BATCH_MAX_CONCURRENCY = 32`; a requested `concurrency` above the
cap is silently clamped down to it, never honored, and `mode: 'serial' | 'chained'` forces
`concurrency` to `1` regardless of what was requested.

**F4 (closed 2026-07-27) — cancellation decision, implemented, not deferred:** cancellation is two
distinct, composable operations, not one: cancelling the whole batch (the batch's own `AbortSignal`,
carried on each item's `Call.signal`, `SPEC §8.1`/`§11`) versus cancelling one item's execution
without affecting the others (`itemTimeoutMs`). **Decision:** each fanned-out item gets its own
`AbortSignal`, DERIVED/LINKED from that item's `Call.signal` (the shared whole-batch/whole-request
signal) — never a second, independent signal the caller must fabricate per item. Implemented as
`deriveItemSignal` (`apigen-engine-runtime/src/lib/batch.ts`): a fresh `AbortController` per item
whose abort fires on whichever happens first — the batch signal aborting (forwarded immediately) or
`itemTimeoutMs` elapsing (a `DOMException('...', 'TimeoutError')`). This composes rather than
bypasses whole-batch abort: aborting the batch signal cuts off every in-flight item; a single item's
timeout never touches its siblings. Proven by real integration tests in
`apigen-engine-runtime/src/test/batch.spec.ts` (a Layer that races `next()` against `call.signal`,
exactly how a real consumer would wire a slow external-service call to it) — including a negative
control proving a hanging item is NOT cut off when `itemTimeoutMs` is absent, isolating that the
timeout itself (not something else) causes the cutoff.

---

## 4. Streaming — included from day one, two-tier

Per-transport streaming maturity is genuinely uneven today (HTTP has true live SSE wired; MCP
collects-then-returns via `collectWithPhase`/`ApiStream`, a real SDK limitation; CLI rejects
`streaming:true` operations outright) — see `FEAT-APIGEN-SERVE-CORE-000` for the separately-tracked
epic fixing that unevenness. **This spec does not wait on that epic and is not gated by it.**

- **Tier 1 (day-1, universal):** every batch item — unary or streaming — resolves to one uniform
  terminal `BatchItemResult`, by reusing the exact `collectWithPhase`/`ApiStream` primitive MCP's
  own single-op streaming path already uses:
  ```ts
  async function invokeBatchItem(op, call, opts): Promise<BatchItemResult> {
    const result = await invoke(op.id, call, opts);
    if (!isApiStream(result)) return { index, status: 'fulfilled', value: result };
    const collected = await collectWithPhase(result);
    return collected.ok
      ? { index, status: 'fulfilled', chunks: collected.chunks }
      : { index, status: 'rejected', reason: collected.carrier.error, chunksDelivered: collected.carrier.chunksDelivered };
  }
  ```
  This works on every transport today, with zero new streaming capability required anywhere.
- **Tier 2 (capability-gated, first-class, not deferred):** where a transport already has true live
  single-op streaming (HTTP/SSE today), the same `invokeBatch` fan-out may instead be consumed
  incrementally and projected as a live tagged-multiplexed event stream (`event: item-3` /
  `item-3-complete` / `item-1-error`) using that transport's *existing* per-op live-streaming
  primitive (`sendStreamSse`) applied to N tagged sources instead of one. Nothing new conceptually
  for that transport. As `FEAT-APIGEN-SERVE-CORE-000`'s children land (wiring `projectStreamMcp`/CLI
  streaming support live), Tier 2 upgrades automatically per-transport with no batch-specific rework.

---

## 5. Cross-host portability

`PluginLanguage` already includes `'py'|'rust'|'go'|'java'`, and a Python runtime already exists
(`packages/apigen/python/apigen_python/runtime.py`) with its own separate `invoke`/`invoke_sync`,
entirely disconnected from the TS `Layer`/`MountCapability` types. This spec draws an explicit line:

- **Portable (wire-level, host-agnostic):** the `oneOf`+`discriminator` schema shape (§1),
  `BatchOptions`/`BatchItemResult` as a JSON-Schema-describable contract, `deriveBatchOperationBranch`
  (a pure schema transform over the already-host-agnostic `Operation` IR).
- **Not portable (TS-runtime-specific):** `invokeBatch`'s actual fan-out execution — calling `invoke()`
  N times with a concurrency scheduler is TS-runtime plumbing. A future non-TS host implements its
  own fan-out execution against the same wire contract; it does not depend on or port the TS function.

**F3 (closed 2026-07-27) — the wire-level IR is now concretely specified, not just asserted:**

| Concern | Wire-level IR (portable — a future non-TS host implements against this) | TS-runtime plumbing (NOT portable) |
|---|---|---|
| Request shape | `_batch/<kind>`'s `oneOf` branch object: `{operation, items, concurrency, mode, onItemError, itemTimeoutMs}` JSON Schema, built by `buildBatchKindSchema`/`branchInputSchema` (`apigen-core-client/src/lib/batch.ts`); `additionalProperties` deliberately left non-`false` (§7 open-question 3's additive-forward-compat requirement) | The TS `BatchOptions` interface (`apigen-engine-runtime/src/lib/batch.ts`) — the same fields, as a TS type, consumed only by the TS `invokeBatch` function signature |
| Response shape | `batchItemResultSchema(itemOutput)` — the `BatchItemResult<T>` JSON Schema fragment (`apigen-core-client/src/lib/batch.ts`): three `oneOf` variants (`fulfilled`+`value`, `fulfilled`+`chunks`, `rejected`+`reason`(+`chunksDelivered`)) | The TS `BatchItemResult<T>` discriminated union (`apigen-engine-runtime/src/lib/batch.ts`) — kept in sync with the wire fragment BY HAND (no JSON-Schema→TS codegen exists in this repo today, §7 open-question 1) |
| Error taxonomy | `status: 'rejected'`, `reason` (opaque wire value — the encoded `ApiError`/error), optional `chunksDelivered` (streaming, after-first-chunk only) | — |
| Concurrency semantics | `concurrency` (int, hard-capped — the cap itself, `BATCH_MAX_CONCURRENCY = 32`, is a TS-runtime-chosen constant, not part of the wire contract — a future host may choose its own ceiling), `mode` (`parallel`\|`serial`\|`chained`), `onItemError` (`continue`\|`abort`) — all three are plain wire-describable enums/numbers a non-TS host reads and implements its own scheduler against | The concurrency-limited worker-pool scheduler itself (`invokeBatch`'s `Array.from({length: workerCount}, …)` loop) — TS `Promise`-based plumbing with no wire representation |
| Per-item cancellation | `itemTimeoutMs` (number, wire-describable) | The actual `AbortController`/`AbortSignal` linkage (`deriveItemSignal`, §3/§F4) — JS-platform-specific; a non-TS host implements the equivalent of "derive a per-item cancellation token linked to the whole-request token, self-cancel after N ms" in its own idiom |

A future non-TS host (Python/Rust/Go/Java) implements its own `invokeBatch`-equivalent fan-out
executor against the LEFT column only; it never depends on or ports `apigen-engine-runtime`'s TS
`invokeBatch` function, exactly as this section originally stated — F3 makes that split concrete
enough to build against instead of reverse-engineering the TS types.

---

## 6. Explicitly out of scope for this spec (filed, non-blocking)

- **`BUG-APIGEN-CLI-ROOT-ONEOF-UNSUPPORTED-001`** — verified directly:
  `generate.ts:110-155` builds each command's flags by calling `dataSchemaProps(fnSchema)`
  (`generate.ts:118-119`), whose real implementation
  (`schema-introspect.ts:147-161`) walks a fixed chain — `schema.input.properties.data.properties`
  (`schema-introspect.ts:151-158`) — with no branch for `oneOf`/`discriminator` anywhere in that
  file. A root-level `oneOf`+`discriminator` operation input (no top-level `properties.data` at
  all) resolves that chain to `undefined` at every step, so `dataSchemaProps` returns `{ props: {},
  required: [] }` (`schema-introspect.ts:157-160`) and the generated CLI command for `_batch` gets
  zero domain flags, exactly as claimed. Fix direction (filed separately): render as N Commander
  subcommands, one per discriminator branch, each falling back to the existing flat-property flag
  logic once inside a branch. **This does not block `_batch` shipping for MCP/HTTP** — CLI catches
  up independently, the same pattern this repo already uses for CLI's existing streaming-rejection
  gap not blocking HTTP/MCP streaming.
- Per-plugin implementation inconsistencies tracked under `FEAT-APIGEN-SERVE-CORE-000` (MCP not
  composing `createInvoker`/validate-layer, etc.) — orthogonal, pre-existing, separately in flight.

---

## 7. Open questions — resolved / re-scoped in round-2 revision

1. ~~Is `oneOf`+`discriminator` well-supported end-to-end by this repo's JSON-Schema→TS codegen
   path…~~ **Resolved.** The premise doesn't hold: **there is no JSON-Schema→TS-interface codegen
   path in this repo at all**, for `_batch` or any other operation — verified by direct search
   (`grep -rn "json-schema-to-typescript\|jsonSchemaToTs\|generateTypes" packages/apigen` returns
   nothing outside `node_modules`/`dist`). `schema-builders/ts-json-schema.ts` runs the *opposite*
   direction — TS source → JSON Schema, via `ts-json-schema-generator` + `ts-morph`
   (`ts-json-schema.ts:1-14`) — and has zero references to `oneOf`/`discriminator`/`union`
   (confirmed by grep). What this repo *does* have, all verified real and all already correctly
   handling `oneOf`+`discriminator`:
   - **JSON-Schema wire shape** — `union.ts` ($ref/nominal) and `morph-walk.ts` (inline/advisory),
     per the §1.1 correction above.
   - **OpenAPI emission** — `packages/apigen/codegen/openapi` converts the composed JSON Schema to
     an OpenAPI document; OpenAPI 3.1 natively supports `oneOf`+`discriminator`, so no apigen-side
     translation logic is needed there.
   - **Runtime encode/decode (TS)** — `apigen-base-logical/src/lib/emit.ts`'s `walk()` has an
     explicit `oneOf` case (`emit.ts:171`, `201-205`, `emitOneOf` at `326+`) that emits a
     discriminator-driven ternary chain — this is codegen for runtime *transcoding glue*, not for
     type declarations.
   - **Runtime validation** — `apigen-engine-runtime/src/lib/validate-layer.ts` explicitly does
     NOT use Ajv's built-in `discriminator: true` option because Ajv enforces its own stricter
     OpenAPI-discriminator semantics that reject the `mapping` object apigen's fragment carries
     (`validate-layer.ts:60-68`) — apigen has its own compatible validation path.
   - **Runtime dispatch (TS)** — `union-codec.ts` reads `discriminator.propertyName`/`.mapping` off
     the wire value to route to the correct codec at runtime (`union-codec.ts:178-220`).

   So the honest answer is: `oneOf`+`discriminator` is well-supported for every real consumer this
   repo currently has (wire schema, OpenAPI, runtime transcode, runtime validate, runtime dispatch)
   — it does not "degrade to a looser type" anywhere, because nothing in this repo today produces a
   TS *type declaration* from JSON Schema for `_batch` to degrade in the first place. This spec
   introduces no new risk on this axis. If a JSON-Schema→TS-interface generator is added later (for
   a generated typed client, as `codegen/openapi`'s existence suggests may eventually be wanted),
   its `oneOf`+`discriminator` handling should be validated against `_batch`'s branches as one of
   its first fixtures — noted here so that future work doesn't have to rediscover this gap.

2. **Resolved (F5, closed 2026-07-27) — confirmed structural by construction, and now proven by a
   test that would fail if it weren't.** Confirmed against the loader's own source
   (`entrypoint/apigen-cli/src/lib/commands/run.ts`'s `loadUsePlugins`): it only resolves the `--use`
   specifier string to the statically-imported plugin object (`BUILTIN_USE_PLUGINS[spec]`) or
   `import()`s an external one — it never rebuilds or reimplements a plugin's `capabilities.mount`.
   The actual `capabilities.mount.operations(descriptor, opts)` call happens downstream, in each
   target plugin's own `run()` (e.g. `apigen-plugin-api-fastify/src/lib/run.ts`'s
   `collectMountedOperations`, called once at server-startup before routes are registered) — the
   SAME method a hand-wired consumer (`entrypoint/backlog/src/server.ts`'s pattern) calls directly.
   So the "structural prevention" this question asked for already existed by construction, exactly
   as recommended below; `entrypoint/apigen-cli/src/test/integration/mount-delegation-conformance.spec.ts`
   now PROVES it rather than asserting it: it `vi.spyOn`s the real
   `healthPlugin.capabilities.mount.operations` method (calling through, not replacing it) and
   asserts both the live CLI-equivalent `--use` server path and a hand-wired direct call invoke that
   exact spied reference — a reimplementation of either path would leave the spy uncalled, so the
   test is scoped to delegation, not merely output equality (an output-equality-only test can stay
   green even if a path silently forks into its own reimplementation that happens to agree today).

3. **Not resolved by this revision — deferred with a concrete recommendation, not left open.**
   `itemTimeoutMs` alone is insufficient for the interactive-cancel case this question describes
   (cancel item #3 specifically, on demand, not on a timer), and the spec's own §3 already
   half-concedes this by describing cancellation as "two distinct, composable operations." A third,
   richer shape is a real future need but is **out of scope for `_batch`'s v1** for a concrete
   reason: `BatchItemResult`/`BatchOptions` are JSON-Schema-describable wire contracts (§5), and a
   live per-item `AbortSignal` handed to a caller is not serializable over MCP/HTTP/CLI — it would
   require a second, stateful control-plane operation (e.g. `_batch/cancel-item {batchId, index}`)
   layered on top of `_batch` itself, which is a materially bigger design (batch-run identity,
   lifecycle, and a lookup table keyed by that identity) that deserves its own spec once `_batch` v1
   ships and real consumer demand for interactive per-item cancel is observed. Recommendation:
   ship v1 with `itemTimeoutMs` only, but reserve the `operation`/`items`/… branch shape (§1.1) so a
   future `batchId` field can be added additively (it is not present in v1 and its absence must not
   be relied upon by any codec/validator as a closed schema — confirm `additionalProperties` is not
   forced `false` on the branch object at implementation time, or this becomes a breaking change
   instead of an additive one).

---

## 8. Revision history

- **0.0.1** (2026-07-25, draft): initial consolidated design after iterative review — see backlog
  `FEAT-APIGEN-BULK-OPS-001` for the full discussion trail and the first architect review's F1-F6
  folds, most of which are resolved or superseded by this document's §1/§3/§5.
- **0.0.2** (2026-07-27, implemented): F1-F5 closed against `tmp/apigen-batch-architect-review.md`.
  F6 required no code change (confirmed in place, §2.1).
  - **F2** — `syntheticOp(id, descriptor, fields)` shipped in `apigen-core-client/src/lib/plugin.ts`
    (real, exported — previously only a JSDoc example reference). `apigen-plugin-health` retrofitted
    onto it in the same change, replacing its local `seg()` + hand-built `Operation` literal; its
    existing test suite (`apigen-plugin-health/src/test/plugin.spec.ts`, 18 tests) passes unmodified
    — construction path changed, behavior didn't. See §1.2.
  - **F1** — replaced the single static `_batch` mount with one synthetic op per distinct
    `Operation.kind` (`_batch/query`, `_batch/action`, …), each with a truthful per-kind `kind`/
    `safe` and an `operation` enum restricted to that kind's ids. Schema/mount derivation
    (`groupBatchableOperationsByKind`, `buildBatchKindSchema`, `buildBatchMountedOperations`,
    `deriveBatchOperationBranch`) shipped in `apigen-core-client/src/lib/batch.ts`, using
    `morph-walk.ts`'s `InlineDiscriminator`/`detectDiscriminator` (never `union.ts`) per §1.1's
    correction — refusing a `oneOf` wrapper when a kind has exactly one batchable op (a 1-branch
    union isn't a union). The execution half, `invokeBatch` — real concurrency-limited fan-out
    composing over `createInvoker`'s `InvokeFn`, `parallel`/`serial`/`chained` modes,
    `onItemError: 'continue'|'abort'` — shipped in `apigen-engine-runtime/src/lib/batch.ts` (not a
    new package; TS-runtime plumbing per §5). See §1/§3.
  - **F3** — §5 now specifies `BatchOptions`/`BatchItemResult` as a concrete wire-level JSON-Schema
    IR (a table of portable-wire-contract vs. TS-runtime-only fields), independent of the TS
    `invokeBatch` function signature. See §5.
  - **F4** — `itemTimeoutMs?: number` added to `BatchOptions` and implemented for real (not a stub):
    each fanned-out item gets its own `AbortSignal`, derived/linked from that item's shared
    `Call.signal` via `deriveItemSignal` (`apigen-engine-runtime/src/lib/batch.ts`) — composing with
    whole-batch abort rather than bypassing it. Proven by real integration tests (a Layer that races
    `next()` against `call.signal`, plus a negative control proving the cutoff requires the timeout).
    See §3.
  - **F5** — added `entrypoint/apigen-cli/src/test/integration/mount-delegation-conformance.spec.ts`,
    proving structural delegation (not output-equality alone) between the real CLI `--use` loader's
    server-startup path and a hand-wired `capabilities.mount.operations()` call, via a `vi.spyOn` on
    the real, live `healthPlugin.capabilities.mount.operations` method. §7 open-question 2 updated
    from "re-scoped" to "resolved." See §2/§7.2.
- **0.0.3** (2026-07-27, SHIPPED): closed the runtime-wiring gap between the 0.0.2 primitives and a
  real `--use batch` plugin — see §2.2. Architect-reviewed GO-WITH-CHANGES in
  `tmp/apigen-batch-rollout-review.md`, correcting `tmp/apigen-batch-rollout-design.md`'s narrower
  proposed bridge shape and its underestimate of per-host effort (Findings 1-4, all resolved as
  specified).
  - **`MountHostBridge`/`MountHostBridgeInvokeOptions`** — the widened, additive, optional third
    `MountCapability.operations()` parameter, structurally typed (duck-typed, never imported from
    `apigen-engine-runtime` — preserves the core→engine tier direction), shipped in
    `apigen-core-client/src/lib/plugin.ts` (re-exported from the package's `src/index.ts`).
    `health`/`openapi`'s existing 2-argument calls verified unaffected — both plugins' test suites
    pass unmodified. `apigen-engine-runtime/src/lib/package-invoker.ts`'s internal `UsePlugin` mount
    type widened identically (independent duck-type, not an import, per Finding 3).
  - **All four hosts** (`apigen-plugin-{api-fastify,api-express,mcp,cli-output}/src/lib/run.ts`)
    hoisted their per-package `schemasByOpId`/`fnsByOpId` to host-scoped, package-spanning
    `mergedSchemasByOpId`/`mergedFnsByOpId` maps and built a real `hostBridge` from them (via
    `createPackageInvoker`), replacing the previously always-empty `mountInvokeOpts` for hostBridge
    purposes, then threaded it through `collectMountedOperations`'s `cap.operations(descriptor, opts,
    hostBridge)` call (Finding 2).
  - **A second, previously-undiscovered gap, found and fixed while wiring batch's handler against
    real request data:** `apigen-plugin-api-fastify`/`apigen-plugin-api-express`'s `readCall`
    unconditionally hardcoded `domainArgs: {}` for ANY mount op (never reading the real request body/
    query), and `apigen-plugin-mcp`'s `readCall` unconditionally read `raw.args['data']` (the
    composed-schema convention) even though a mount's real `inputSchema` is `mountedOp.input`
    directly, never data-wrapped. Invisible before batch because `health`/`openapi` are zero-input
    mounts. Fixed in all three; `apigen-plugin-cli-output`'s analogous gap
    (`BUG-APIGEN-CLI-ROOT-ONEOF-UNSUPPORTED-001`, §6) is separately, already, and deliberately out of
    scope.
  - **`@adhd/apigen-plugin-batch`** (`packages/apigen/apigen-plugin-batch`, scaffolded via
    `@adhd/workspace-codegen-nx:plugin`) — the real, shipped mount plugin composing
    `buildBatchMountedOperations` (§1) + `invokeBatch` (§3) via the hostBridge, registered in
    `entrypoint/apigen-cli/src/lib/commands/run.ts`'s `BUILTIN_USE_PLUGINS` (`--use batch` resolves).
    A missing `hostBridge` throws a clear `ApiError('internal', …)` rather than silently no-op'ing.
    13 unit tests (`packages/apigen/apigen-plugin-batch/src/test/plugin.spec.ts`) plus 2 real e2e
    tests over a live fastify server
    (`entrypoint/apigen-cli/src/test/integration/batch-plugin-e2e.spec.ts`) — the latter proves
    partial-failure (`onItemError: 'continue'`) and concurrency are honored through the REAL hostBridge
    wiring, not a mock of it.
  - Regression-verified: `mount-delegation-conformance.spec.ts` (F5) still green unmodified;
    `apigen-core-client`/`apigen-engine-runtime`/all four host packages'/`apigen-cli`'s full test
    suites green (0 new failures). One pre-existing negative-control fixture
    (`docs/plan/apigen-serve-core/neg-control/mcp-adapter.patch`) needed its line-anchoring
    regenerated after the mcp `readCall` restructure — same semantic assertion, refreshed context.

---

## 9. Rollout dispatch decomposition

Three closeout steps remain once the in-flight `typescript-pro` rollout implementation (widening
`MountCapability.operations()` per `tmp/apigen-batch-rollout-review.md`'s Findings 1-3, hoisting
`schemasByOpId`/`fnsByOpId` across the 4 host `run.ts` files, scaffolding `apigen-plugin-batch`, and
its own real e2e tests) lands: finalize this spec against the real diff, re-review the shipped
result, then document it. This section states how to dispatch each step at the lowest token cost,
per `AGENTS.md` §13 — the same discipline this session already applied once mid-run when a
fork-based dispatch was killed and re-dispatched fresh because its prompt was fully self-contained
and the fork was paying cache-read cost for ~250k tokens of unrelated inherited history it never
used. All three steps below are equally self-contained — none needs this orchestrating session's
accumulated conversation, only specific files on disk — so **none should be forked**. Forking is
recommended nowhere in this decomposition.

### 9.0 Orchestrator-side gate (not a dispatch): verify before trusting the implementation agent's self-report

Before dispatching 9.1, the orchestrating session must itself do what `AGENTS.md`'s "Mandatory
Verification"/"Zero Deflection" rules already require — an agent's own "done" claim is not
evidence:

- `git status` / `git diff --stat` against the worktree the implementation agent used, to see the
  actual changed-file set (not the agent's prose description of it).
- Re-run the real test targets for every touched project via `npx nx affected -t test` (never a
  targeted `nx test <project>` alone, per this repo's `DEBT-PROCESS-AFFECTED-TEST-001` note) and
  read the exit code, not a `grep`'d "passed" string.
- If `apigen-plugin-batch` was scaffolded as a new package, confirm it exists via
  `@adhd/workspace-codegen-nx` (not a hand-created directory) by checking its `project.json` tags,
  and run `npx nx run apigen-plugin-batch:verify-dist-load` if that target exists.
- Only once this is green does 9.1 get dispatched — dispatching it against an unverified diff risks
  finalizing a spec description of code that doesn't actually work, which is exactly the ordering
  mistake this section exists to prevent one level up (documenting before confirming real).

### 9.1 Finalize the spec

- **Dispatch type: fresh, non-forked.** The task is "reconcile one file against one diff" — fully
  self-contained once the diff and this spec are named; nothing in this session's prior turns
  (backlog triage, the earlier mis-ordered doc-steward run, unrelated packages) is load-bearing
  context, and re-deriving it inside a fork would cost strictly more cache-read tokens than simply
  naming the right files.
- **Minimum sufficient context to hand it:**
  - `docs/spec/apigen/BATCH_0.0.1.md` (this file, current rev 0.0.2) — the doc to update in place.
  - The real diff: `git diff main...<implementation-branch-or-worktree>` (or the merge-base diff if
    already merged) scoped to the paths this spec already names: `apigen-core-client/src/lib/{plugin,batch}.ts`,
    `apigen-engine-runtime/src/lib/batch.ts`, the four hosts'
    `apigen-plugin-{api-fastify,mcp,cli-output,api-express}/src/lib/run.ts`, and the new
    `packages/apigen/apigen-plugin-batch/` package tree.
  - `tmp/apigen-batch-rollout-review.md` (the architect review this section's own header cites) —
    so the finalization pass can confirm Findings 1-3 (hostBridge shape, per-host
    `schemasByOpId`/`fnsByOpId` hoist, structural-not-imported typing) landed as specified, not just
    that *something* changed in those files.
  - Explicit instruction: add a new `0.0.3` entry to §8's revision history describing what actually
    shipped vs. what §1-§5 currently describe, and correct any §1-§5 prose that drifted from the
    real landed shape (e.g. if the hostBridge's final field names differ from Finding 1's proposed
    sketch) — do not touch §0/§6/§7/§9.
- **Parallelizable with:** nothing else in this decomposition (it is the first of three strictly
  sequential steps) — but it has zero dependency on 9.3's doc-steward scope, so if a human wanted to
  independently kick off a non-apigen-batch task in parallel, this step's own dispatch would not
  block it.
- **Ordering justification:** must run after 9.0's verification (finalizing a spec against unverified
  code risks documenting a diff that doesn't actually pass its own tests) and before 9.2 (the
  reviewer needs the *finalized* spec, not the stale 0.0.2 draft, as its ground truth — reviewing
  against a doc that still describes the pre-implementation design would waste the reviewer's pass
  re-discovering drift this step already exists to fix).

### 9.2 Re-review

- **Dispatch type: fresh, non-forked.** Same reasoning as 9.1 — an architect-reviewer given the
  finalized spec, the diff, and the prior review as inputs needs no session history; this mirrors
  the review-then-implement pattern already dispatched fresh twice earlier this session with no
  fork.
- **Minimum sufficient context to hand it:**
  - `docs/spec/apigen/BATCH_0.0.1.md` as finalized by 9.1 (rev 0.0.3) — the design to check the diff
    against.
  - The same real diff scoped in 9.1.
  - `tmp/apigen-batch-rollout-review.md` — so the reviewer checks its own four prior findings were
    actually resolved (hostBridge widened per Finding 1, per-host hoist done per Finding 2,
    structural typing preserved per Finding 3, Option A confirmed over Option B per Finding 4)
    rather than re-deriving the whole design from scratch.
  - Explicit instruction: verdict format matching the prior review (`GO` / `GO-WITH-CHANGES` /
    `NO-GO`, one "Summary of required changes" section if not a clean `GO`), written to a new
    `tmp/apigen-batch-rollout-review-2.md` (never overwrite the first review — it remains the
    historical record 9.1 already cited).
- **Parallelizable with:** nothing — strictly sequential after 9.1 (needs the finalized spec as its
  ground truth) and strictly before 9.3 (doc-steward's entire value proposition is verifying claims
  against real, running code; running it before this review confirms the shipped implementation
  matches the design is exactly the ordering mistake this session already made once and corrected).
- **Ordering justification:** this is the one step that could theoretically overlap with 9.3 if
  9.3 were scoped to touch only files *outside* what 9.2 reviews — but doc-steward's stated scope
  (`packages/apigen/*`, `entrypoint/apigen-cli`, `docs/apigen/`, `docs/spec/apigen/`) fully overlaps
  the reviewed surface, so running it concurrently risks it documenting a finding 9.2 is about to
  flag as wrong. Sequential is the real dependency here, not caution for its own sake.

### 9.3 Document

- **Dispatch type: fresh, non-forked.** Same reasoning again — doc-steward's job is bounded by an
  explicit path scope, not by this session's history.
- **Minimum sufficient context to hand it:**
  - Explicit scope boundary: `packages/apigen/*`, `entrypoint/apigen-cli`, `docs/apigen/`,
    `docs/spec/apigen/` — nothing outside these paths.
  - `docs/spec/apigen/BATCH_0.0.1.md` at its final (9.1-finalized, 9.2-approved) revision.
  - `tmp/apigen-batch-rollout-review-2.md` (9.2's output) — specifically its verdict, so doc-steward
    knows the feature is confirmed real before it writes documentation asserting it is.
  - Explicit instruction: verify every doc claim against the actual running code in the scoped paths
    (its own stated value proposition) before writing it — update READMEs/CHANGELOGs/`SPEC.md` for
    `apigen-core-client`, `apigen-engine-runtime`, `apigen-plugin-batch`, and the four host packages
    touched by the hoist, plus `docs/apigen/SPEC.md`'s own batch cross-reference if one is needed.
- **Parallelizable with:** nothing before it in this chain (must follow 9.2's `GO`/`GO-WITH-CHANGES`
  verdict — a `NO-GO` sends the implementation back for fixes and reschedules 9.1-9.3, not just
  9.3). Once dispatched, 9.3 is the terminal step; nothing in this decomposition follows it.
- **Ordering justification:** this is the step that was run out of order once already this session
  (doc-steward dispatched before the feature was confirmed real) and corrected — restating the fix
  here as the enforced order, not a suggestion, since doc-steward documenting an unverified
  implementation is the exact failure mode `AGENTS.md` §7's "Proving features actually work" section
  warns about (green claims that turn out to hide real bugs on first real-component contact).

**Net shape:** 9.0 (orchestrator, no dispatch) → 9.1 (fresh dispatch) → 9.2 (fresh dispatch) → 9.3
(fresh dispatch), fully serial, zero forks. The token saving here isn't from parallelizing three
steps that are genuinely independent (they aren't — each consumes the prior step's output as its
ground truth) but from keeping every dispatch fresh instead of forked: each of 9.1-9.3 pays only for
the specific files it's pointed at, never for this session's full accumulated history, which is the
one lever available when the real dependency graph is a straight line.
