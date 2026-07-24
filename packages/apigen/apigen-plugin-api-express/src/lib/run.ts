import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { pinoHttp } from 'pino-http';
import {
  buildOpPlan,
  coerceQueryParams,
  createLogger,
  createPackageInvoker,
  describeParams,
  dispatchForPlan,
  readUseOptions,
  readUsePlugins,
} from '@adhd/apigen-engine-runtime';
import type {
  Call as RuntimeCall,
  ComposedSchemas,
  InvokeOptions,
  LayerResult,
  OpPlan,
  ParamInfo,
  TransportAdapter,
  UseOptions,
  UsePlugin,
} from '@adhd/apigen-engine-runtime';
import type {
  MountedOperation,
  Operation,
  RunInput,
} from '@adhd/apigen-core-client';
import type { Server } from 'node:http';
import { HTTP_STATUS, isApiError } from '@adhd/apigen-base-errors';
import type { ProjectionConfig } from '@adhd/apigen-engine-naming';
import type { ApiErrorCode } from '@adhd/apigen-base-errors';
import { operationFor } from './route';

// ---------------------------------------------------------------------------
// serve-core migration (express-adapter) — express collapses onto the SAME
// TransportAdapter/OpPlan primitives `apigen-plugin-api-fastify` established
// as the REFERENCE implementation:
//
//   - `buildOpPlan`         — resolves route/verb/envelope/streaming/mount for
//                             one op ONCE, from the `Operation` + composed
//                             schema (route/verb projection previously
//                             hand-rolled in `./route.ts`'s index-then-lookup
//                             resolver now lives here — [express-adapter.2]).
//   - `createPackageInvoker`— composes the `--use` layer stack + validate-Layer
//                             ONCE per package. Absorbs the byte-identical
//                             invoker-composition block (the `--use` plugin
//                             reader + core-layer adapter + per-package
//                             invoker builder) that used to live in THIS
//                             file — now DELETED here ([fix:invoker-promotion]
//                             / [express-adapter.1] / [express-adapter.6]).
//   - `dispatchForPlan`     — branches source-op vs `--use` mount op; the mount
//                             branch flows through the SAME composed `--use`
//                             invoker as source ops and stamps the
//                             core-client `Call.transport` from
//                             `plan.transport` ([fix:transport-stamping]).
//
// ONE intentional, flagged behavior change over the pre-migration server
// ([inv:byte-identical] flagged exception), proven by the parity gate's
// dedicated void-return fixture in `route-parity.spec.ts`:
//
//   DEBT-APIGEN-SERVE-CORE-003 CLOSED: a void-returning op's result is
//   normalized `undefined -> null` before serialization, matching fastify's
//   `writeResult` exactly ([fix:void-result-null]). Verified by direct
//   measurement against the PRE-migration server (not assumed from the
//   backlog text, which described this as "204 empty" — that description was
//   inaccurate): pre-migration, `res.json(undefined)` actually sent
//   `200` with an EMPTY body (`""`), `content-type: application/json`. Post-
//   migration it sends `200` with body `"null"` — the real, verified
//   behavior change this migration closes.
//
// Express never wired the `--use` mount call through the composed `--use`
// layer stack differently than source ops even pre-migration (it called
// `handler(call)` directly) — `dispatchForPlan`'s mount branch now routes it
// through the SAME composed invoker as source ops (mechanism is generic to
// `dispatchForPlan`, not express-specific — see
// `apigen-engine-runtime/src/lib/dispatch-for-plan.ts`'s doc comment). Mount
// op RESPONSES (status/body) are unchanged; only `--use` layer *observation*
// of mount calls changes, matching fastify's DEBT-APIGEN-SERVE-CORE-004
// closure, which the shared primitive gives every adapter that adopts it.
// ---------------------------------------------------------------------------

/** The transport-native carrier the express adapter marshals to/from. */
export interface ExpressRaw {
  req: Request;
  res: Response;
}

// ---------------------------------------------------------------------------
// §9 — map ApiError to HTTP status (shared by the adapter's writeError and
// the framework-level fallback error handler).
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
// ExpressTransportAdapter — the express `TransportAdapter` port implementation.
// ---------------------------------------------------------------------------

/**
 * The express `TransportAdapter`. `readCall`/`writeResult`/`writeError` are
 * the genuinely transport-specific seam; everything transport-neutral
 * (route/verb/envelope/streaming/mount resolution) is already resolved on
 * the `OpPlan` it receives.
 */
class ExpressTransportAdapter implements TransportAdapter<ExpressRaw> {
  /** op.id → composed schema, for GET query-param coercion (source ops only). */
  private readonly schemasByOpId = new Map<string, ComposedSchemas[string]>();

  constructor(
    private readonly router: Router,
    private readonly routePrefix: string,
    private readonly signal?: AbortSignal
  ) {}

  /**
   * Associate an op's composed schema with its plan so `readCall` can coerce
   * GET query strings to their declared domain types (FEAT-APIGEN-022).
   * Mount ops carry no composed schema and are never bound.
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
    const handler = async (req: Request, res: Response): Promise<void> => {
      const raw: ExpressRaw = { req, res };
      try {
        const call = await this.readCall(raw, plan);
        const result = await dispatch(call);
        await this.writeResult(raw, result, plan);
      } catch (err) {
        await this.writeError(raw, err, plan);
      }
    };

    if (plan.http.verb === 'GET') this.router.get(route, handler);
    else this.router.post(route, handler);
  }

  readCall(
    raw: ExpressRaw,
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

  writeResult(raw: ExpressRaw, result: LayerResult, _plan: OpPlan): void {
    const { res } = raw;
    // [fix:void-result-null] / DEBT-APIGEN-SERVE-CORE-003: normalize a void
    // op's `undefined` result to `null` before handing it to `res.json` —
    // matching fastify's `writeResult` exactly (byte-identical body `"null"`
    // for a void return, `200` status either way). Pre-migration,
    // `res.json(undefined)` sent `200` with an EMPTY body (verified by direct
    // measurement — NOT the `204` the original backlog entry assumed).
    // Every non-void result is otherwise serialized by `res.json` exactly as
    // before this migration — no behavior change for any other fixture.
    res.json(result === undefined ? null : result);
  }

  writeError(raw: ExpressRaw, err: unknown, _plan: OpPlan): void {
    const { res } = raw;
    res.status(toHttpStatus(err)).json(toErrorBody(err));
  }
}

// ---------------------------------------------------------------------------
// §7.1 / §8 — `--use` mount composition (BUG-APIGEN-010 / DEBT-APIGEN-SERVE-
// CORE-004): collect the FULL `MountedOperation`s contributed by `--use`
// mount plugins so each flows through `buildOpPlan` + `dispatchForPlan`'s
// mount branch with full fidelity (kind/safe/input/handler) — replacing the
// old lossy `MountRoute{route,handler}` bottleneck.
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
  // Fall back to a default stderr logger when the CLI did not supply one.
  const logger = input.logger ?? createLogger();

  const app = express();
  // pino-http logs every request via the shared logger instance.
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  const router = Router();
  const adapter = new ExpressTransportAdapter(router, routePrefix, input.signal);

  const routes: Array<{
    method: string;
    route: string;
    text: string;
    params: ParamInfo[];
  }> = [];

  for (const pkg of input.packages) {
    if (!pkg.fns) throw new Error(`Package "${pkg.id}" is missing fns`);
    const pkgFns = pkg.fns;

    // Resolve every op once. `dispatchForPlan` dispatches by `plan.op.id`
    // (and the validate-Layer keys `schemas` by `call.operation.id`), so the
    // package's fn-name-keyed `fns`/`schemas` tables must be REMAPPED to be
    // keyed by `op.id` — otherwise the validate-Layer + dispatch look up a
    // key that never exists ("no schema found") and every request 500s.
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

    // BUG-APIGEN-009: compose the validate-Layer (+ any `--use` layers)
    // around dispatch ONCE per package via the promoted
    // `createPackageInvoker`, then invoke through it per request. Rejects
    // schema-violating input with ApiError{invalid_argument} BEFORE the
    // target function is ever called.
    const invoke = createPackageInvoker(schemasByOpId, usePlugins);
    const invokeOpts: InvokeOptions = {
      fns: fnsByOpId,
      createClient: pkg.createClient,
      schemas: schemasByOpId,
    };

    for (const { fnSchema, op } of resolved) {
      // [fix:transport-stamping]: stamp `transport` onto the plan here
      // (express is the HTTP transport). The MECHANISM is generic —
      // `dispatchForPlan` reads `plan.transport` back to tag the
      // core-client `Call.transport`, never a hardcoded literal — so
      // mcp/cli/py adapters stamp their own transport the same way.
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
  // (health, openapi, …). They flow through a composed `--use` invoker so
  // the `--use` layer capabilities observe them too.
  const mountHost = input.packages[0]?.id ?? 'ts';
  const mountedOps = collectMountedOperations(
    usePlugins,
    useOptions,
    mountHost,
    input.operations ?? []
  );
  if (mountedOps.length > 0) {
    // A composed invoker for mount dispatch: the `--use` layers apply; the
    // validate-Layer is a no-op for mount ids (empty schema map → not found
    // → pass-through), and `dispatchForPlan` supplies the synthetic per-call
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

  app.use(router);

  // §9 framework-level fallback error handler: catches errors Express raises
  // BEFORE a route handler runs (e.g. a malformed JSON body from
  // `express.json()`). Domain errors thrown inside a handler are marshalled
  // by the adapter's `writeError`; this is the safety net for everything
  // upstream of that. Same §9 mapping.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(toHttpStatus(err)).json(toErrorBody(err));
    }
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });
  logger.info({ host, port }, `listening on http://${host}:${port}`);
  for (const r of routes)
    logger.info(
      { method: r.method, route: r.route, body: { data: r.params } },
      `${r.method} ${r.route}  body { data: {${r.text ? ` ${r.text} ` : ''}} }`
    );

  return new Promise((resolve) => {
    if (input.signal) {
      input.signal.addEventListener('abort', () => {
        server.close(() => resolve());
      });
    }
  });
}
