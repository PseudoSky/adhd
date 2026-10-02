# Implementation Spec — FEAT-APIGEN-TRACING: `apigen-plugin-tracing`

**Status:** PROPOSED — architect spec, not yet approved for implementation.
**Owner:** architecture. **Drives:** `@adhd/backlog` becoming a required tracing consumer.
**Convention:** this note lives beside `ir-cache-IMPLEMENTATION-SPEC.md` in
`docs/apigen/design-notes/`, the established apigen implementation-spec home.
**Superseded in part by:** [`apigen-plugin-tracing-CONTRACT-FIX.md`](./apigen-plugin-tracing-CONTRACT-FIX.md)
— the contract seam (engine-supplied `Call.transport`), the streaming quarantine, and the test rework.

---

## 0. Verified facts (architect re-check)

Every claim below was read in-tree at the cited line range.

### 0.1 The plugin contract — `packages/apigen/apigen-core-client/src/lib/plugin.ts` (784 lines)

| Symbol | Anchor |
|---|---|
| `type Transport = 'http' \| 'grpc' \| 'mcp' \| 'cli'` | `:48` |
| `interface Extensions { get<T>/set<T> }` | `:70-81` |
| `interface Call { operation; data; envelope; ctx: Extensions; transport; signal; raw? }` | `:96-126` |
| `type Result = unknown` / `type Chunk = unknown` / `type Next = () => Promise<Result> \| AsyncIterable<Chunk>` | `:135`, `:141`, `:153` |
| `interface File { path: string; content: string }` | `:166-171` |
| `interface Descriptor { operations; host; namespace? }` | `:221-234` |
| `interface TargetCapability<Opts> { name; generate(descriptor,opts): File[]; serve? }` | `:257-291` |
| `interface LayerCapability { envelopeFields?; layer(call,next) }` — **receives NO opts** | `:305-330` |
| `interface Plugin<Opts> { id; description?; language?; optionsSchema?; capabilities: { target? layer? mount? envelope? extractLayer? } }` | `:679-767` |

The v1 `OutputPlugin`/`RunInput` types coexist in `./types.ts`.

### 0.2 The layer seam — the ONE place all transports converge

- `packages/apigen/apigen-engine-runtime/src/lib/package-invoker.ts:149-162` —
  `createPackageInvoker(schemas, usePlugins)` composes every `--use` plugin's
  `capabilities.layer` **outermost-first, in declaration order**, then pushes the
  validate-Layer innermost and calls `createInvoker(layers)`.
- `package-invoker.ts:91-94` — `readUsePlugins(options)` reads `options.usePlugins`.
- `package-invoker.ts:133-141` — `adaptCoreLayer(cap)` adapts a core `LayerCapability.layer`
  into a runtime `Layer`, aliasing `call.data = call.domainArgs`.
- `packages/apigen/apigen-engine-runtime/src/lib/invoke.ts:176-208` — `createInvoker`
  composes `layers.reduceRight((next, layer) => () => layer(call, next), dispatch)`;
  built **once per package**, not per request. `Call` carries `ctx: LayerContext` (`:37-61`).
- `packages/apigen/apigen-plugin-api-fastify/src/lib/run.ts:56-66` — `createPackageInvoker`
  "composes the `--use` layer stack + validate-Layer ONCE per package"; mount ops
  dispatch through the SAME composed `--use` invoker, and `Call.transport` is stamped
  from `plan.transport`. **Every serve-core transport (fastify, express, mcp, cli,
  py-flask, py-grpc) routes through this one invoker.**

### 0.3 Backlog mounts live; there is no generate step

- `entrypoint/backlog/src/server.ts:1-34` (header) — "apigen MOUNT wiring … `extract()` →
  `composeSchemas()` → `plugin.run()`. **NO `apigen generate`, no nx codegen executor, no
  reimplemented API surface.**"
- Fastify mount: `server.ts:862-895` — `usePlugins: [openapiPlugin, batchPlugin]` (`:877`).
- MCP mount: `server.ts:897-911` — `options: { transport: 'stdio', usePlugins: [batchPlugin] }` (`:905`).
- CLI mount: `entrypoint/backlog/src/cli.ts:117` —
  `export const USE_PLUGINS: readonly Plugin[] = [batchPlugin];`.
- `server.ts:97-105` — `requireRun(plugin)` throws `apigen plugin "<id>" declares no run()`.
- `server.ts:618-697` — `buildBacklogApigenPackage`; both mounts receive the SAME
  `operations` array (`server.ts:880-892`, SPEC §6.7).

### 0.4 The house tracing package — `@adhd/sox-telemetry` v0.3.2

`node_modules/@adhd/sox-telemetry/package.json`: "Shared tracing/metrics substrate
(BL-351): OTel API facade, durable JSONL sink, wait/work primitive, stage self-check.
**The only package permitted to import `@opentelemetry/*`.**" Deps: `@opentelemetry/api`,
`sdk-trace-base`, `context-async-hooks`, `sdk-metrics`, `ulid`. Backlog already depends on
it (`entrypoint/backlog/package.json:24` → `"@adhd/sox-telemetry": "^0.3.2"`) and calls
`initTelemetry({service:'backlog', role:'cli', logSink:'file'})` at
`entrypoint/backlog/src/index.ts:342` (skipped for `ir-artifact` `:335`).

Exported runtime surface (from `dist/index.d.ts`):
`withSpan<R>(name, attrs, fn: (span) => Promise<R>)`,
`withTimedEvent<T>(event, fields, fn)`,
`instrumentBoundary<T>(obj, {component, methods})`,
`newTraceId / currentTraceId / traceIdOrNew / withTrace / runWithNewTrace`,
`log`, `initTelemetry`, `declareStages`, `DurableJsonlSink`.
Documented instrument table: `sox.stage.<name>.{start,admitted,finish,error}` and
`<event>.{start,finish,error}` with `duration_ms`; every record carries
`service`, `role`, `trace_id`, `pid`, `ts`, `level`, stamped once by `initTelemetry`.

> **UNVERIFIED (needs reading `node_modules/@adhd/sox-telemetry/dist/runtime.js` before
> implementation):** whether `withSpan` re-throws a thrown `fn` after recording error
> status, and whether `runWithNewTrace` restores the prior trace context. The layer design
> below does NOT depend on either — it catches, records, and re-throws explicitly — but the
> implementer should confirm and cite the behaviour.

### 0.5 Why a new plugin — one paragraph

`apigen-plugin-logger` (`packages/apigen/apigen-plugin-logger/src/lib/plugin.ts:154-220`)
emits **human-readable pino lines to stderr** (`→ op` on entry `:163`, `← op ok` on exit,
`errorLogFields()` dropping stacks for expected `ApiError`s `:184-186`). Its contract is
"an operator can read what happened." Tracing needs something categorically different:
**durable, machine-readable, correlated records with a `trace_id`, span hierarchy, and a
queryable JSONL stream**, so a second process (or the backlog graph) can reconstruct one
request across the fastify/mcp/cli transports. Folding that into logger would give one
plugin two unrelated jobs (terminal readability vs. structured telemetry) and would force
every logger consumer to start emitting OTel spans. They share the same seam — `layer` —
so a separate plugin **composes cleanly alongside logger** (`usePlugins: [tracingPlugin,
loggerPlugin, …]`) with zero coupling, which is exactly the plugin capability model the
contract was built for. **Decision: new plugin.**

---

## 1. What "tracing" means here — stated once

> **Tracing = emitting durable, machine-readable, correlated telemetry for every operation
> dispatched through an apigen transport: one span per dispatched op, carrying the op id,
> the transport, the outcome, and the duration, written as JSONL `.start`/`.finish`/`.error`
> records to the process's `@adhd/sox-telemetry` sink, under a `trace_id` that correlates
> every span of one logical request.**

This is interpretation **(a)** — runtime instrumentation of the served transports — not
(b) generator self-tracing. The evidence is structural and decisive: `@adhd/backlog` mounts
plugins **live** (`server.ts:1-34`; no generate target exists) and consumes them through
`options.usePlugins` (`server.ts:877,:905`, `cli.ts:117`). There is no generated code in
backlog to instrument, and no generator invocation to trace. A **Layer** plugin therefore
instruments every transport at once, because every transport dispatches through the single
composed invoker (`package-invoker.ts:149-162`). A `target` capability is declared but
returns `[]` — exactly as logger's does (`apigen-plugin-logger/src/lib/plugin.ts` target
`generate()` returns `[]`) — so `--type tracing` is a valid no-op rather than an error.
**Primary: the runtime Layer. Secondary (present but empty): the codegen target.**

---

## 2. Files

| Path | Change | Read tokens | Output tokens |
|---|---|---|---|
| `packages/apigen/apigen-plugin-tracing/package.json` | create | 0 | 250 |
| `packages/apigen/apigen-plugin-tracing/project.json` | create (via nx generator) | 0 | 120 |
| `packages/apigen/apigen-plugin-tracing/tsconfig*.json` | create (via generator) | 0 | 100 |
| `packages/apigen/apigen-plugin-tracing/vite.config.ts` | create (via generator) | 0 | 80 |
| `packages/apigen/apigen-plugin-tracing/src/index.ts` | create | 0 | 120 |
| `packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts` | create | 0 | 1100 |
| `packages/apigen/apigen-plugin-tracing/src/lib/plugin.spec.ts` | create | 0 | 900 |
| `packages/apigen/apigen-plugin-tracing/README.md` | create | 0 | 500 |
| `packages/apigen/apigen-plugin-tracing/CHANGELOG.md` | create | 0 | 80 |
| `entrypoint/apigen-cli/src/lib/commands/run.ts` | modify (import `:31-38`; `BUILTIN_USE_PLUGINS` `:166-172`) | 150 | 40 |
| `entrypoint/backlog/package.json` | modify (`:7-37` deps) | 80 | 20 |
| `entrypoint/backlog/src/server.ts` | modify (import block; `:877`; `:905`) | 80 | 40 |
| `entrypoint/backlog/src/cli.ts` | modify (import `:26-29`; `:117`) | 60 | 30 |
| `entrypoint/backlog/src/server.tracing-required.spec.ts` | create | 0 | 400 |
| `packages/apigen/README.md` | modify (`:57` table row; `:80-84` develop list) | 90 | 40 |
| `entrypoint/apigen-cli/README.md` | modify (built-in `--use` list) | 120 | 30 |

Change types: **create** | **modify**.

---

## 3. Interface changes

### New: `packages/apigen/apigen-plugin-tracing/src/lib/plugin.ts`

```ts
import type {
  Plugin, Call, Next, Result, Chunk,
} from '@adhd/apigen-core-client';
import {
  withSpan, log, newTraceId, currentTraceId, runWithNewTrace,
} from '@adhd/sox-telemetry';

/** Options for `makeTracingPlugin`. Layer plugins receive no opts at call time
 *  (LayerCapability.layer carries only `call`/`next`), so configuration is a
 *  factory — the same pattern as `makeLoggerPlugin` (logger plugin.ts:310-323). */
export interface TracingOptions {
  /** Span/event/attribute name prefix — the emitting product's namespace. REQUIRED:
   *  there is no implicit default, so a product cannot silently emit another
   *  product's telemetry (adhd products pass `'adhd'`; apigen passes `'apigen'`). */
  serviceName: string;
  /** Extra attribute keys copied verbatim from `call.envelope` onto each span.
   *  Default: `[]` (only the built-in attrs `${serviceName}.op`,
   *  `${serviceName}.transport`, `trace_id` are emitted). */
  envelopeAttrs?: readonly string[];
}

/** Per-call trace handle, seeded into `call.ctx`. The class is the ctx token. */
export class TraceHandle {
  constructor(
    readonly traceId: string,
    readonly spanName: string,
    readonly startedAt: number
  ) {}
  /** Add attributes to the live span from domain code — opt-in. */
  annotate(fields: Record<string, unknown>): void;
}

/** Default plugin — module-scope configured layer (logger precedent, plugin.ts:238-295). */
export const tracingPlugin: Plugin<TracingOptions>;

/** Configured factory — rebuilds the layer with `opts` (logger precedent). `opts` is
 *  REQUIRED and `opts.serviceName` is a required non-empty string. */
export function makeTracingPlugin(opts: TracingOptions): Plugin<TracingOptions>;

export default tracingPlugin;
```

`tracingPlugin.capabilities`:

```ts
capabilities: {
  // Declared so `--type tracing` resolves instead of erroring; emits NOTHING —
  // parity with logger's `generate() { return [] }` (logger plugin.ts target).
  target: { name: 'tracing', generate(_descriptor, _opts) { return []; } },
  layer: { layer: traceLayer /*(call, next) => Promise<Result> | AsyncIterable<Chunk>*/ },
}
```

`id: 'tracing'`, `description: 'Layer plugin: emits one OTel span per dispatched operation
(op id, transport, outcome, duration) to the sox-telemetry JSONL sink, correlated by
trace_id.'`, `language: 'ts'`, `optionsSchema` for `{ serviceName, envelopeAttrs }`.

### Modify: `entrypoint/apigen-cli/src/lib/commands/run.ts`

```ts
// BEFORE (after :38)
import { irCachePlugin } from '@adhd/apigen-plugin-ir-cache';

// AFTER — add alongside the other built-ins
import tracingPlugin from '@adhd/apigen-plugin-tracing';
```

```ts
// BEFORE (:166-172)
const BUILTIN_USE_PLUGINS: Record<string, Plugin> = {
  batch: batchPlugin as Plugin,
  health: healthPlugin as Plugin,
  logger: loggerPlugin as Plugin,
  openapi: openapiPlugin as Plugin,
  'ir-cache': irCachePlugin as unknown as Plugin,
};

// AFTER — bare slug `--use tracing` resolves
const BUILTIN_USE_PLUGINS: Record<string, Plugin> = {
  tracing: tracingPlugin as Plugin,
  batch: batchPlugin as Plugin,
  health: healthPlugin as Plugin,
  logger: loggerPlugin as Plugin,
  openapi: openapiPlugin as Plugin,
  'ir-cache': irCachePlugin as unknown as Plugin,
};
```

### Modify: `entrypoint/backlog/src/server.ts`

```ts
// BEFORE — no tracing import
// AFTER — static, unconditional
import { tracingPlugin } from '@adhd/apigen-plugin-tracing';
```

```ts
// BEFORE (:877)
usePlugins: [openapiPlugin, batchPlugin],
// AFTER
usePlugins: [tracingPlugin, openapiPlugin, batchPlugin],
```

```ts
// BEFORE (:905)
options: { transport: 'stdio', usePlugins: [batchPlugin] },
// AFTER
options: { transport: 'stdio', usePlugins: [tracingPlugin, batchPlugin] },
```

### Modify: `entrypoint/backlog/src/cli.ts`

```ts
// BEFORE (:26-27)
import { cliPlugin } from '@adhd/apigen-plugin-cli-output';
import { batchPlugin } from '@adhd/apigen-plugin-batch';
// AFTER — add
import { tracingPlugin } from '@adhd/apigen-plugin-tracing';

// BEFORE (:117)
export const USE_PLUGINS: readonly Plugin[] = [batchPlugin];
// AFTER
export const USE_PLUGINS: readonly Plugin[] = [tracingPlugin, batchPlugin];
```

### Modify: `entrypoint/backlog/package.json`

```jsonc
// BEFORE (:11-16)
"@adhd/apigen-plugin-api-fastify": "^0.2.6",
"@adhd/apigen-plugin-batch": "^0.2.5",
"@adhd/apigen-plugin-cli-output": "^0.2.7",
"@adhd/apigen-plugin-ir-cache": "^0.1.3",
"@adhd/apigen-plugin-mcp": "^0.3.1",
"@adhd/apigen-plugin-openapi": "^0.2.5",
// AFTER — published-semver family edge (NOT workspace:* — the family uses `^`)
"@adhd/apigen-plugin-api-fastify": "^0.2.6",
"@adhd/apigen-plugin-batch": "^0.2.5",
"@adhd/apigen-plugin-cli-output": "^0.2.7",
"@adhd/apigen-plugin-ir-cache": "^0.1.3",
"@adhd/apigen-plugin-mcp": "^0.3.1",
"@adhd/apigen-plugin-openapi": "^0.2.5",
"@adhd/apigen-plugin-tracing": "^0.1.0",
```

### New: `packages/apigen/apigen-plugin-tracing/package.json` (shape)

```jsonc
{
  "name": "@adhd/apigen-plugin-tracing",
  "version": "0.1.0",
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "@adhd/apigen-base-errors": "^0.2.3",
    "@adhd/apigen-core-client": "^0.3.3",
    "@adhd/sox-telemetry": "^0.3.2"
  },
  "publishConfig": { "access": "public" },
  "files": ["dist", "CHANGELOG.md"],
  "description": "Tracing plugin for apigen servers",
  "keywords": ["tracing", "telemetry", "otel", "apigen", "plugin", "typescript"],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/PseudoSky/adhd.git",
    "directory": "packages/apigen/apigen-plugin-tracing"
  },
  "homepage": "https://github.com/PseudoSky/adhd/tree/main/packages/apigen/apigen-plugin-tracing#readme"
}
```

---

## 4. Behavioral changes

### `apigen-plugin-tracing/src/lib/plugin.ts` — `traceLayer(call, next)`

- **Change:** wrap each dispatched operation in a trace span; seed a `TraceHandle`.
- **Step 1 — correlation.** `const traceId = currentTraceId() ?? newTraceId();` then
  `call.ctx.set(TraceHandle, new TraceHandle(traceId, spanName, Date.now()))` with
  `spanName = `${opts.serviceName ?? 'apigen'}.${call.operation.id}``.
- **Step 2 — attributes.** `attrs = { 'apigen.op': call.operation.id, 'apigen.transport':
  call.transport, ...picked(call.envelope, opts.envelopeAttrs) }`.
- **Step 3 — run inside the trace.** `return runWithNewTrace(traceId, () => …)`.
- **Step 4 — branch.**
  - **Unary** (`next()` returns a `Promise`): `withSpan(spanName, attrs, async () => { try
    { return await downstream; } catch (e) { log({ event: 'apigen.op.error',
    op: call.operation.id, transport: call.transport, err: e }); throw e; } })`.
    `withSpan` writes `.start` **before** the body (hang-visible) and `.finish`/error
    status on completion.
  - **Streaming** (`next()` returns an `AsyncIterable`): `withSpan` cannot await an
    iterable, so emit `log({ event: `${spanName}.start`, op, transport })` synchronously,
    return an `async function*` wrapper that `yield`s each chunk unchanged, counts them,
    then `log({ event: `${spanName}.finish`, op, duration_ms, chunks })`; on a thrown
    error `log({ event: `${spanName}.error`, op, err })` and **`throw e`**.
- **Never swallow.** Every `catch` traces (`log`/`.error` record) and re-throws — §8.1
  rule 2 (invoke.ts:9-20). No empty catch anywhere (repo hard rule).
- **Never touch:** `next`'s return value semantics, `call.envelope`/`call.data`, the
  validate-Layer, or any other plugin's layer.

### `entrypoint/backlog/src/server.ts` / `cli.ts` — tracing is a REQUIRED consumer

- **Change:** the tracing plugin is added to **all three** `usePlugins` arrays as a
  static, unconditional array member, and its package is a declared dependency.
- **Why all three:** `createPackageInvoker` builds one invoker per package per mount
  (package-invoker.ts:149-162); each transport is a separate `plugin.run()` call
  (server.ts:864, :902; cli.ts handoff), so a transport only traces if its own array
  carries the layer. Three arrays ⇒ three edits; missing one is a silent gap.
- **Never touch:** the `operations` array (shared, SPEC §6.7), `requireRun`, the
  `pkg`/`schemas` construction, or `resolveMountNamespaces`.

### Failure mode — why the dependency cannot be omitted

The dependency is **not** a flag; it is a static ESM import plus array membership:

1. **Package absent / dep entry removed.** `pnpm install --frozen-lockfile` fails with
   `ERR_PNPM_OUTDATED_LOCKFILE` (the importer no longer matches `pnpm-lock.yaml`).
2. **Stale install, build attempted.** `nx build backlog` runs `vite build` (project.json
   `build` target) and vite/rollup fails resolution:
   `[vite]: Rollup failed to resolve import "@adhd/apigen-plugin-tracing" from
   "entrypoint/backlog/src/server.ts"` — non-zero exit.
3. **Typecheck (a hard dependency of `build`).** `nx typecheck backlog` emits
   `error TS2307: Cannot find module '@adhd/apigen-plugin-tracing' or its corresponding
   type declarations` in both `server.ts` and `cli.ts`. Backlog's `build` target declares
   `dependsOn: ["^build", "typecheck"]` (`entrypoint/backlog/project.json`), so the stale
   artifact cannot be served from cache either (`build.cache: false`, `AGENTS.md`).
4. **Array membership dropped while the package resolves.** The static import alone is not
   enough to prove the layer is *installed on the mount*. The mount-invariant test in §7
   asserts `tracingPlugin` is present in every composed stack and fails if it is removed —
   this is the mechanical, provider-independent proof.

---

## 5. Independent segments

### Segment A: New plugin package

- **Files:** `packages/apigen/apigen-plugin-tracing/{package.json,project.json,tsconfig*.json,vite.config.ts,src/index.ts,src/lib/plugin.ts,CHANGELOG.md}`.
- **Dependencies:** none. **Read tokens:** 0. **Output tokens:** ~1900.
- **Required context:** `apigen-plugin-logger/src/lib/plugin.ts` (the template —
  `makeLayer`, `makeLoggerPlugin`, plugin object) and `apigen-core-client`'s `plugin.ts`
  `LayerCapability`/`Plugin`. Scaffold with
  `npx nx g @adhd/apigen-generator-nx:plugin tracing --directory packages/apigen/apigen-plugin-tracing`.

### Segment B: Plugin tests

- **Files:** `packages/apigen/apigen-plugin-tracing/src/lib/plugin.spec.ts`.
- **Dependencies:** Segment A. **Read tokens:** ~200 (the plugin).
- **Output tokens:** ~900.
- **Required context:** `@adhd/sox-telemetry` `_resetTelemetryForTest`,
  `_snapshotCountForTest` (see `dist/index.d.ts`) to assert emitted records.

### Segment C: CLI registration

- **Files:** `entrypoint/apigen-cli/src/lib/commands/run.ts` (`:31-38`, `:166-172`).
- **Dependencies:** Segment A (the module must exist to import).
- **Read tokens:** ~150 (imports + `BUILTIN_USE_PLUGINS` only). **Output tokens:** ~40.
- **Required context:** read `run.ts` lines 27-40 and 160-172 ONLY.

### Segment D: Backlog required-consumer wiring

- **Files:** `entrypoint/backlog/{package.json,src/server.ts,src/cli.ts}`.
- **Dependencies:** Segment A + a published/symlinked `@adhd/apigen-plugin-tracing`.
- **Read tokens:** ~180 (`package.json:7-37`, `server.ts:855-911`, `cli.ts:20-29,117`).
- **Output tokens:** ~90.
- **Required context:** read exactly those ranges; do not open the rest of `server.ts`.

### Segment E: Required-consumer proof test

- **Files:** `entrypoint/backlog/src/server.tracing-required.spec.ts`.
- **Dependencies:** Segment D. **Read tokens:** ~120. **Output tokens:** ~400.
- **Required context:** `createPackageInvoker`/`readUsePlugins` signatures
  (package-invoker.ts:91-94,149-162) and `buildBacklogApigenPackage` (server.ts:618-697).

### Segment F: Docs

- **Files:** `packages/apigen/README.md`, `entrypoint/apigen-cli/README.md`,
  `packages/apigen/apigen-plugin-tracing/README.md`, `entrypoint/backlog/AGENTS.md`.
- **Dependencies:** A–D (names/slugs must be final). **Read tokens:** ~250. **Output tokens:** ~700.

---

## 6. Execution strategies

### Segment A — new plugin package

1. Run `npx nx g @adhd/apigen-generator-nx:plugin tracing --directory
   packages/apigen/apigen-plugin-tracing`, then `npx nx build apigen-plugin-tracing`.
2. Replace the generated `src/lib/plugin.ts` with the interface from §3. Copy
   `makeLayer`/`makeLoggerPlugin`/plugin-object shape from
   `apigen-plugin-logger/src/lib/plugin.ts:154-323`; swap pino for
   `withSpan`/`log`/`runWithNewTrace` from `@adhd/sox-telemetry`.
3. `src/index.ts`: `export type { TracingOptions }; export { TraceHandle, tracingPlugin,
   makeTracingPlugin }; export { default } from './lib/plugin';` (mirror
   `apigen-plugin-logger/src/index.ts`).
4. `package.json`: set name/version/deps/description/keywords exactly per §3. Do NOT add
   a `module` field beyond what the generator writes; do NOT add an `exports` map
   (ADR-0003 direction is CJS, and this repo still carries `module` — match the
   generated logger sibling exactly, do not "fix" either way in this change).
5. NEVER modify `apigen-core-client` or `apigen-engine-runtime` — the layer seam already
   exists.

### Segment B — tests

1. Use `_resetTelemetryForTest` in `beforeEach` and `_snapshotCountForTest` (or read the
   temp JSONL sink) to assert emitted records.
2. Cover the seven cases in §7. Do not skip the error case.

### Segment C — CLI registration

1. Add the import at `run.ts:38` and the map entry at `:166-172` per §3.
2. Do NOT add it to `entrypoint/apigen-cli/src/index.ts`'s `--type` map — logger is a
   `--use`-only plugin and tracing follows it exactly.

### Segment D — backlog wiring

1. Add the dependency line to `entrypoint/backlog/package.json` (§3).
2. Add the static import to `server.ts` and `cli.ts`.
3. Prepend `tracingPlugin` to each of the three `usePlugins` arrays (§3). Keep the arrays
   as single array literals — no spread, no conditional, no flag.
4. Run `pnpm install` and commit the `pnpm-lock.yaml` diff IFF the plugin resolves as a
   workspace edge; if it resolves from the registry, no lock change is needed (follow
   the family: semver `^0.1.0`).

### Segment E — proof test

1. Import `USE_PLUGINS` from `cli.ts` and the two mount arrays (or reconstruct them from
   `createBacklogServer`); assert each contains an object whose `.id === 'tracing'`.
2. Assert `createPackageInvoker(schemas, readUsePlugins({ usePlugins: [tracingPlugin] }))`
   dispatches an op and that a span record is emitted (via the sink).
3. Negative control: use the injected-resolver pattern (`run.ts:124-127` `LibResolver`)
   to substitute an absent plugin and assert the invariant fails.

### Segment F — docs

Per §8.

---

## 7. Test cases

### Unit — `apigen-plugin-tracing/src/lib/plugin.spec.ts`

- layer calls `next()` exactly once and returns its resolved value unchanged.
- layer seeds `call.ctx.get(TraceHandle)` with a non-empty `traceId` and `spanName ===
  'apigen.<op>'`.
- unary success emits a `.start` record **before** the body and a `.finish` record with
  `duration_ms`.
- unary error: the error **propagates (throws)** AND an `apigen.op.error` record is
  emitted — asserts the layer never swallows (guards the empty-catch rule).
- streaming: chunks pass through byte-identical; `.finish` carries the chunk count after
  the stream ends.
- streaming error: mid-stream throw propagates and emits `.error`.
- `tracingPlugin.capabilities.target.generate()` returns `[]`.

### Integration / runtime assertion

- Boot the MCP mount in-process with a sandbox `logDir` (reuse the redirect at
  `entrypoint/backlog/src/index.ts:336-339`), invoke one op through the harness, then read
  the JSONL sink file and assert a record whose span name is `apigen.<op>` carries the
  `apigen.op` and `apigen.transport='mcp'` attributes and a `trace_id`.

### Required-consumer proof (the negative)

- `entrypoint/backlog/src/server.tracing-required.spec.ts` asserts `tracingPlugin` is a
  member of `USE_PLUGINS` **and** of both mount `usePlugins` arrays; and that a dispatched
  call emits a span. With the plugin removed from any array (or import stubbed absent via
  the `LibResolver` injection pattern), the assertion **fails** — that failing run is the
  proof the dependency is non-optional.
- A scripted CI check (or the test above) asserts the literal static-import line is
  present in `server.ts` and `cli.ts`; document the expected failure strings from §4.

### UX acceptance

- `apigen --use tracing run --source ./api.ts --type mcp` starts and emits trace records;
  `--type tracing` resolves to a no-op target (no files, no error).
- Backlog: `adhd-backlog stats` writes at least one `adhd.*` record to
  `~/.adhd/sox-ecosystem/backlog/logs/backlog.cli-<date>.jsonl` in addition to the
  existing telemetry (does not replace it).

---

## 8. Docs to update

- `packages/apigen/README.md` — add a table row at `:57`:
  `| [@adhd/apigen-plugin-tracing](./apigen-plugin-tracing) | Layer: per-operation OTel spans + durable JSONL trace records | — | — |`
  and append `apigen-plugin-tracing` to the `## Develop` run-many list (`:80-84`).
- `entrypoint/apigen-cli/README.md` — list `tracing` among the built-in `--use` slugs
  (beside `health`, `logger`).
- `packages/apigen/apigen-plugin-tracing/README.md` (**new**) — usage: `--use tracing`;
  programmatic `usePlugins: [tracingPlugin]` / `makeTracingPlugin({ serviceName })`;
  reading `call.ctx.get(TraceHandle)` in domain functions; where records land.
- `packages/apigen/apigen-plugin-tracing/CHANGELOG.md` (**new**) — via the version flow.
- `packages/apigen/CHANGELOG.md` — release entry produced by the version flow.
- `entrypoint/backlog/CHANGELOG.md` — record that tracing is now a **required** mount
  consumer of the fastify, MCP, and CLI transports.
- `entrypoint/backlog/AGENTS.md` — update the mount-wiring description to name the three
  `usePlugins` arrays and the tracing plugin as a required member.
- `docs/apigen/SPEC.md` — if it enumerates layer plugins, add `tracing`. **(UNVERIFIED:
  SPEC.md was not read; implementer must check whether it lists plugins.)**

**Do NOT touch:** any `BACKLOG.md` (prose, hand-edit banned), `registry/index.json`.

---

## 9. ADR compliance

- **ADR-0001** (Turso store, no env-var feature toggles): the design carries **no**
  `*_ENABLED`/`*_MULTIPROCESS` toggle. Tracing is designed-in (always on when the layer is
  mounted); `TracingOptions` is typed configuration, not an enable switch.
- **ADR-0002** (correct the source): the required-consumer wiring edits backlog's own
  source (`server.ts`/`cli.ts`); no request-time shim is introduced.
- **ADR-0003** (CJS-only publish): the new package's `package.json` mirrors the current
  logger sibling (`main`/`module`/`types`); this change does not "fix" the in-progress
  migration either way.
- **ADR-0004** (flat MCP content payload): untouched — tracing adds no MCP tools and
  changes no payload shape.

---

## 10. Blockers / open items

1. **`@adhd/sox-telemetry` internals** — `dist/runtime.js` was not read. The layer
   explicitly catches/records/re-throws so it does not depend on `withSpan`'s error
   semantics, but the implementer must confirm `runWithNewTrace` restores prior context
   and cite it.
2. **`apigen-plugin-tracing` first release** — publishing a brand-new `@adhd/*` package
   requires the release flow (PUBLISHING-equivalent) to write its first registry row; the
   spec assumes the normal independent-versioning flow applies to a new sibling.
3. **`docs/apigen/SPEC.md`** — not read; whether it enumerates layer plugins is unverified.
4. **Direction's premise** — the stated consumption path ("`@adhd/apigen-cli generate
   --type mcp`") does not match the tree; backlog mounts live (`server.ts:1-34`). The spec
   is built on the actual live-mount path.
