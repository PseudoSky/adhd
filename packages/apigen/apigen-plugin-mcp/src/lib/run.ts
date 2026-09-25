import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  ComposedSchemas,
  MountedOperation,
  MountHostBridge,
  Operation,
  RunInput,
} from '@adhd/apigen-core-client';
import type { ProjectionConfig } from '@adhd/apigen-engine-naming';
import type {
  ApiStream,
  Call as RuntimeCall,
  InvokeOptions,
  LayerResult,
  Logger,
  OpPlan,
  TransportAdapter,
  UseOptions,
  UsePlugin,
} from '@adhd/apigen-engine-runtime';
import {
  buildOpPlan,
  buildMcpOutputSchema,
  buildToolDescription,
  createLogger,
  createPackageInvoker,
  dispatchForPlan,
  isApiStream,
  LayerContext,
  readUseOptions,
  readUsePlugins,
  wrapMcpStructuredContent,
} from '@adhd/apigen-engine-runtime';
import { ApiError, MCP_ERROR_KIND, isApiError } from '@adhd/apigen-base-errors';
import { operationFor } from './tool-naming';
import { projectStreamMcp } from './stream';
import type { McpCallToolResult } from './stream';

// ---------------------------------------------------------------------------
// serve-core migration (mcp-adapter). mcp is now a `TransportAdapter<McpRaw>`
// over the transport-neutral serve-core primitives shipped in
// `@adhd/apigen-engine-runtime` — the FIRST time mcp has composed any of
// them. Unlike the fastify/express states (which collapsed an EXISTING
// shape onto the shared primitives), mcp is GAINING capability here:
//
//   1. BUG-APIGEN-SERVE-CORE-001 fix ([mcp-adapter.1]): `createPackageInvoker`
//      (validate-Layer, ALWAYS innermost, + any `--use` layer plugins,
//      outermost-first) is composed for the FIRST time. Pre-migration, this
//      file's `CallToolRequestSchema` handler called `dispatch()` directly —
//      malformed tool input reached the domain function completely
//      unvalidated. ⚠️ FLAGGED BREAKING BEHAVIOR CHANGE: a malformed call now
//      REJECTS with `ApiError{code:'invalid_argument'}` (surfaced to a real
//      MCP client as a JSON-RPC error) instead of silently succeeding (or
//      running the domain fn with garbage args). This is intentional and
//      required — not a regression.
//   2. DEBT-APIGEN-SERVE-CORE-002 (mcp half) fix ([mcp-adapter.2]):
//      `projectStreamMcp` (`./stream.ts`) is wired LIVE via `writeResult`'s
//      `isApiStream` branch. Pre-migration this function had ZERO call sites
//      and a `streaming:true` op's `ApiStream` result mis-serialized to `{}`
//      via a bare `JSON.stringify`.
//   3. [mcp-adapter.3]: the `deriveToolName`/`findOperation` tool-naming shim
//      is deleted — `./tool-naming.ts` now only resolves the `Operation`
//      (`operationFor`); the canonical tool name is `OpPlan.mcp.name`,
//      resolved by the SAME `buildOpPlan()` every other transport uses.
//   4. dod.11 ([mcp-adapter.7]): mcp now also composes `--use` MOUNT
//      capability ops (e.g. a health/status tool) through the SAME composed
//      `--use` invoker as source ops — a wholly NEW mcp capability, mirroring
//      fastify's `[fix:mount-through-layers]`.
//   5. [mcp-adapter.8] toolMetas hoist: `buildToolTable()` — the expensive
//      per-op work (OpPlan resolution, `--use`/validate-Layer composition,
//      description/outputSchema derivation) — runs EXACTLY ONCE per `run()`
//      invocation, regardless of transport or request volume. Pre-migration,
//      `streaming-http` mode rebuilt the ENTIRE tool table (a fresh `Server`
//      AND a full re-derivation of every tool's metadata) on every single
//      request — a latent perf defect. `createMcpServer()` (cheap: just
//      registers two closures over the ALREADY-built table) is still called
//      per connection where the SDK requires a fresh `Server` (see the
//      per-transport notes below), but the expensive part never re-runs.
//      `__toolTableBuildCount` instruments this for the regression test.
//   6. BUG-APIGEN-MCP-STREAMING-HTTP-NO-ERROR-GUARD-001 fix
//      ([mcp-adapter.9]): BOTH mcp HTTP transports (`sse` and
//      `streaming-http`) now route their raw Node-http-level handler
//      rejections through the SAME `guardHttpTransport()` wrapper.
//      Pre-migration, only `sse` had a try/catch around its request handler;
//      `streaming-http` had none, so a thrown error there became an
//      unhandled rejection that could crash the whole process (taking down
//      every live session, `sse` included, with it).
//
// A SIXTH, discovered-in-passing fix falls out of the toolMetas-hoist design
// rather than being separately mandated: pre-migration, `sse` mode called
// `server.connect(sseTransport)` on a SINGLE, module-scoped `Server` instance
// for EVERY incoming SSE session. The MCP SDK's `Protocol.connect()`
// (`@modelcontextprotocol/sdk/shared/protocol.js`) throws "Already connected
// to a transport" if a second transport connects before the first
// disconnects — so two concurrent SSE clients against the pre-migration
// server would have crashed the second connection. This was latent/
// unexercised (the pre-migration test suite only ever drove one SSE session
// at a time). Because the toolMetas hoist already requires a cheap
// `createMcpServer()` factory (called once per streaming-http request, per
// the SDK's own stateless-mode contract — see `simpleStatelessStreamableHttp`
// in the SDK's examples), reusing that SAME factory once per SSE session
// fixes this for free: every session gets its own `Server`, sharing only the
// (already-hoisted) tool table. Filed + fixed together — see the completion
// report for the BACKLOG citation.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §9.1 — envelope from MCP _meta (x-<pluginId>-<field>)
// ---------------------------------------------------------------------------

/**
 * The transport-native carrier the mcp adapter marshals to/from
 * (`TransportAdapter<McpRaw>`). `output` is a mutable slot `writeResult`/
 * `writeError` populate — MCP's `CallToolRequestSchema` handler must
 * `return` its result (there is no `reply`-style side-effect object the way
 * HTTP has one), so the handler reads `raw.output` back after invoking the
 * adapter, per `TransportAdapter`'s documented "Raw is a generic escape
 * hatch" contract.
 */
export interface McpRaw {
  /** The raw MCP `tools/call` `arguments` object (data + optional `_meta`). */
  args: Record<string, unknown>;
  /** `_meta` extracted from `args` — the §9.1 envelope carrier for MCP. */
  meta: Record<string, unknown>;
  /** Populated by `writeResult`/`writeError` before the handler returns. */
  output?: McpCallToolResult;
}

/** One resolved tool's list-facing metadata — computed ONCE ([mcp-adapter.8]). */
interface ToolListMeta {
  description: string;
  inputSchema: unknown;
  outputSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// [mcp-adapter.8] toolMetas-hoist instrumentation
// ---------------------------------------------------------------------------

/**
 * @internal Test-only instrumentation for the toolMetas-hoist regression
 * guard (dod.12 / [mcp-adapter.8]): counts how many times `buildToolTable()`
 * — the EXPENSIVE per-op work (OpPlan resolution + `--use`/validate-Layer
 * composition + description/outputSchema derivation) — actually runs.
 * Production code must call it exactly ONCE per `run()` invocation,
 * regardless of transport or how many requests a stateless HTTP transport
 * later serves. A regression that rebuilds the table per-request would
 * increment this beyond 1 across multiple `CallTool` round-trips.
 */
export const __toolTableBuildCount = { count: 0 };

/**
 * Shared default `inputSchema` for a tool with no bound metadata. A single
 * module-level instance (not a fresh `{ type:'object', properties:{} }` literal
 * per tool per call) so `listTools()` never allocates a new object for every
 * schema-less tool on every request (DEBT-APIGEN-MCP-LISTTOOLS-CACHE-001).
 */
const DEFAULT_INPUT_SCHEMA = { type: 'object', properties: {} };

/** One entry of the `tools/list` response — the shape `listTools()` returns
 * and memoizes (DEBT-APIGEN-MCP-LISTTOOLS-CACHE-001). Internal only; the
 * package public barrel (`src/index.ts`) re-exports only `./lib/plugin`, so
 * this type never widens the published API surface. */
type McpToolListEntry = {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// McpTransportAdapter — the mcp `TransportAdapter<McpRaw>` port implementation.
// ---------------------------------------------------------------------------

/**
 * The mcp `TransportAdapter`. `readCall`/`writeResult`/`writeError` are the
 * genuinely transport-specific seam; everything transport-neutral
 * (tool-name/envelope/streaming/mount resolution) is already resolved on the
 * `OpPlan` it receives. Holds the hoisted tool table (built ONCE by
 * `buildToolTable()`) that every per-connection `Server` (`createMcpServer()`)
 * shares.
 */
export class McpTransportAdapter implements TransportAdapter<McpRaw> {
  private readonly plans = new Map<string, OpPlan>();
  private readonly dispatchers = new Map<
    string,
    (call: Omit<RuntimeCall, 'operation' | 'ctx'>) => Promise<LayerResult>
  >();
  /** op.id → composed schema — used by `writeResult` to resolve BUG-APIGEN-019
   * structuredContent wrapping for THIS op's output shape. Mount ops carry no
   * composed schema and are never bound (mirrors fastify's `bindSchema`). */
  private readonly schemasByOpId = new Map<string, ComposedSchemas[string]>();
  /** plan.mcp.name → list-facing metadata, computed ONCE ([mcp-adapter.8]). */
  private readonly toolMeta = new Map<string, ToolListMeta>();
  /** Memoized result of `listTools()`. `registerRoute()` is the ONLY mutation
   * point for the tool set, so the cache is invalidated there and nowhere else
   * (DEBT-APIGEN-MCP-LISTTOOLS-CACHE-001). */
  private cachedList: McpToolListEntry[] | undefined;

  bindSchema(opId: string, schema: ComposedSchemas[string]): void {
    this.schemasByOpId.set(opId, schema);
  }

  bindToolMeta(name: string, meta: ToolListMeta): void {
    this.toolMeta.set(name, meta);
  }

  registerRoute(
    plan: OpPlan,
    dispatch: (
      call: Omit<RuntimeCall, 'operation' | 'ctx'>
    ) => Promise<LayerResult>
  ): void {
    // First statement: any route mutation invalidates the memoized tools/list
    // projection. `registerRoute` is the only way a plan enters `this.plans`.
    this.cachedList = undefined;
    this.plans.set(plan.mcp.name, plan);
    this.dispatchers.set(plan.mcp.name, dispatch);
  }

  getPlan(name: string): OpPlan | undefined {
    return this.plans.get(name);
  }

  getDispatch(
    name: string
  ): ((call: Omit<RuntimeCall, 'operation' | 'ctx'>) => Promise<LayerResult>) | undefined {
    return this.dispatchers.get(name);
  }

  /** The `tools/list` projection — cheap; reads the already-hoisted metadata.
   * Memoized: the result is rebuilt only after `registerRoute()` invalidates
   * it, so successive calls return the SAME array reference
   * (DEBT-APIGEN-MCP-LISTTOOLS-CACHE-001). */
  listTools(): Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    outputSchema?: Record<string, unknown>;
  }> {
    if (this.cachedList) return this.cachedList;
    this.cachedList = [...this.plans.keys()].map((name) => {
      const meta = this.toolMeta.get(name);
      return {
        name,
        description: meta?.description ?? name,
        inputSchema: meta?.inputSchema ?? DEFAULT_INPUT_SCHEMA,
        ...(meta?.outputSchema ? { outputSchema: meta.outputSchema } : {}),
      };
    });
    return this.cachedList;
  }

  readCall(raw: McpRaw, plan: OpPlan): Omit<RuntimeCall, 'operation' | 'ctx'> {
    // §9.1: envelope fields come from _meta["x-<pluginId>-<field>"], not from
    // the args body — driven entirely off the resolved OpPlan envelope
    // bindings (no per-request schema re-derivation).
    const envelope: Record<string, unknown> = {};
    for (const field of plan.envelope) {
      const value = raw.meta[field.mcpMetaKey];
      if (value !== undefined) envelope[field.field] = value;
    }
    // (batch-rollout, BATCH_0.0.1.md §2) A mount op's advertised MCP
    // `inputSchema` is `mountedOp.input` DIRECTLY (see `buildToolTable`'s
    // `mountInputSchema` below) — NOT data-wrapped like a real domain op's
    // tool arguments are. `health`/`openapi` never surfaced this gap because
    // their mounts are zero-input, so reading `args['data']` (always
    // `undefined` → `{}`) was indistinguishable from "no input was sent" —
    // but a mount with real domain input (e.g. `_batch/<kind>`'s
    // `{operation, items, …}`) needs the raw `args` object itself, unwrapped.
    const domainArgs = plan.isMount
      ? raw.args
      : ((raw.args['data'] as Record<string, unknown> | undefined) ?? {});
    return { envelope, domainArgs };
  }

  async writeResult(
    raw: McpRaw,
    result: LayerResult,
    plan: OpPlan
  ): Promise<void> {
    // [mcp-adapter.2] / DEBT-APIGEN-SERVE-CORE-002: a streaming op resolves to
    // an `ApiStream` — project it via `projectStreamMcp` instead of
    // mis-serializing it through JSON.stringify.
    if (isApiStream(result)) {
      raw.output = await projectStreamMcp(result as ApiStream<unknown>);
      return;
    }

    // BUG-APIGEN-019: pair the declared outputSchema with a matching
    // structuredContent value (wrapped under `result` iff the schema was).
    const schema = this.schemasByOpId.get(plan.op.id);
    const { wrapped } = buildMcpOutputSchema(
      (schema as { output?: unknown } | undefined)?.output
    );
    const structuredContent = wrapMcpStructuredContent(wrapped, result);
    raw.output = {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(structuredContent ? { structuredContent } : {}),
    };
  }

  writeError(_raw: McpRaw, err: unknown, _plan: OpPlan): void {
    // §9: MCP surfaces all apigen errors by RE-THROWING — the SDK's own
    // Protocol layer (`_onrequest`) converts a thrown error into a JSON-RPC
    // error response. Unlike HTTP (a distinct status-code channel) or a
    // stream's in-band error notification, MCP's unary error channel IS the
    // thrown-error-to-JSON-RPC-error conversion the SDK already performs, so
    // re-throwing here is the correct §9 marshal for this transport.
    const code = isApiError(err) ? err.code : 'internal';
    void MCP_ERROR_KIND[code]; // validates the §9 table is wired
    throw err;
  }
}

// ---------------------------------------------------------------------------
// BUG-APIGEN-MCP-ROOT-ONEOF-001 — MCP's `Tool.inputSchema` requires a literal
// top-level `type:"object"` (`ToolSchema` in `@modelcontextprotocol/sdk`), but
// a mount's real `Operation.input` may be a root-level `oneOf`+`discriminator`
// union (e.g. the batch plugin's `_batch/<kind>` mount — see
// `apigen-core-client/src/lib/batch.ts`'s `buildBatchKindSchema`) with no
// top-level `type` at all. The SDK's zod schema also carries a
// `$catchall<ZodUnknown>` on `inputSchema`, meaning sibling keys beyond
// `type`/`properties`/`required` pass through unvalidated rather than being
// rejected — so the real `oneOf`/`discriminator` can be preserved alongside a
// synthesized `type:'object'`/`properties` envelope instead of being
// discarded. Every real oneOf-union mount schema this repo produces today
// (batch) has branches that are themselves flat `{type:'object', properties,
// required}` objects sharing an identical field-name set (only the
// `operation` const and per-field item types vary per branch) — verified in
// `batch.ts`'s `branchInputSchema` — so unioning branch `properties` and
// intersecting branch `required` gives a genuinely useful, not-empty
// advertised schema, not a hand-wavy approximation.
// ---------------------------------------------------------------------------

/**
 * Derive a valid MCP `Tool.inputSchema` (`{type:'object', ...}`) from a
 * mount's real `Operation.input`, never silently discarding a real
 * `oneOf`-rooted schema down to an empty `{type:'object', properties:{}}`
 * unless there is genuinely nothing to recover.
 */
export function deriveMcpMountInputSchema(input: unknown): Record<string, unknown> {
  if (
    input &&
    typeof input === 'object' &&
    (input as Record<string, unknown>)['type'] === 'object'
  ) {
    // Already the required shape (e.g. health/openapi's genuinely zero-arg
    // `{}`-derived schemas never reach this branch; a real flat object schema
    // does) — pass through unchanged.
    return input as Record<string, unknown>;
  }

  const oneOf = (input as Record<string, unknown> | undefined)?.['oneOf'];
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    const properties: Record<string, unknown> = {};
    let requiredIntersection: string[] | null = null;
    for (const branch of oneOf) {
      if (!branch || typeof branch !== 'object') continue;
      const b = branch as Record<string, unknown>;
      const branchProps = b['properties'];
      if (branchProps && typeof branchProps === 'object') {
        for (const [key, schema] of Object.entries(
          branchProps as Record<string, unknown>
        )) {
          if (!(key in properties)) properties[key] = schema;
        }
      }
      const branchRequired = Array.isArray(b['required'])
        ? (b['required'] as string[])
        : [];
      requiredIntersection =
        requiredIntersection === null
          ? [...branchRequired]
          : requiredIntersection.filter((k) => branchRequired.includes(k));
    }
    return {
      ...(input as Record<string, unknown>), // preserves the real `oneOf`/`discriminator` (passthrough, per SDK's own $catchall)
      type: 'object',
      properties,
      ...(requiredIntersection && requiredIntersection.length > 0
        ? { required: requiredIntersection }
        : {}),
    };
  }

  // Genuinely nothing to recover (e.g. a bare `{}` zero-arg mount) — the
  // original safe fallback.
  return { type: 'object', properties: {} };
}

// ---------------------------------------------------------------------------
// §7.1 / §8 — `--use` mount composition (dod.11 / [mcp-adapter.7]) — mirrors
// fastify's `collectMountedOperations`, filtered to `'mcp'` instead of
// `'http'`. A wholly NEW mcp capability (mcp had zero mount support
// pre-migration).
// ---------------------------------------------------------------------------

function collectMountedOperations(
  usePlugins: UsePlugin[],
  useOptions: UseOptions,
  host: string,
  operations: Operation[],
  hostBridge?: MountHostBridge
): MountedOperation[] {
  const result: MountedOperation[] = [];
  const descriptor = { host, operations: operations as unknown[] };
  for (const plugin of usePlugins) {
    const cap = plugin.capabilities?.mount;
    if (!cap) continue;
    const ops = cap.operations(descriptor, useOptions[plugin.id], hostBridge);
    for (const op of ops) {
      // A mounted op is exposed on MCP unless it declares an explicit
      // `transports` filter that omits `'mcp'`.
      if (op.transports && !op.transports.includes('mcp')) continue;
      result.push(op as unknown as MountedOperation);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// buildToolTable — wire every package's ops (+ `--use` mounts) onto the
// adapter. Called EXACTLY ONCE per `run()` invocation ([mcp-adapter.8]).
// ---------------------------------------------------------------------------

function buildToolTable(input: RunInput, adapter: McpTransportAdapter): void {
  __toolTableBuildCount.count++;

  const projection =
    (input.options['projection'] as ProjectionConfig | undefined) ?? {};
  const descriptions =
    (input.options['toolDescriptions'] as Record<string, string>) ?? {};
  const usePlugins = readUsePlugins(input.options);
  const useOptions = readUseOptions(input.options);

  // (batch-rollout, BATCH_0.0.1.md §2/§F1, architect-review Finding 2)
  // Host-level accumulators, merged ACROSS every package this host serves —
  // hoisted out of the per-package loop below so a `MountHostBridge` (built
  // after the loop) can target ANY op from ANY package, not just the last one
  // processed. Each package's own per-package `schemasByOpId`/`fnsByOpId`
  // (used to build that package's own composed invoker) are unchanged and
  // still scoped per-package below — these are a SEPARATE, additional,
  // package-spanning table for hostBridge purposes only.
  const mergedSchemasByOpId: ComposedSchemas = {};
  const mergedFnsByOpId: Record<string, (...args: unknown[]) => unknown> = {};

  for (const pkg of input.packages) {
    if (!pkg.fns) throw new Error(`Package "${pkg.id}" is missing fns`);
    const pkgFns = pkg.fns;

    // Resolve every op once, remapping the package's fn-name-keyed
    // `fns`/`schemas` tables to be keyed by `op.id` (`dispatchForPlan` and the
    // validate-Layer both key by `plan.op.id` / `call.operation.id`).
    const resolved = Object.entries(pkg.schemas).map(([fnName, fnSchema]) => ({
      fnName,
      fnSchema,
      op: operationFor(
        { id: pkg.id, importPath: pkg.importPath },
        fnName,
        input.operations
      ),
    }));
    const schemasByOpId: ComposedSchemas = {};
    const fnsByOpId: Record<string, (...args: unknown[]) => unknown> = {};
    for (const { fnName, fnSchema, op } of resolved) {
      schemasByOpId[op.id] = fnSchema;
      fnsByOpId[op.id] = pkgFns[fnName];
      mergedSchemasByOpId[op.id] = fnSchema;
      mergedFnsByOpId[op.id] = pkgFns[fnName];
    }

    // [mcp-adapter.1] BUG-APIGEN-SERVE-CORE-001: compose the validate-Layer
    // (+ any `--use` layers) ONCE per package via `createPackageInvoker`,
    // then invoke through it per request. Rejects schema-violating input with
    // `ApiError{invalid_argument}` BEFORE the target function is ever called
    // — mcp never did this pre-migration.
    const invoke = createPackageInvoker(schemasByOpId, usePlugins);
    const invokeOpts: InvokeOptions = {
      fns: fnsByOpId,
      createClient: pkg.createClient,
      schemas: schemasByOpId,
    };

    for (const { fnName, fnSchema, op } of resolved) {
      // F3 [fix:transport-stamping]: stamp `transport: 'mcp'` here — the
      // MECHANISM is generic (`dispatchForPlan` reads `plan.transport` back),
      // never a hardcoded literal inside the shared primitives.
      const plan = buildOpPlan({ op, schema: fnSchema, transport: 'mcp', projection });
      adapter.bindSchema(op.id, fnSchema);

      // Only `outputSchema` is needed for the `tools/list` projection here —
      // `wrapped` is re-derived per-result inside `writeResult` from the SAME
      // schema (bound via `bindSchema` just above), so it isn't stored here.
      const { outputSchema } = buildMcpOutputSchema(
        (fnSchema as { output?: unknown }).output
      );
      const description = buildToolDescription(
        plan.mcp.name,
        fnSchema as { input?: { description?: unknown } },
        // Look up by the new canonical name first, falling back to the OLD
        // raw-fnName key for backward compat with existing `toolDescriptions`
        // option configs.
        descriptions[plan.mcp.name] ?? descriptions[fnName]
      );
      adapter.bindToolMeta(plan.mcp.name, {
        description,
        inputSchema: (fnSchema as { input?: unknown }).input,
        outputSchema,
      });
      adapter.registerRoute(plan, (call) =>
        dispatchForPlan(plan, invoke, call, invokeOpts)
      );
    }
  }

  // dod.11 / [mcp-adapter.7]: register `--use` mount ops. They flow through a
  // composed `--use` invoker so the `--use` layer capabilities observe mount
  // calls too, exactly like fastify's `[fix:mount-through-layers]`.
  const mountHost = input.packages[0]?.id ?? 'ts';

  // (batch-rollout Finding 1/2) The host bridge a mount plugin's handler uses
  // to invoke OTHER already-registered ops (e.g. `_batch/<kind>`'s fan-out
  // target) — built from the package-spanning merged tables above, through
  // the SAME composed `--use` invoker every request goes through (never a
  // bypass of auth/logging/validate).
  const hostInvoke = createPackageInvoker(mergedSchemasByOpId, usePlugins);
  const hostBridge: MountHostBridge = {
    invoke: (fnName, call, opts) =>
      hostInvoke(
        fnName,
        {
          operation: { id: fnName },
          ctx: new LayerContext(),
          domainArgs: call.domainArgs,
          envelope: call.envelope,
          signal: call.signal,
        },
        opts as InvokeOptions
      ),
    invokeOptions: {
      fns: mergedFnsByOpId,
      schemas: mergedSchemasByOpId,
      createClient: input.packages[0]?.createClient,
    },
  };

  const mountedOps = collectMountedOperations(
    usePlugins,
    useOptions,
    mountHost,
    input.operations ?? [],
    hostBridge
  );
  if (mountedOps.length > 0) {
    const mountInvoke = createPackageInvoker({}, usePlugins);
    const mountInvokeOpts: InvokeOptions = { fns: {}, schemas: {} };
    for (const mountedOp of mountedOps) {
      const plan = buildOpPlan({ op: mountedOp, transport: 'mcp', projection });
      // MCP's Tool.inputSchema is constrained to a top-level `{type:"object"}`
      // shape by the SDK's own zod validation (ToolSchema.inputSchema requires
      // a literal `type:"object"` — confirmed against
      // @modelcontextprotocol/sdk/dist/esm/types.js's ToolSchema, which also
      // carries `z.core.$catchall<z.ZodUnknown>` on inputSchema, meaning any
      // EXTRA sibling keys beyond type/properties/required pass through
      // unvalidated rather than being rejected). A mount's bare
      // `Operation.input` is often `{}` (no domain params, e.g. health/openapi
      // — genuinely representable as `{type:'object', properties:{}}`) or a
      // root-level `oneOf`+`discriminator` union (e.g. batch,
      // BUG-APIGEN-MCP-ROOT-ONEOF-001) that isn't already in the required
      // shape. `deriveMcpMountInputSchema` handles both without discarding the
      // real schema for the latter case.
      const mountInputSchema = deriveMcpMountInputSchema(mountedOp.input);
      // BUG-APIGEN-MCP-DISCOVERABILITY-001: mount ops have no `data` envelope
      // by design (see `apigen-core-client/src/lib/batch.ts`'s
      // `branchInputSchema` — a genuinely different, flat calling shape from
      // extracted operations) and never carry an `input.description` note,
      // so `buildToolDescription` contributes no envelope doc here — only
      // the schema-derived worked example, synthesized off the SAME
      // `mountInputSchema` actually advertised as this tool's `inputSchema`
      // below, so the example never drifts from the published shape.
      const description = buildToolDescription(
        plan.mcp.name,
        { input: mountInputSchema },
        descriptions[plan.mcp.name]
      );
      adapter.bindToolMeta(plan.mcp.name, {
        description,
        inputSchema: mountInputSchema,
      });
      adapter.registerRoute(plan, (call) =>
        dispatchForPlan(plan, mountInvoke, call, mountInvokeOpts)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// createMcpServer — cheap per-connection `Server` factory. Registers two
// closures over the ALREADY-hoisted `adapter` ([mcp-adapter.8]) — never
// re-derives OpPlan/schema/description work. Called once for `stdio`, once
// per SSE session, and once per `streaming-http` request (the SDK's own
// stateless-mode contract requires a fresh `Server`+transport pair per
// request — `Protocol.connect()` throws if a second transport connects
// before the first disconnects; see the module doc's discovered-bug note).
// ---------------------------------------------------------------------------

/**
 * The MCP `initialize` handshake identity for this process. Previously a
 * hardcoded `{ name: 'apigen-mcp', version: '1.0.0' }` literal — identical
 * across EVERY apigen-hosted MCP server (backlog, or any future host),
 * regardless of which real package/version was actually running, so an agent
 * connecting over stdio/SSE/streaming-http had no way to tell which build it
 * was talking to (MCP handshake identity finding, P5-cli-serve-transport).
 * Falls back to the old literal only when the mounted package genuinely
 * supplies neither `id` nor `version` (non-TS-extraction / test callers that
 * predate `PluginInput.packages[].version`).
 */
export interface McpServerIdentity {
  name: string;
  version: string;
}

function resolveMcpServerIdentity(input: RunInput): McpServerIdentity {
  const pkg = input.packages[0];
  return {
    name: pkg?.id ?? 'apigen-mcp',
    version: pkg?.version ?? '1.0.0',
  };
}

function createMcpServer(
  adapter: McpTransportAdapter,
  logger: Logger,
  identity: McpServerIdentity
): InstanceType<typeof Server> {
  const server = new Server(identity, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: adapter.listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs = {} } = req.params;
    const plan = adapter.getPlan(name);
    const dispatch = adapter.getDispatch(name);
    if (!plan || !dispatch) throw new Error(`Unknown tool: ${name}`);

    const args = rawArgs as Record<string, unknown>;
    const meta = (args['_meta'] as Record<string, unknown> | undefined) ?? {};
    const raw: McpRaw = { args, meta };
    const start = Date.now();
    try {
      const call = await adapter.readCall(raw, plan);
      const result = await dispatch(call);
      await adapter.writeResult(raw, result, plan);
      logger.info({ tool: name, ms: Date.now() - start }, `→ ${name}`);
      // `McpCallToolResult` (our own, transport-neutral shape — content +
      // optional isError/structuredContent) intentionally omits the SDK's
      // task-augmented-execution union member (`task: {...}`, a DIFFERENT
      // execution mode this adapter never opts into via `_meta`/`task`
      // params) — the `unknown` hop is an assertion past that unused union
      // branch, not an escape from real type-checking.
      return raw.output as unknown as ServerResult;
    } catch (err) {
      // See `logDispatchError`'s doc comment (mirrored from
      // `@adhd/apigen-plugin-cli-output`'s `run.ts`): an ordinary, EXPECTED
      // rejection (bad input, auth denial, not-found) never gets a full
      // stack trace with local absolute filesystem paths — only a genuine
      // `code: 'internal'` fault (or a non-`ApiError` throw) does.
      if (isApiError(err) && err.code !== 'internal') {
        logger.error({ tool: name, ms: Date.now() - start, code: err.code, message: err.message }, `✗ ${name}`);
      } else {
        logger.error({ tool: name, ms: Date.now() - start, err }, `✗ ${name}`);
      }
      adapter.writeError(raw, err, plan);
      // writeError always re-throws (§9 marshal for mcp) — unreachable, but
      // keeps this handler's control flow (and inferred return type) honest.
      throw err;
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// [mcp-adapter.9] BUG-APIGEN-MCP-STREAMING-HTTP-NO-ERROR-GUARD-001 fix — the
// SHARED raw-HTTP-level error guard both mcp HTTP transports (`sse` and
// `streaming-http`) funnel through. Pre-migration, `sse` had its own
// try/catch around this exact concern and `streaming-http` had none — a
// thrown error there became an unhandled rejection that could crash the
// whole process, tearing down every live session (including every other
// live `sse` stream) with it. Both surfaces now share ONE implementation.
// ---------------------------------------------------------------------------

function guardHttpTransport(
  logger: Logger,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.error({ err }, 'mcp http transport handler error');
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end('Internal Server Error');
    }
  };
}

// ---------------------------------------------------------------------------
// Transport lifecycle — shutdown + bind-failure reporting
// (BUG a4b5bad6 — promise never settles without an AbortSignal; BUG d6fd726f —
// no 'error' listener before listen() so bind failures never reach the caller).
//
// Every transport branch below terminates through ONE of these helpers, and
// none of them constructs a Promise whose resolve() is guarded by
// `if (input.signal)` — that guard is exactly what left `run()` pending
// forever when a caller omitted a signal.
// ---------------------------------------------------------------------------

/**
 * Resolve the mandatory AbortSignal for an HTTP transport. `sse`/
 * `streaming-http` have no natural EOF (unlike stdio's stdin close), so an
 * AbortSignal is the ONLY way their `run()` promise can ever settle. Rejecting
 * up front — with a typed `invalid_argument` naming the transport — beats
 * binding a server that can never be stopped and hanging the caller.
 */
function requireSignal(input: RunInput, transport: string): AbortSignal {
  const signal = input.signal;
  if (!signal) {
    throw new ApiError(
      'invalid_argument',
      `apigen mcp transport "${transport}" requires RunInput.signal (an AbortSignal) to shut down; none was supplied`
    );
  }
  return signal;
}

/**
 * Bind an HTTP server and translate its lifecycle into a `run()`-settling
 * promise:
 *
 *  - a bind failure (e.g. `EADDRINUSE`) REJECTS with a typed `internal`
 *    `ApiError` naming `host:port`, instead of emitting an unhandled `'error'`
 *    event that crashes the process and never reaches the caller. The
 *    `once('error')` listener is attached BEFORE `listen()` so the failure
 *    cannot race past it.
 *  - a successful bind swaps the one-shot reject-listener for a persistent
 *    error logger (post-bind server errors are logged, never fatal), then
 *    resolves when `signal` aborts and `server.close()` drains.
 */
function listenOrReject(
  httpServer: HttpServer,
  port: number,
  host: string,
  transport: string,
  logger: Logger,
  signal: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => {
      reject(
        new ApiError(
          'internal',
          `failed to bind mcp ${transport} server on ${host}:${port}: ${cause.message}`,
          { cause }
        )
      );
    };
    // Attach BEFORE listen(): a synchronous EADDRINUSE must never escape as an
    // unhandled 'error' event.
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      // Bind succeeded — drop the one-shot reject-listener and install a
      // persistent logger so later server-level errors are observability, not
      // a process-killing unhandled event.
      httpServer.removeListener('error', onError);
      httpServer.on('error', (err) => logger.error({ err }, 'mcp http server error'));
      logger.info({ host, port }, `listening on http://${host}:${port}`);
      const shutdown = () => {
        logger.info('mcp server shutting down');
        httpServer.close(() => resolve());
      };
      if (signal.aborted) {
        shutdown();
        return;
      }
      signal.addEventListener('abort', shutdown, { once: true });
    });
  });
}

/**
 * Settle the `stdio` transport's `run()` promise. Unlike the HTTP transports,
 * stdio has a natural shutdown signal — EOF on stdin, surfaced by the SDK as
 * `onclose`. So NO AbortSignal is required: `onclose` resolves unconditionally,
 * and a caller that ALSO supplies a signal additionally resolves on abort.
 * The resolve is therefore never inside an `if (signal)` guard.
 */
export function awaitStdioClose(
  t: Pick<StdioServerTransport, 'onclose'>,
  logger: Logger,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve) => {
    t.onclose = () => {
      logger.info('stdio transport closed (stdin EOF)');
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          logger.info('mcp server shutting down');
          resolve();
        },
        { once: true }
      );
    }
  });
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export async function run(input: RunInput): Promise<void> {
  const transport = (input.options['transport'] as string) ?? 'stdio';
  const port = (input.options['port'] as number) ?? 3000;
  const host = (input.options['host'] as string) ?? '127.0.0.1';
  // Fall back to a default stderr logger so logging never lands on stdout (the
  // stdio JSON-RPC channel) even when the CLI did not supply one.
  const logger = input.logger ?? createLogger();

  logger.info(`mcp server starting (${transport})`);

  // [mcp-adapter.8] toolMetas hoist: built EXACTLY ONCE here, regardless of
  // transport or how many requests a stateless HTTP transport later serves.
  const adapter = new McpTransportAdapter();
  buildToolTable(input, adapter);

  const tools = adapter.listTools();
  const toolNames = tools.map((t) => t.name);
  logger.info({ tools: toolNames }, `${toolNames.length} tools available`);
  for (const name of toolNames) {
    const plan = adapter.getPlan(name);
    const params = plan?.params ?? [];
    const text = params
      .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
      .join(', ');
    logger.info(
      { tool: name, args: { data: params } },
      `tool: ${name}  args { data: {${text ? ` ${text} ` : ''}} }`
    );
  }

  const identity = resolveMcpServerIdentity(input);
  logger.info({ identity }, `mcp handshake identity: ${identity.name}@${identity.version}`);

  if (transport === 'stdio') {
    const server = createMcpServer(adapter, logger, identity);
    const t = new StdioServerTransport();
    await server.connect(t);
    logger.info('stdio transport ready');
    // stdio has a natural shutdown (stdin EOF → onclose), so no signal is
    // required; a supplied one is an additional out-of-band stop.
    return awaitStdioClose(t, logger, input.signal);
  }

  if (transport === 'sse') {
    // `sse` has no natural EOF — require an AbortSignal up front so run() can
    // always settle, and never binds a server the caller cannot stop.
    const signal = requireSignal(input, transport);
    // SSEServerTransport is per-connection: instantiate per GET request, route
    // POSTs by sessionId. A fresh `Server` per session (via `createMcpServer`,
    // cheap — it shares the hoisted `adapter`) — the MCP SDK's
    // `Protocol.connect()` only supports ONE live transport per `Server`
    // instance at a time (see module doc's discovered-bug note); this also
    // fixes the pre-migration single-shared-`Server` bug for free.
    const sessions = new Map<string, SSEServerTransport>();

    const httpServer = createServer(
      guardHttpTransport(logger, async (req, res) => {
        const url = req.url ?? '';
        if (req.method === 'GET' && url === '/sse') {
          const server = createMcpServer(adapter, logger, identity);
          const sseTransport = new SSEServerTransport('/messages', res);
          sessions.set(sseTransport.sessionId, sseTransport);
          sseTransport.onclose = () => sessions.delete(sseTransport.sessionId);
          // server.connect() calls transport.start() internally, which writes
          // the `endpoint` SSE event. Do NOT call start() again — the SDK
          // throws "SSEServerTransport already started!" and the unhandled
          // rejection would crash the whole process (this is exactly what
          // `guardHttpTransport` now prevents even if it did throw).
          await server.connect(sseTransport);
        } else if (req.method === 'POST' && url.startsWith('/messages')) {
          const sessionId = new URLSearchParams(url.split('?')[1] ?? '').get(
            'sessionId'
          );
          const sseTransport = sessionId ? sessions.get(sessionId) : undefined;
          if (!sseTransport) {
            res.writeHead(404);
            res.end('Session not found');
            return;
          }
          await sseTransport.handlePostMessage(req, res);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      })
    );

    return listenOrReject(httpServer, port, host, transport, logger, signal);
  }

  // streaming-http transport — stateless mode. The StreamableHTTPServerTransport
  // is single-use per connection in stateless mode: each request needs its own
  // transport AND `Server` instance (the SDK's own official stateless example,
  // `simpleStatelessStreamableHttp`, does the same — `Protocol.connect()`
  // rejects a second transport on the same `Server`). Only `createMcpServer()`
  // (cheap: two closures over the hoisted `adapter`) runs per request now —
  // the EXPENSIVE `buildToolTable()` work above ran exactly once
  // ([mcp-adapter.8]).
  //
  // `streaming-http`, like `sse`, has no natural EOF — require an AbortSignal
  // up front so run() can always settle.
  const signal = requireSignal(input, transport);
  const httpServer = createServer(
    guardHttpTransport(logger, async (req, res) => {
      const server = createMcpServer(adapter, logger, identity);
      const mcpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(mcpTransport);
      await mcpTransport.handleRequest(req, res);
    })
  );
  return listenOrReject(httpServer, port, host, transport, logger, signal);
}
