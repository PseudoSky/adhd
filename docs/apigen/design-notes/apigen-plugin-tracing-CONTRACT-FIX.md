# Implementation Spec — FEAT-APIGEN-TRACING (Contract Fix): transport seam + streaming quarantine

**Status:** PROPOSED (corrective spec — supersedes the parts of
`apigen-plugin-tracing-IMPLEMENTATION-SPEC.md` that this document contradicts).
**Owner:** architecture.
**Branch under spec:** `feat/apigen-plugin-tracing`, HEAD `c887b1b8`, base `bb832e7b`
(worktree `.worktrees/impl-apigen-tracing`).
**Drives:** the blind-review HIGH (`apigen.transport` always `undefined`) and MEDIUM
(streaming branch unreachable) defects, plus four manifest/hygiene items.
**Convention:** this file lives beside `apigen-plugin-tracing-IMPLEMENTATION-SPEC.md` and
`ir-cache-IMPLEMENTATION-SPEC.md` in `docs/apigen/design-notes/` — the established home for
apigen implementation specs, and the same directory as the original tracing spec this
document corrects.

> **Why a new file rather than a `## Revision` block inside the original spec.** The original
> spec's §7 prescribed the very tests that fabricated the transport field
> (`plugin.spec.ts:83-92, 262-272`); the correction changes the *contract* (the runtime `Call`)
> and the *test strategy* (real-transport e2e), so it is a distinct work order, not an addendum
> to a spec that is now historical. The `ir-cache` design note shows the in-place `## Revision 2`
> precedent is acceptable, but that revision corrected a single spec's own sections; this
> document governs a cross-package engine contract with a blast radius beyond the plugin.

---

## 0. Verified facts (every anchor below was read on the branch)

| # | Fact | Anchor |
|---|------|--------|
| F1 | The layer reads `call.transport` and stamps it as `${serviceName}.transport` (the emitting product's namespace). | `packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts` |
| F2 | The runtime `Call` the layer actually receives has **no `transport` field**: fields are `operation`, `ctx`, `envelope`, `domainArgs`, `signal?`. | `packages/apigen/apigen-engine-runtime/src/lib/invoke.ts:68-82` |
| F3 | `dispatchForPlan` builds `fullCall = { ...call, operation, ctx }` and threads **that** to `invoke` (the layer stack); it never adds `transport`. `plan.transport` is stamped only onto the separate `coreCall` handed to `mountHandler`. | `…/apigen-engine-runtime/src/lib/dispatch-for-plan.ts:87-94, 104-121, 124` |
| F4 | `adaptCoreLayer` passes the runtime `Call` through (`Object.assign(call, { data })`) — it neither supplies nor strips `transport`. | `…/apigen-engine-runtime/src/lib/package-invoker.ts:133-141` |
| F5 | All four `readCall` implementations return only `{ envelope, domainArgs, signal? }` — none carries `transport`. | mcp `…/apigen-plugin-mcp/src/lib/run.ts:281-302`; fastify `…/apigen-plugin-api-fastify/src/lib/run.ts:218-266`; express `…/apigen-plugin-api-express/src/lib/run.ts:176-224`; cli `…/apigen-plugin-cli-output/src/lib/run.ts:532-535` |
| F6 | All four transports route through the SAME primitive: `registerRoute(plan, (call) => dispatchForPlan(plan, invoke, call, opts))`. | mcp `:550-552` (+ mount `:630-632`); fastify `:428-430` (+ `:491-493`); express `:374-376` (+ `:434-436`); cli `:672-674` (+ `:740-742`) |
| F7 | Each adapter stamps its own transport at `buildOpPlan` time (`plan.transport`), never a literal downstream. | mcp `:521-526`, `:598`; fastify `:421-426`, `:490`; express `:367-372`, `:433`; cli `:217`, `:735-739` |
| F8 | `toOtelAttributes` silently drops a non-primitive (i.e. `undefined`) value, so an absent transport is not an error — the attribute is simply missing. | `plugin.ts:59-70` |
| F9 | `Next = () => Promise<LayerResult>` and `LayerResult = unknown \| AsyncIterable<unknown>`; `Layer = (call, next) => Promise<LayerResult>`. `next()` therefore always returns a **Promise**; an iterable can only be a *resolved* value. | `invoke.ts:94, 102, 121` |
| F10 | `createInvoker` composes `layers.reduceRight((inner, layer) => () => layer(call, inner), coreService)`; the composed call returns a Layer's `Promise<LayerResult>`. | `invoke.ts:202-207` |
| F11 | The plugin branches on the **unresolved** promise: `isAsyncIterable(next())` — always `false`. | `plugin.ts:193-198` |
| F12 | `isAsyncIterable` is a correct guard for a resolved object exposing `Symbol.asyncIterator`. | `plugin.ts:54-57` |
| F13 | The only integration test hand-fabricates `transport: 'mcp'` on a `Call` cast `as never`; the unit harness sets `transport: init.transport ?? 'mcp'`; the streaming tests pass a **bare** `AsyncIterable` straight into `makeTraceLayer` via `() => source()`. | `plugin.spec.ts:83-92`, `:170, 189, 210`, `:262-272` |
| F14 | Reserved keys `${serviceName}.op` / `${serviceName}.transport` / `trace_id` are spread **last**, so they always win — a caller `envelopeAttrs` key can never shadow them. | `plugin.ts:220-225` |
| F15 | `makeTracingPlugin` is exported (barrel `src/index.ts:2`) and unit-tested, but both consumers import the singleton. | `src/index.ts:2`; `entrypoint/backlog/src/server.ts:50, 878, 906`; `entrypoint/apigen-cli/src/lib/commands/run.ts:41, 170` |
| F16 | `entrypoint/apigen-cli/package.json` pins exact `"0.1.0"`; `entrypoint/backlog/package.json` uses `"^0.1.0"`. | `entrypoint/apigen-cli/package.json:37`; `entrypoint/backlog/package.json:17` |
| F17 | Tracing's `nx-release-publish` omits `verify-dist-load`, `dist-manifest`, `publish-hygiene` and uses a literal `packageRoot`. The canonical sibling (`apigen-plugin-logger`) carries all three and `{projectRoot}/dist`; `apigen-plugin-ir-cache` shares tracing's drift. | `…/apigen-plugin-tracing/project.json:22-27`; `…/apigen-plugin-logger/project.json:13-24`; `…/apigen-plugin-ir-cache/project.json:22-27` |
| F18 | cli-output explicitly rejects a streaming plan and a stray `ApiStream` result; no live consumer produces a stream. | `…/apigen-plugin-cli-output/src/lib/run.ts:779-786`, `:543-548` |
| F19 | The four adapters each build a runtime `Call` for the `MountHostBridge` fan-out with no `transport`. | mcp `:568-579`; fastify `:456-467`; express `:399-410`; cli `:690-701` |

---

## 1. Strategy

**One contract fix, specified once.** `transport` is a *runtime-supplied* property of the
engine's `Call`, stamped at the single dispatch choke point (`dispatchForPlan`) from the
already-resolved `plan.transport`, and guaranteed present on every `Call` a layer observes.
No plugin hunts for it; no adapter invents it; no transport is special-cased. Because every
transport reaches the layer stack through the same `registerRoute → dispatchForPlan → invoke`
path (F6), fixing the seam once fixes all four. This is required by **adhd ADR-0002**
("correct the source, never work around a functional gap"): the field must be supplied by the
engine (source), not looked up by the tracing plugin (consumer).

**Streaming: quarantine, not a live branch.** `next()` returns a `Promise` (F9, F10); an
`AsyncIterable` can only be a *resolved* value. To branch on it you must `await next()` — but
the unary span must open **before** the body (the hang-visibility property the spec and
`plugin.spec.ts:118-142` deliberately guard). Awaiting first would destroy that property;
awaiting inside a span would (i) close the span at stream-obtain and (ii) duplicate
`traceStream`'s own `${spanName}.start`. No transport produces an iterable today (F18; the
only live consumer's real ops are non-streaming). Therefore the streaming branch is
**unreachable dead code to be quarantined**: `traceStream` is retained and unit-tested in
isolation, the layer no longer pretends to reach it, and a follow-up is filed for the day the
harness returns iterables. This is an explicit, documented limitation — **not** an env-var /
feature toggle (adhd ADR-0001).

**Item dispositions** (detail in §7):
1. `project.json` gate omission — **drift, fix** (new publishable package; adhd ADR-0003 D3).
2. `envelopeAttrs` shadowing — **bug, fix** (reserved keys must win).
3. `makeTracingPlugin` — **keep + document + test** (advertised config surface; already tested).
4. version-specifier drift — **drift, fix** (`0.1.0` → `^0.1.0`).
5. `pnpm-lock` `@lancedb/lancedb` `cpu` change — **unrelated, revert** (detail UNVERIFIED).

---

## 2. Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `packages/apigen/apigen-engine-runtime/src/lib/invoke.ts` | modify | 220 | 40 |
| `packages/apigen/apigen-engine-runtime/src/lib/dispatch-for-plan.ts` | modify | 125 | 60 |
| `packages/apigen/apigen-engine-runtime/src/lib/transport-adapter.ts` | modify | 70 | 30 |
| `packages/apigen/apigen-plugin-mcp/src/lib/run.ts` | modify | 160 | 40 |
| `packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts` | modify | 120 | 30 |
| `packages/apigen/apigen-plugin-api-express/src/lib/run.ts` | modify | 120 | 30 |
| `packages/apigen/apigen-plugin-cli-output/src/lib/run.ts` | modify | 140 | 30 |
| `packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts` | modify | 160 | 90 |
| `packages/apigen/apigen-plugin-tracing/src/lib/plugin.spec.ts` | modify | 220 | 260 |
| `packages/apigen/apigen-engine-runtime/src/lib/*.spec.ts` (new/extended) | modify | 60 | 200 |
| `packages/apigen/apigen-plugin-tracing/project.json` | modify | 0 | 20 |
| `entrypoint/apigen-cli/package.json` | modify | 0 | 10 |
| `pnpm-lock.yaml` | modify (revert hunk) | 0 | 20 |
| `packages/apigen/apigen-plugin-tracing/README.md` | modify | 40 | 60 |

Real-transport e2e host: the existing `entrypoint/backlog` mounts are the natural vehicle
(`server.ts:860-912` already passes `tracingPlugin`), but the e2e must drive the transport
adapter boundary directly (see §7 AC0.3) so it exercises `dispatchForPlan` without booting the
whole backlog store.

---

## 3. Interface changes

### `apigen-engine-runtime/src/lib/invoke.ts` — runtime `Call`

```typescript
// BEFORE (F2)
export interface Call {
  operation: Pick<Operation, 'id'> & Partial<Operation>;
  ctx: LayerContext;
  envelope: Record<string, unknown>;
  domainArgs: Record<string, unknown>;
  signal?: AbortSignal;
}

// AFTER
import type { Operation, Transport } from '@adhd/apigen-core-client';
export interface Call {
  operation: Pick<Operation, 'id'> & Partial<Operation>;
  ctx: LayerContext;
  envelope: Record<string, unknown>;
  domainArgs: Record<string, unknown>;
  /**
   * The transport this call arrived on (F3 single source: stamped by
   * `dispatchForPlan` from `plan.transport`). Guaranteed present on every call a
   * Layer observes — never optional, so a Layer can trust it (no silent undefined).
   */
  transport: Transport;
  signal?: AbortSignal;
}
```

### `apigen-engine-runtime/src/lib/dispatch-for-plan.ts` — stamp + narrow the inbound type

```typescript
// BEFORE (F3)
export async function dispatchForPlan(
  plan: OpPlan, invoke: InvokeFn,
  call: Omit<RuntimeCall, 'operation' | 'ctx'>, opts: InvokeOptions
): Promise<LayerResult> {
  const fullCall: RuntimeCall = { ...call, operation: { id: plan.op.id }, ctx: new LayerContext() };
  …

// AFTER
export async function dispatchForPlan(
  plan: OpPlan, invoke: InvokeFn,
  call: Omit<RuntimeCall, 'operation' | 'ctx' | 'transport'>, opts: InvokeOptions
): Promise<LayerResult> {
  const fullCall: RuntimeCall = {
    ...call,
    operation: { id: plan.op.id },
    ctx: new LayerContext(),
    transport: plan.transport,   // ← the single stamp (F3/F7); the mount coreCall keeps its own
  };
  …
```

### `apigen-engine-runtime/src/lib/transport-adapter.ts` — the port

```typescript
// BEFORE (F5/F6)
registerRoute(plan: OpPlan, dispatch: (call: Omit<Call, 'operation'|'ctx'>) => Promise<LayerResult>): void;
readCall(raw: Raw, plan: OpPlan): Omit<Call, 'operation'|'ctx'> | Promise<Omit<Call, 'operation'|'ctx'>>;

// AFTER — transport is runtime-stamped, so it is NOT part of the adapter's inbound contract
registerRoute(plan: OpPlan, dispatch: (call: Omit<Call, 'operation'|'ctx'|'transport'>) => Promise<LayerResult>): void;
readCall(raw: Raw, plan: OpPlan): Omit<Call, 'operation'|'ctx'|'transport'> | Promise<Omit<Call, 'operation'|'ctx'|'transport'>>;
```

The same `Omit<…, 'transport'>` narrowing is applied at every adapter site that spells the
inbound call: mcp `:203, :232, :250, :281`; fastify `:192, :218`; express `:157, :176`;
cli `:495, :522, :532`.

### Host-bridge call literals (blast radius the review did not name)

Because `RuntimeCall.transport` becomes **required**, the four `MountHostBridge.invoke`
literals (F19) must stamp their own transport. The value is the adapter's own literal, which
it already knows:

```typescript
// mcp run.ts:568-579
hostInvoke(fnName, { operation: { id: fnName }, ctx: new LayerContext(),
  domainArgs: call.domainArgs, envelope: call.envelope, signal: call.signal,
  transport: 'mcp' }, opts as InvokeOptions)
// fastify:456-467 → transport: 'http'   express:399-410 → transport: 'http'   cli:690-701 → transport: 'cli'
```

A *fifth* construction site lives outside the adapters: `apigen-plugin-batch/src/lib/plugin.ts`
builds a `calls: RuntimeCall[]` array (`plugin.ts:194-205`) and must stamp
`transport: call.transport` onto each entry once `transport` is required (see Segment B).

### `apigen-plugin-tracing/src/lib/plugin.ts` — attrs order (item 2)

```typescript
// BEFORE (F14) — envelope can shadow the reserved keys
const attrs = {
  [`${serviceName}.op`]: call.operation.id,
  [`${serviceName}.transport`]: call.transport,
  trace_id: traceId,
  ...pickEnvelope(call.envelope, envelopeAttrs),
};

// AFTER — reserved keys win; caller fields may not overwrite the correlation id
const attrs = {
  ...pickEnvelope(call.envelope, envelopeAttrs),
  [`${serviceName}.op`]: call.operation.id,
  [`${serviceName}.transport`]: call.transport,
  trace_id: traceId,
};
```

### `apigen-plugin-tracing/src/lib/plugin.ts` — layer branch (streaming quarantine)

```typescript
// BEFORE (F11) — branch on the unresolved promise; always false
return withTrace(traceId, () => {
  const downstream = next();
  return isAsyncIterable(downstream)
    ? traceStream(downstream, spanName, attrs)
    : traceUnary(downstream, spanName, attrs, handle);
});

// AFTER — the harness's next() is always a Promise (F9/F10); a Layer cannot
// synchronously know whether its value is a stream, and awaiting first would break
// the unary span-before-body invariant. Span the unary path unconditionally; the
// streaming tracer is quarantined (see §4). `Promise.resolve(next())` — not a bare
// `next()` — because `Next` is the broad union `() => Promise<Result> |
// AsyncIterable<Chunk>` (core-client `plugin.ts:153`) while `traceUnary` takes a
// `Promise<Result>`; the literal `traceUnary(next(), …)` is a TS2345 (the union is not
// assignable to `Promise<Result>`), and `Promise.resolve` re-narrows it.
return withTrace(traceId, () => traceUnary(Promise.resolve(next()), spanName, attrs, handle));
```

`traceStream` stays in the file under an explicit quarantine banner
(`/** QUARANTINED — unreachable under the current Next contract; see CONTRACT-FIX §4. */`) and
gains a direct unit test. It is **not** deleted: it is the correct end-state logic, and
deleting it would discard the chunk-count design along with the branch that cannot yet reach
it.

### `apigen-plugin-tracing/project.json` (item 1)

```jsonc
// BEFORE (F17)
"nx-release-publish": { "dependsOn": ["build", "test"],
  "options": { "packageRoot": "packages/apigen/apigen-plugin-tracing/dist" } }

// AFTER — matches the canonical sibling apigen-plugin-logger (F17)
"nx-release-publish": {
  "dependsOn": ["build", "test", "verify-dist-load", "dist-manifest", "publish-hygiene"],
  "options": { "packageRoot": "{projectRoot}/dist" }
}
```

### `entrypoint/apigen-cli/package.json` (item 4)

```jsonc
// BEFORE (F16)
"@adhd/apigen-plugin-tracing": "0.1.0"
// AFTER
"@adhd/apigen-plugin-tracing": "^0.1.0"
```

---

## 4. Behavioral changes

- **`dispatchForPlan`**: every dispatched (source or mount) call now carries
  `transport === plan.transport`. This is the whole contract fix. The mount branch's separate
  `coreCall.transport` (F3) is unchanged.
- **Layer stack**: `adaptCoreLayer` (F4) already passes the call through by reference, so
  `transport` survives with no change to that function.
- **Tracing layer**: `${serviceName}.transport` is present on every emitted record, for every
  transport, source and mount.
- **`envelopeAttrs`**: a caller-supplied envelope key equal to `${serviceName}.op`/`${serviceName}.transport`/
  `trace_id` no longer overwrites the reserved value.
- **Streaming**: unchanged in observable effect for any op the harness actually serves
  (all unary). A stream, were one served, is spanned only to the point the iterable is
  obtained; it is **not** chunk-traced. Documented in the README and filed as a follow-up.
- **Host bridges**: the batch fan-out (`MountHostBridge.invoke`) reports the originating
  transport instead of `undefined`; no behavior change beyond the added field.

**Do NOT touch:** `createInvoker`'s composition order (F10); `validate-layer`; the mount
`coreCall` adaptation (F3); `traceUnary`'s try/catch/finally shape; `toOtelAttributes`.

---

## 5. Independent segments

### Segment A — runtime `Call.transport` + `dispatchForPlan` stamp

- **Files:** `invoke.ts`, `dispatch-for-plan.ts`, `transport-adapter.ts`
- **Dependencies:** none
- **Read tokens:** ~415 · **Output tokens:** ~130
- **Required context:** read `invoke.ts:63-102`, `dispatch-for-plan.ts:79-125`,
  `transport-adapter.ts:36-69` only.

### Segment B — four adapters and the batch plugin narrow the inbound type + stamp host bridges

- **Files:** mcp `run.ts`, fastify `run.ts`, express `run.ts`, cli `run.ts`, batch `plugin.ts`
- **Dependencies:** Segment A (the `Call` shape and port signature must exist first)
- **Read tokens:** ~540 · **Output tokens:** ~130
- **Required context:** for each adapter read only the `registerRoute`/`readCall`/`getDispatch`
  region and the `hostBridge` literal (mcp `:199-302` + `:561-585`; fastify `:189-266` +
  `:455-473`; express `:154-224` + `:398-416`; cli `:511-535` + `:688-707`). For batch, read
  the `calls: RuntimeCall[]` literal (`plugin.ts:194-205`) — a *fifth* construction site that
  builds `RuntimeCall` objects and must stamp `transport` too.

### Segment C — tracing layer fixes

- **Files:** `plugin.ts`
- **Dependencies:** Segment A (the `Call.transport` type)
- **Read tokens:** ~120 · **Output tokens:** ~90
- **Required context:** read `plugin.ts:166-200` and `:245-256` only.

### Segment D — tests (engine contract + tracing + real-transport e2e)

- **Files:** new `apigen-engine-runtime` spec; `plugin.spec.ts`
- **Dependencies:** Segments A, B, C
- **Read tokens:** ~220 · **Output tokens:** ~320
- **Required context:** read `plugin.spec.ts:1-92, 246-289` and the four adapters' test seams.

### Segment E — manifests + lockfile + docs

- **Files:** `project.json`, `apigen-cli/package.json`, `pnpm-lock.yaml`, tracing `README.md`
- **Dependencies:** none
- **Read tokens:** 0 · **Output tokens:** ~110
- **Required context:** none.

---

## 6. Execution strategies

**Segment A**
1. In `invoke.ts`, import `Transport` alongside `Operation`; add required `transport: Transport`
   to `interface Call` with the doc comment above.
2. In `dispatch-for-plan.ts`, change the `call` param type to
   `Omit<RuntimeCall,'operation'|'ctx'|'transport'>` and add `transport: plan.transport` to the
   `fullCall` literal.
3. In `transport-adapter.ts`, change both occurrences of `Omit<Call,'operation'|'ctx'>` to
   include `'transport'`.
4. Do NOT alter the mount `coreCall` or `createInvoker`.

**Segment B**
1. Update every spelled `Omit<RuntimeCall,'operation'|'ctx'>` in the four adapters to add
   `'transport'` (anchor list in §3).
2. Add `transport: '<mcp|http|cli>'` to the four `hostBridge.invoke` call literals (F19). The
   literal is the adapter's existing `buildOpPlan` transport.
3. Run `npx nx typecheck apigen-plugin-mcp apigen-plugin-api-fastify apigen-plugin-api-express apigen-plugin-cli-output` — **the compiler is the acceptance test for this segment** (a missed construction site is a type error).
4. Do NOT touch `readCall`'s returned fields (`envelope`/`domainArgs`/`signal` stay).

**Segment C**
1. Reorder `attrs` so `pickEnvelope` spreads first (item 2).
2. Replace the branch with `return withTrace(traceId, () => traceUnary(Promise.resolve(next()), spanName, attrs, handle));` — the bare `next()` literal does not typecheck (TS2345): `Next` is the broad union `() => Promise<Result> | AsyncIterable<Chunk>` while `traceUnary` takes a `Promise<Result>`; `Promise.resolve` re-narrows.
3. Put the `traceStream` quarantine banner on the function; leave its body intact.
4. Do NOT change `traceUnary`, `withSpan`, or the `TraceHandle` seeding.

**Segment D**
1. Add an engine-runtime unit test: `dispatchForPlan(plan, spyInvoke, call, opts)` where
   `spyInvoke` captures the `fullCall`; assert `fullCall.transport === plan.transport` for a
   source plan and for a mount plan.
2. Rewrite `plugin.spec.ts` integration to build its `Call` **without** the `as never` cast
   (transport is now real) OR, better, drive the four transports (AC0.3).
3. Retarget the streaming tests per §8.
4. Do NOT delete an assertion to make a branch pass (BL-225).

**Segment E**
1. Apply the `project.json` and `apigen-cli/package.json` edits verbatim.
2. Revert the `@lancedb/lancedb@0.31.0` `cpu` hunk in `pnpm-lock.yaml` (§7 item 5) — and, if
   reverting by hand is unsafe, restore the file from base and re-run `pnpm install` from a
   clean tree, then verify only the tracing-related importers changed.
3. Update the README streaming row (§9).

**Final gate:** `npx nx affected -t build,typecheck,test,lint` must be green, and
`node scripts/smoke-test.mjs` (sox-ecosystem) is **not** applicable to this repo — use the
repo's own gate. Run `node tools/check-suite-tree-state.mjs` for every project whose suite you
quote (or run in an isolated worktree).

---

## 7. Acceptance criteria (binary, observable)

### AC0 — transport seam (HIGH)

- **AC0.1** `RuntimeCall` has required `transport: Transport`. *Observable:* `npx nx typecheck apigen-engine-runtime` exits 0, and `rg "Omit<RuntimeCall, 'operation' \| 'ctx'>"` returns **zero** hits across `packages/apigen`.
- **AC0.2** `dispatchForPlan` stamps `fullCall.transport = plan.transport` for both branches. *Observable:* a new engine-runtime unit test captures the `Call` passed to `invoke` and asserts `transport === 'mcp'` when `plan.transport === 'mcp'`; goes RED if the stamp is removed.
- **AC0.3 — REAL-TRANSPORT E2E (the test that would have caught the HIGH).** For **each** of mcp, fastify, express, cli-output: boot the real transport with the tracing plugin installed, dispatch one operation end to end, flush the sox-telemetry sink, and assert the durable JSONL record `<serviceName>.<op>.start` carries `'<serviceName>.transport'` equal to that transport's literal — `'mcp'`, `'http'`, `'http'`, `'cli'` respectively — **and never `undefined`**. The concrete e2e installs the apigen-namespaced singleton (`usePlugins: [tracingPlugin]`, `serviceName: 'apigen'`), so the asserted keys are `apigen.<op>.start` / `apigen.transport`; the backlog transport emits the same seam under `adhd.*` (asserted in `entrypoint/backlog/src/server.tracing-required.spec.ts`).
  - fastify/express: `run()` on an ephemeral port + a real `fetch`/supertest request (or `app.inject` for fastify — still the real adapter path).
  - mcp: drive the built `CallToolRequestSchema` handler (or a stdio round-trip) through the real `McpTransportAdapter`.
  - cli: invoke `apigen-plugin-cli-output`'s `run()` with a real `argv` and a real schema.
  - *Observable:* four assertions, one per transport, all reading the emitted record — not a fabricated `Call`.
  - *Teeth:* with the Segment-A stamp removed, all four go RED (`<serviceName>.transport` missing).
- **AC0.4** No plugin special-casing: `plugin.ts` has no import of `dispatchForPlan`/`OpPlan` and reads transport only via `call.transport`. *Observable:* `rg "dispatchForPlan|OpPlan" packages/apigen/apigen-plugin-tracing` returns zero hits.

### AC1 — project.json gates (item 1)

- **AC1** `apigen-plugin-tracing/project.json` `nx-release-publish.dependsOn` contains `verify-dist-load`, `dist-manifest`, `publish-hygiene`, and `packageRoot === "{projectRoot}/dist"`. *Observable:* `npx nx show project apigen-plugin-tracing --json` resolves the three targets; a release dry-run reaches them.
- Drift in `apigen-plugin-ir-cache` and `apigen-plugin-ts-types` is **out of scope** and filed as a follow-up (item 9).

### AC2 — envelopeAttrs shadowing (item 2)

- **AC2** With `envelopeAttrs` naming the reserved keys and an envelope carrying those same
  keys, the emitted record's `trace_id` equals the minted `TraceHandle.traceId`,
  `${serviceName}.op` equals the operation id, and `${serviceName}.transport` equals the call's
  transport. (The concrete unit test drives `serviceName: 'checkout'` and asserts
  `checkout.op` / `checkout.transport`.)
  *Observable:* a unit test asserting each reserved field is the plugin's value, not the envelope's.
  *Teeth:* RED under the current (spread-last) order.

### AC3 — makeTracingPlugin (item 3)

- **AC3** `makeTracingPlugin` is documented as the configured entry point in the README and
  remains covered by a test proving a configured `serviceName`/`envelopeAttrs` takes effect.
  *Observable:* the existing `plugin.spec.ts:216-230` tests stay green; the README's Usage
  section names it. The singleton remains the zero-config path the two consumers use.

### AC4 — version specifier (item 4)

- **AC4** `entrypoint/apigen-cli/package.json` pins `"@adhd/apigen-plugin-tracing": "^0.1.0"`.
  *Observable:* the manifest line reads `^0.1.0`; `pnpm install` relocks only that importer
  specifier (no version resolution change), and the lockfile diff is limited accordingly.

### AC5 — lockfile (item 5)

- **AC5** `git diff bb832e7b...HEAD -- pnpm-lock.yaml` contains no change to the
  `@lancedb/lancedb@0.31.0` `cpu` field. *Observable:* the diff hunk is gone. If a clean
  revert is impossible, the PR description must state why it is retained.

---

## 8. Test changes (BL-225 — no assertion weakened)

The current suite asserts a contract the runtime does not honour (F13). The fix retargets the
assertions to the real contract; it does not remove them.

1. **Transport integration (`plugin.spec.ts:251-289`)** — replace the hand-fabricated `Call`
   (`transport: 'mcp'` on an `as never` cast) with the real-transport e2e (AC0.3). Keep an
   assertion that the record carries `${serviceName}.transport`, now proven against a real transport.
2. **Streaming unit tests (`:164-214`)** — currently call `makeTraceLayer()(call, () => source())`,
   handing the layer a bare `AsyncIterable`, which `Next` never returns. Split them:
   - **`traceStream` direct tests**: call `traceStream(source(), spanName, attrs)` directly and
     assert chunks pass through unchanged, `.finish` carries `chunks`, and a mid-stream throw
     emits `.error` with the partial count. This preserves the chunk-count design's coverage.
   - **Layer quarantine test**: `makeTraceLayer()(call, () => Promise.resolve(source()))` — a
     `next` honouring `Next` (a Promise resolving to an iterable) — asserts the layer **does not**
     fabricate a span it cannot close (no `traceStream` lifecycle), documenting the limitation.
   - **Negative control**: assert the old eager form would be wrong — e.g. a test that fails if
     the layer calls `isAsyncIterable` on the unresolved promise. This is the RED-if-reverted
     tooth for the streaming decision.
3. **The hang-visibility test (`:118-142`) is preserved unchanged** — it guards the property
   that makes option (b) (await-before-span) unacceptable.
4. **New engine-runtime test** — the AC0.2 stamp test.
5. No test may be skipped or have an assertion deleted to accommodate the change; every edit
   above either strengthens or retargets an assertion to the true contract.

---

## 9. Docs

- `packages/apigen/apigen-plugin-tracing/README.md`: correct the streaming row to state the
  quarantine (a stream is spanned only to stream-obtain; chunk counts are not emitted) and name
  `makeTracingPlugin` as the configured entry point. The plugin-id/repo/keywords metadata is
  already correct.
- `packages/apigen/apigen-plugin-tracing/CHANGELOG.md`: note the contract fix and the streaming
  limitation under the unreleased `0.1.0` entry.
- The original `apigen-plugin-tracing-IMPLEMENTATION-SPEC.md` §7 test table is now superseded
  where it conflicts; add a one-line pointer to this document at its head (do not rewrite it).

---

## 10. ADR compliance

- **adhd ADR-0002** ("correct the source, never work around a functional gap") — *drives the
  whole fix*: the transport field is added to the engine's `Call` and stamped at the engine's
  choke point; the plugin is not special-cased.
- **adhd ADR-0003** ("@adhd/* publish CommonJS-only"; `verify-dist-load` must execute the
  entry) — *drives item 1*: a new publishable package must carry the dist-load gate; `main`
  stays `./dist/index.js` and `type` stays unset. *(Open, §11: the manifest still carries
  `module: ./dist/index.mjs`, matching every sibling; whether that violates D1's "no module"
  is a repo-wide migration question, not introduced here.)*
- **adhd ADR-0001** (typed config + retry, never an env-var feature toggle) — *drives the
  streaming disposition*: the quarantine is a documented limitation, not an env-var-enabled
  path.
- **adhd ADR-0004** (MCP flat output) — unaffected; no output-shape change.

---

## 11. Open items / follow-ups to file

1. **Streaming tracing is quarantined.** File a backlog item: "apigen tracing — span/stream
   lifecycle for a `streaming:true` op: reopen a real span (or a two-phase span) when the
   harness's `Next` can resolve to an `AsyncIterable`, and re-enable `traceStream`." Acceptance:
   a real-transport streaming e2e asserting chunk counts. Not an env toggle.
2. **`project.json` gate drift beyond tracing** — `apigen-plugin-ir-cache` and
   `apigen-plugin-ts-types` also omit the three gates and use a literal `packageRoot`. File
   one item covering both.
3. **`module: ./dist/index.mjs`** in every published `@adhd/*` manifest (including this new
   one) vs adhd ADR-0003 D1's "no module". Determine whether the migration is pending or the
   ADR needs a superseding amendment; do not silently exempt the new package.
4. **`pnpm-lock.yaml` `@lancedb/lancedb@0.31.0` `cpu` change** — unrelated churn; revert
   (§7 AC5) or explain in the PR.

---

## 12. UNVERIFIED

- The exact `pnpm-lock.yaml` `@lancedb/lancedb@0.31.0` block and the deleted `cpu: [x64, arm64]`
  line were **not read** (`UNVERIFIED`): this session has no `grep`/`git` tooling and the
  lockfile is too large to page blindly. The disposition ("unrelated to this feature; revert")
  rests on the fact that `@adhd/apigen-plugin-tracing` has no lancedb relation, and that
  lancedb enters transitively via the backlog's optional vector store. Confirm with
  `git diff bb832e7b...HEAD -- pnpm-lock.yaml` before applying AC5.
- `@adhd/sox-telemetry`'s `withSpan` internals (whether it re-throws, whether it restores
  prior context) were **not read**; the streaming quarantine argument does not depend on them,
  but the span `.finish`-at-obtain behaviour attributed to `withSpan` is inferred from its
  documented `fn: span => Promise<R>` contract (`UNVERIFIED`).
- The claim that all four transports are the *complete* set routing through `dispatchForPlan`
  is verified for mcp/fastify/express/cli (F6); `py-flask`/`py-grpc`/`java-javalin` are
  non-TS hosts not read here (`UNVERIFIED`).
- `docs/apigen/SPEC.md` (the normative §8.1 source cited by the engine headers) was not read
  (`UNVERIFIED`); `invoke.ts`'s headers quote it, and the contract fix is derived from the live
  types, not from that document.

---

### Does the review's diagnosis hold? (independent check)

**Yes, and it is understated.** The review's HIGH is exact (F1–F8, F13). Its fix direction is
correct and is adopted, with one addition it omitted: adding a **required** `transport` to the
runtime `Call` also breaks the four `MountHostBridge` call literals (F19), so those must be
stamped too or the build fails. The MEDIUM diagnosis is also exact (F9–F11); the review's
either/or framing (quarantine vs resolve-before-branch) resolves decisively to **quarantine**,
because resolve-before-branch cannot preserve the unary span-before-body invariant (the hang
test at `plugin.spec.ts:118-142`) — a fact the review did not weigh.
