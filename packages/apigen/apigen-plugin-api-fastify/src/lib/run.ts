import type { ApiErrorCode } from '@adhd/apigen-base-errors';
import { HTTP_STATUS, isApiError } from '@adhd/apigen-base-errors';
import type {
  ComposedSchemas,
  MountedOperation,
  Operation,
  RunInput,
} from '@adhd/apigen-core-client';
import type { ProjectionConfig } from '@adhd/apigen-engine-naming';
import type {
  ApiStream,
  Call as RuntimeCall,
  InvokeOptions,
  LayerResult,
  OpPlan,
  ParamInfo,
  TransportAdapter,
  UseOptions,
  UsePlugin,
} from '@adhd/apigen-engine-runtime';
import {
  buildOpPlan,
  coerceQueryParams,
  createLogger,
  createPackageInvoker,
  describeParams,
  dispatchForPlan,
  isApiStream,
  readUseOptions,
  readUsePlugins,
} from '@adhd/apigen-engine-runtime';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
} from 'fastify';
import Fastify from 'fastify';
import { operationFor } from './route-projection';
import { sendStreamSse } from './stream';

// ---------------------------------------------------------------------------
// serve-core migration (fastify-adapter — the REFERENCE TransportAdapter).
//
// api-fastify is now a thin `TransportAdapter<FastifyRaw>` over the
// transport-neutral serve-core primitives shipped in
// `@adhd/apigen-engine-runtime`:
//
//   - `buildOpPlan`         — resolves route/verb/envelope/streaming/mount for
//                             one op ONCE, from the `Operation` + composed
//                             schema (route/verb projection previously
//                             hand-rolled in `route-projection.ts` now lives
//                             here — [fastify-adapter.4]).
//   - `createPackageInvoker`— composes the `--use` layer stack + validate-Layer
//                             ONCE per package. Absorbs the byte-identical
//                             `buildInvokerForPackage`/`readUsePlugins`/
//                             `readUseOptions`/`adaptCoreLayer` block that used
//                             to live in THIS file ([fix:invoker-promotion] /
//                             [fastify-adapter.8]).
//   - `dispatchForPlan`     — branches source-op vs `--use` mount op; the mount
//                             branch flows through the SAME composed `--use`
//                             invoker as source ops ([fix:mount-through-layers])
//                             and stamps the core-client `Call.transport` from
//                             `plan.transport` ([fix:transport-stamping]).
//
// Two intentional, reviewed behavior changes over the pre-migration server
// ([inv:byte-identical] flagged exceptions), each proven by the parity gate /
// the dedicated streaming test in `plugin.spec.ts`:
//
//   1. STREAMING NOW SERVED (DEBT-APIGEN-SERVE-CORE-002, fastify half): a
//      `streaming:true` op's `ApiStream` result is projected to live SSE via
//      `sendStreamSse` from `writeResult` ([fix:streaming-wired] /
//      [fastify-adapter.3]). Pre-migration `sendStreamSse` had ZERO call sites
//      and the stream was mis-serialized through `JSON.stringify`.
//   2. MOUNT-THROUGH-LAYERS (DEBT-APIGEN-SERVE-CORE-004): `--use` mount ops
//      (e.g. `_meta/health`) now dispatch through the composed `--use` layer
//      stack instead of calling `handler(call)` directly, so `--use`
//      auth/logging layers now also observe mount calls. The lossy
//      `MountRoute`/`collectMountRoutes` bottleneck (which hardcoded
//      `{method:'GET',text:'',params:[]}`) is gone; mount ops carry full
//      kind/safe/input through `OpPlan`.
// ---------------------------------------------------------------------------

/** The transport-native carrier the fastify adapter marshals to/from. */
export interface FastifyRaw {
  req: FastifyRequest;
  reply: FastifyReply;
}

// ---------------------------------------------------------------------------
// §9 — map ApiError to HTTP status (shared by the adapter's writeError and the
// framework-level fallback error handler).
// ---------------------------------------------------------------------------

function toHttpStatus(err: unknown): number {
  // BUG-APIGEN-PLUGIN-IN-PROCESS-VALIDATE-500-001: duck-typed check, not
  // `instanceof ApiError` — see isApiError()'s doc comment for why the
  // referential check is unsafe across bundled @adhd/* packages.
  if (isApiError(err)) {
    return HTTP_STATUS[err.code] ?? 500;
  }
  return 500;
}

/** The §9 error body an ApiError (or unknown throw) marshals to. */
function toErrorBody(err: unknown): Record<string, unknown> {
  if (isApiError(err)) return err.toJSON() as Record<string, unknown>;
  return {
    code: 'internal' as ApiErrorCode,
    message: err instanceof Error ? err.message : 'Internal error',
  };
}

// ---------------------------------------------------------------------------
// Logging (unchanged surface — routes are now sourced from OpPlan projections).
// ---------------------------------------------------------------------------

interface Route {
  method: string;
  route: string;
  text: string;
  params: ParamInfo[];
}

interface LogEntry {
  method: string;
  route: string;
  params?: ParamInfo[];
  body?: { data: ParamInfo[] };
}

function logRoutes(logger: RunInput['logger'], routes: Route[]): void {
  if (logger) {
    for (const r of routes) {
      const entry: LogEntry = { method: r.method, route: r.route };
      let str = `${r.method} ${r.route}`;
      if (r.params.length) {
        if (entry.method === 'GET') {
          str += `  params {${r.text ? ` ${r.text} ` : ''}}`;
        } else {
          str += `  body { data: {${r.text ? ` ${r.text} ` : ''}} }`;
        }
      }
      logger.info(r, str);
    }
  }
}

// ---------------------------------------------------------------------------
// FastifyTransportAdapter — the REFERENCE TransportAdapter port implementation.
// ---------------------------------------------------------------------------

/**
 * The fastify `TransportAdapter`. `readCall`/`writeResult`/`writeError` are the
 * genuinely transport-specific seam; everything transport-neutral
 * (route/verb/envelope/streaming/mount resolution) is already resolved on the
 * `OpPlan` it receives.
 */
class FastifyTransportAdapter implements TransportAdapter<FastifyRaw> {
  /** op.id → composed schema, for GET query-param coercion (source ops only). */
  private readonly schemasByOpId = new Map<string, ComposedSchemas[string]>();

  constructor(
    private readonly app: FastifyInstance,
    private readonly routePrefix: string,
    private readonly signal?: AbortSignal
  ) {}

  /**
   * Associate an op's composed schema with its plan so `readCall` can coerce
   * GET query strings to their declared domain types (FEAT-APIGEN-022). Mount
   * ops carry no composed schema and are never bound.
   */
  bindSchema(opId: string, schema: ComposedSchemas[string]): void {
    this.schemasByOpId.set(opId, schema);
  }

  /** The path this plan is served at (prefix + projected route). */
  private routeFor(plan: OpPlan): string {
    // A `--use` mount op is served at its canonical id slug (e.g.
    // `/_meta/health`) — the `_meta` convention `project()` would kebab away
    // — preserving the pre-migration mount route exactly ([inv:byte-identical]).
    if (plan.isMount) return `${this.routePrefix}/${plan.op.id}`;
    return this.routePrefix + plan.http.route;
  }

  registerRoute(
    plan: OpPlan,
    dispatch: (
      call: Omit<RuntimeCall, 'operation' | 'ctx'>
    ) => Promise<LayerResult>
  ): void {
    const route = this.routeFor(plan);
    const handler = async (
      req: FastifyRequest,
      reply: FastifyReply
    ): Promise<void> => {
      const raw: FastifyRaw = { req, reply };
      try {
        const call = await this.readCall(raw, plan);
        const result = await dispatch(call);
        await this.writeResult(raw, result, plan);
      } catch (err) {
        await this.writeError(raw, err, plan);
      }
    };

    // We deliberately omit `schema: { body: fnSchema.input }` — generated
    // schemas use oneOf/anyOf shapes that Fastify's AJV rejects at route
    // registration time. Validation is performed by the validate-Layer in the
    // composed invoker instead ([plugin-api-fastify.4]).
    if (plan.http.verb === 'GET') this.app.get(route, handler);
    else this.app.post(route, handler);
  }

  readCall(
    raw: FastifyRaw,
    plan: OpPlan
  ): Omit<RuntimeCall, 'operation' | 'ctx'> {
    const { req } = raw;
    const headers = req.headers as Record<
      string,
      string | string[] | undefined
    >;

    // §9.1 envelope from headers — driven entirely off the resolved OpPlan
    // envelope bindings (no per-request schema re-derivation).
    const envelope: Record<string, unknown> = {};
    for (const field of plan.envelope) {
      const value = headers[field.httpHeader];
      if (value !== undefined) envelope[field.field] = value;
    }

    let domainArgs: Record<string, unknown> = {};
    if (!plan.isMount) {
      const schema = this.schemasByOpId.get(plan.op.id);
      if (plan.http.verb === 'GET') {
        // FEAT-APIGEN-022: query strings are always strings — coerce to the
        // domain schema's declared number/integer/boolean types before
        // validation, scoped to this GET path only (never touches POST/body).
        const query = (req.query as Record<string, unknown>) ?? {};
        domainArgs = schema ? coerceQueryParams(query, schema) : query;
      } else {
        const { data = {} } =
          (req.body as Record<string, unknown> | undefined) ?? {};
        domainArgs = data as Record<string, unknown>;
      }
    }

    return { envelope, domainArgs, signal: this.signal };
  }

  async writeResult(
    raw: FastifyRaw,
    result: LayerResult,
    _plan: OpPlan
  ): Promise<void> {
    const { req, reply } = raw;

    // [fix:streaming-wired]: a streaming op resolves to an `ApiStream` — project
    // it to live SSE (hijacks the reply and writes frames directly).
    if (isApiStream(result)) {
      await sendStreamSse(result as ApiStream<unknown>, req, reply);
      return;
    }

    // BUG-APIGEN-015: serialise every scalar/object result as canonical JSON
    // (`application/json`) so a scalar logical return (`Decimal`/`int64`/`Date`
    // encoded to a string) is byte-identical to the py-flask host — not a bare
    // `text/plain` body. `undefined` (void op) becomes `null`.
    reply.type('application/json');
    reply.send(JSON.stringify(result === undefined ? null : result));
  }

  writeError(raw: FastifyRaw, err: unknown, _plan: OpPlan): void {
    const { reply } = raw;
    reply.status(toHttpStatus(err)).send(toErrorBody(err));
  }
}

// ---------------------------------------------------------------------------
// §7.1 / §8 — `--use` mount composition (BUG-APIGEN-010 / DEBT-APIGEN-SERVE-
// CORE-004): collect the FULL `MountedOperation`s contributed by `--use` mount
// plugins so each flows through `buildOpPlan` + `dispatchForPlan`'s mount
// branch with full fidelity (kind/safe/input/handler) — replacing the old
// lossy `MountRoute{route,handler}` bottleneck.
//
// BUG-APIGEN-024: `operations` must be the REAL merged descriptor (threaded
// from `RunInput.operations`), not a hardcoded `[]` — a mount plugin like
// `apigen-plugin-openapi` derives its output entirely from
// `descriptor.operations`.
// ---------------------------------------------------------------------------

function collectMountedOperations(
  usePlugins: UsePlugin[],
  useOptions: UseOptions,
  host: string,
  operations: Operation[]
): MountedOperation[] {
  const result: MountedOperation[] = [];
  const descriptor = { host, operations: operations as unknown[] };
  for (const plugin of usePlugins) {
    const cap = plugin.capabilities?.mount;
    if (!cap) continue;
    const ops = cap.operations(descriptor, useOptions[plugin.id]);
    for (const op of ops) {
      // A mounted op is exposed on HTTP unless it declares an explicit
      // `transports` filter that omits `'http'`.
      if (op.transports && !op.transports.includes('http')) continue;
      result.push(op as unknown as MountedOperation);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// run — wire every package's ops (and `--use` mounts) onto the adapter.
// ---------------------------------------------------------------------------

export async function run(input: RunInput): Promise<void> {
  const port = (input.options['port'] as number) ?? 3000;
  const host = (input.options['host'] as string) ?? '127.0.0.1';
  const routePrefix = (input.options['routePrefix'] as string) ?? '';
  const projection =
    (input.options['projection'] as ProjectionConfig | undefined) ?? {};
  const usePlugins = readUsePlugins(input.options);
  const useOptions = readUseOptions(input.options);
  // Use the shared pino instance as Fastify's logger so per-request logging is
  // native + consistent; fall back to a default stderr logger when absent.
  const logger = input.logger ?? createLogger();
  // Cast the options to the base `FastifyServerOptions` so `Fastify()` returns
  // the default-generic `FastifyInstance` rather than one whose (invariant)
  // logger generic is narrowed to the pino `Logger` type — which would not be
  // assignable to the adapter's `FastifyInstance` field. The real pino instance
  // is still passed and used at runtime; only the static type is widened.
  const app = Fastify({ logger } as FastifyServerOptions);

  // Framework-level fallback error handler: catches errors Fastify raises
  // BEFORE a route handler runs (e.g. a malformed JSON body). Domain errors
  // thrown inside a handler are marshalled by the adapter's `writeError`; this
  // is the safety net for everything upstream of that. Same §9 mapping.
  app.setErrorHandler((err, _req, reply) => {
    reply.status(toHttpStatus(err)).send(toErrorBody(err));
  });

  const adapter = new FastifyTransportAdapter(app, routePrefix, input.signal);
  const routes: Route[] = [];

  for (const pkg of input.packages) {
    if (!pkg.fns) throw new Error(`Package "${pkg.id}" is missing fns`);
    const pkgFns = pkg.fns;

    // Resolve every op once. `dispatchForPlan` dispatches by `plan.op.id` (and
    // the validate-Layer keys `schemas` by `call.operation.id`), so the
    // package's fn-name-keyed `fns`/`schemas` tables must be REMAPPED to be
    // keyed by `op.id` — otherwise the validate-Layer + dispatch look up a key
    // that never exists ("no schema found") and every request 500s.
    const resolved = Object.entries(pkg.schemas).map(([fnName, fnSchema]) => ({
      fnName,
      fnSchema,
      op: operationFor(
        pkg.id,
        fnName,
        fnSchema as Record<string, unknown>,
        input.operations
      ),
    }));
    const schemasByOpId: ComposedSchemas = {};
    const fnsByOpId: Record<string, (...args: unknown[]) => unknown> = {};
    for (const { fnName, fnSchema, op } of resolved) {
      schemasByOpId[op.id] = fnSchema;
      fnsByOpId[op.id] = pkgFns[fnName];
    }

    // BUG-APIGEN-009: compose the validate-Layer (+ any `--use` layers) around
    // dispatch ONCE per package via the promoted `createPackageInvoker`, then
    // invoke through it per request. Rejects schema-violating input with
    // ApiError{invalid_argument} BEFORE the target function is ever called.
    const invoke = createPackageInvoker(schemasByOpId, usePlugins);
    const invokeOpts: InvokeOptions = {
      fns: fnsByOpId,
      createClient: pkg.createClient,
      schemas: schemasByOpId,
    };

    for (const { fnSchema, op } of resolved) {
      // [fix:transport-stamping] / [fastify-adapter.9]: stamp `transport` onto
      // the plan here (fastify is the HTTP transport). The MECHANISM is generic
      // — `dispatchForPlan` reads `plan.transport` back to tag the core-client
      // `Call.transport`, never a hardcoded literal — so mcp/cli/py adapters
      // stamp their own transport the same way.
      const plan = buildOpPlan({
        op,
        schema: fnSchema,
        transport: 'http',
        projection,
      });
      adapter.bindSchema(op.id, fnSchema);
      adapter.registerRoute(plan, (call) =>
        dispatchForPlan(plan, invoke, call, invokeOpts)
      );
      const { params, text } = describeParams(fnSchema);
      routes.push({
        method: plan.http.verb,
        route: routePrefix + plan.http.route,
        text,
        params,
      });
    }
  }

  // BUG-APIGEN-010 / DEBT-APIGEN-SERVE-CORE-004: register `--use` mount ops
  // (health, openapi, …). They flow through a composed `--use` invoker so the
  // `--use` layer capabilities observe them too ([fix:mount-through-layers]).
  const mountHost = input.packages[0]?.id ?? 'ts';
  const mountedOps = collectMountedOperations(
    usePlugins,
    useOptions,
    mountHost,
    input.operations ?? []
  );
  if (mountedOps.length > 0) {
    // A composed invoker for mount dispatch: the `--use` layers apply; the
    // validate-Layer is a no-op for mount ids (empty schema map → not found →
    // pass-through), and `dispatchForPlan` supplies the synthetic per-call
    // fn/schema entry keyed to the mount op's id.
    const mountInvoke = createPackageInvoker({}, usePlugins);
    const mountInvokeOpts: InvokeOptions = { fns: {}, schemas: {} };
    for (const mountedOp of mountedOps) {
      const plan = buildOpPlan({ op: mountedOp, transport: 'http', projection });
      adapter.registerRoute(plan, (call) =>
        dispatchForPlan(plan, mountInvoke, call, mountInvokeOpts)
      );
      routes.push({
        method: plan.http.verb,
        route: `${routePrefix}/${mountedOp.id}`,
        text: '',
        params: [],
      });
    }
  }

  await app.listen({ port, host });
  logger.info({ host, port }, `listening on http://${host}:${port}`);
  logRoutes(logger, routes);
  return new Promise((resolve) => {
    if (input.signal) {
      input.signal.addEventListener('abort', async () => {
        await app.close();
        resolve();
      });
    }
  });
}
