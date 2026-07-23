import express, { Router } from 'express';
import { pinoHttp } from 'pino-http';
import {
  createInvoker,
  makeValidateLayer,
  createLogger,
  describeParams,
  coerceQueryParams,
  LayerContext,
} from '@adhd/apigen-engine-runtime';
import type {
  Call as RuntimeCall,
  Layer,
  ParamInfo,
} from '@adhd/apigen-engine-runtime';
import type {
  RunInput,
  ComposedSchemas,
  Operation,
} from '@adhd/apigen-core-client';
import type { Server } from 'node:http';
import { envelopeKey } from '@adhd/apigen-engine-naming';
import { HTTP_STATUS, isApiError } from '@adhd/apigen-base-errors';
import type { ProjectionConfig } from '@adhd/apigen-engine-naming';
import type { ApiErrorCode } from '@adhd/apigen-base-errors';
import { buildOperationIndex, resolveRoute } from './route';

// ---------------------------------------------------------------------------
// §5 — route + verb from the canonical `project()` projection
// (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 / BUG-APIGEN-025 /
// FEAT-APIGEN-022) — see `./route.ts` for the full derivation + why `run()`
// prefers the REAL `Operation[]` threaded via `RunInput.operations`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §9.1 — envelope from HTTP headers (x-<pluginId>-<field>)
// ---------------------------------------------------------------------------

function extractEnvelopeFromHeaders(
  schema: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>
): Record<string, unknown> {
  const inputProps =
    ((schema['input'] as Record<string, unknown> | undefined)?.[
      'properties'
    ] as Record<string, unknown> | undefined) ?? {};
  const meta = schema['x-apigen-envelope'] as
    | Record<string, string>
    | undefined;
  const envelope: Record<string, unknown> = {};
  for (const field of Object.keys(inputProps)) {
    if (field === 'data') continue;
    const pluginId = meta?.[field] ?? 'adhd';
    const headerName = envelopeKey(pluginId, field);
    const value = headers[headerName];
    if (value !== undefined) envelope[field] = value;
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// §9 — map ApiError to HTTP status
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

// ---------------------------------------------------------------------------
// §7.1 / §8 — `--use` Layer + Mount composition (BUG-APIGEN-009 / -010)
// ---------------------------------------------------------------------------

/**
 * A loaded `--use` plugin object (SPEC §7.1).  We only depend on the shape we
 * actually consume here (layer / mount capabilities) so the transport adapter
 * stays decoupled from the full `Plugin` type surface.
 */
interface UsePlugin {
  id: string;
  capabilities?: {
    layer?: {
      layer: (
        call: unknown,
        next: () => Promise<unknown>
      ) => Promise<unknown> | AsyncIterable<unknown>;
    };
    mount?: {
      operations: (
        descriptor: { host: string; operations: unknown[] },
        opts?: Record<string, unknown>
      ) => Array<{
        id: string;
        transports?: string[];
        handler: (call: unknown) => unknown;
      }>;
    };
  };
}

/** Per-`--use` plugin option bag, keyed by plugin id (carried on options.useOptions). */
type UseOptions = Record<string, Record<string, unknown>>;

/**
 * Read the loaded `--use` plugins off `input.options`.  The CLI loads the
 * specifiers into real plugin objects and threads them here (RunInput carries no
 * dedicated field, so they ride on `options.usePlugins`).
 */
function readUsePlugins(options: Record<string, unknown>): UsePlugin[] {
  const raw = options['usePlugins'];
  return Array.isArray(raw) ? (raw as UsePlugin[]) : [];
}

function readUseOptions(options: Record<string, unknown>): UseOptions {
  const raw = options['useOptions'];
  return raw && typeof raw === 'object' ? (raw as UseOptions) : {};
}

/**
 * Adapt a core `LayerCapability.layer` (which receives the SPEC §7.1 `Call`
 * shape with `.data`) into a runtime {@link Layer} (which threads the §8.1
 * `Call` with `.domainArgs`).  The runtime Call already carries `operation.id`,
 * `envelope`, `ctx`, and `signal`; we additionally surface `.data` (an alias of
 * `domainArgs`) so layers written against either shape see their fields.
 */
function adaptCoreLayer(
  cap: NonNullable<NonNullable<UsePlugin['capabilities']>['layer']>
): Layer {
  return async function useLayer(call: RuntimeCall, next): Promise<unknown> {
    const view = Object.assign(call, { data: call.domainArgs });
    const result = await cap.layer(view, next as () => Promise<unknown>);
    return result;
  };
}

/**
 * Compose the request-path invoker for one package: the `--use` layer plugins
 * (outermost-first, in declaration order) wrapping the central validate-Layer
 * (innermost, immediately before dispatch — BUG-APIGEN-009).
 */
function buildInvokerForPackage(
  schemas: ComposedSchemas,
  usePlugins: UsePlugin[]
) {
  const layers: Layer[] = [];
  for (const plugin of usePlugins) {
    const cap = plugin.capabilities?.layer;
    if (cap) layers.push(adaptCoreLayer(cap));
  }
  // validate-Layer is ALWAYS innermost so malformed input is rejected before
  // dispatch is ever reached (SPEC §6 / §8.1 rule 1).
  layers.push(makeValidateLayer(schemas));
  return createInvoker(layers);
}

/**
 * A mount route resolved from a `--use` mount plugin: the synthetic op's id
 * (e.g. `_meta/health`) becomes `GET /_meta/health`, answered by its handler.
 */
interface MountRoute {
  route: string;
  handler: (call: unknown) => unknown;
}

/**
 * Collect HTTP mount routes contributed by the `--use` mount plugins
 * (BUG-APIGEN-010).  A mounted op is exposed on HTTP unless it declares an
 * explicit `transports` filter that omits `'http'`.
 *
 * BUG-APIGEN-024: `operations` must be the REAL merged descriptor (threaded
 * from `RunInput.operations` — see orchestrator.ts's `orchestrateRun`), not a
 * hardcoded `[]` — a mount plugin like `apigen-plugin-openapi` derives its
 * output entirely from `descriptor.operations`, so an empty stub here always
 * produced an empty OpenAPI `paths: {}` regardless of what was actually
 * extracted.
 */
function collectMountRoutes(
  usePlugins: UsePlugin[],
  useOptions: UseOptions,
  host: string,
  routePrefix: string,
  operations: Operation[]
): MountRoute[] {
  const routes: MountRoute[] = [];
  const descriptor = { host, operations };
  for (const plugin of usePlugins) {
    const cap = plugin.capabilities?.mount;
    if (!cap) continue;
    const ops = cap.operations(descriptor, useOptions[plugin.id]);
    for (const op of ops) {
      if (op.transports && !op.transports.includes('http')) continue;
      // The op id is the canonical slug (e.g. `_meta/health`); mount it as a
      // top-level route so `GET /_meta/health` resolves (task contract).
      routes.push({ route: `${routePrefix}/${op.id}`, handler: op.handler });
    }
  }
  return routes;
}

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

  // BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001: index the REAL merged
  // `Operation[]` (threaded through since BUG-APIGEN-024) once up front so
  // every function route below can be projected via the SAME `project()` call
  // `@adhd/apigen-plugin-openapi` uses — full path fidelity, including
  // multi-segment paths a static codegen pass could never recover. Falls back
  // to a synthesized single-segment `Operation` (see `./route.ts`) only when
  // no real descriptor was threaded through (non-TS-extraction run paths per
  // `RunInput.operations`'s own doc comment) — never crashes the server.
  const operationIndex = buildOperationIndex(input.operations ?? []);

  const app = express();
  // pino-http logs every request via the shared logger instance.
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  const router = Router();

  const routes: Array<{
    method: string;
    route: string;
    text: string;
    params: ParamInfo[];
  }> = [];

  for (const pkg of input.packages) {
    // BUG-APIGEN-009: compose the validate-Layer (+ any `--use` layers) around
    // dispatch ONCE per package, then invoke through it per request. The
    // invoker rejects schema-violating input with ApiError{invalid_argument}
    // BEFORE the target function is ever called.
    const invoke = buildInvokerForPackage(pkg.schemas, usePlugins);
    if (!pkg.fns) throw new Error(`Package "${pkg.id}" is missing fns`);
    const invokeOpts = {
      fns: pkg.fns,
      createClient: pkg.createClient,
      schemas: pkg.schemas,
    };

    for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
      const { route, verb } = resolveRoute(
        pkg.id,
        fnName,
        fnSchema as Record<string, unknown>,
        operationIndex,
        routePrefix,
        projection
      );
      const { params, text } = describeParams(fnSchema);
      routes.push({ method: verb, route, text, params });

      if (verb === 'GET') {
        // safe op: domain args from query string, envelope from request headers
        router.get(route, async (req, res, next) => {
          try {
            const envelope = extractEnvelopeFromHeaders(
              fnSchema as Record<string, unknown>,
              req.headers as Record<string, string | string[] | undefined>
            );
            const call: RuntimeCall = {
              operation: { id: fnName },
              ctx: new LayerContext(),
              envelope,
              // FEAT-APIGEN-022: query strings are always strings — coerce to
              // the domain schema's declared number/integer/boolean types
              // before validation, scoped to this GET path only (never
              // touches POST/body validation — see coerce-query.ts).
              domainArgs: coerceQueryParams(
                req.query as Record<string, unknown>,
                fnSchema
              ),
              signal: input.signal,
            };
            const result = await invoke(fnName, call, invokeOpts);
            res.json(result);
          } catch (err) {
            next(err);
          }
        });
      } else {
        // unsafe op: domain args from body.data, envelope from request headers
        router.post(route, async (req, res, next) => {
          try {
            const { data = {} } =
              (req.body as Record<string, unknown> | undefined) ?? {};
            const envelope = extractEnvelopeFromHeaders(
              fnSchema as Record<string, unknown>,
              req.headers as Record<string, string | string[] | undefined>
            );
            const call: RuntimeCall = {
              operation: { id: fnName },
              ctx: new LayerContext(),
              envelope,
              domainArgs: data as Record<string, unknown>,
              signal: input.signal,
            };
            const result = await invoke(fnName, call, invokeOpts);
            res.json(result);
          } catch (err) {
            next(err);
          }
        });
      }
    }
  }

  // BUG-APIGEN-010: register `--use` mount plugins (health, …) as real HTTP
  // routes. The health plugin declares `_meta/health` → GET /_meta/health.
  const mountHost = input.packages[0]?.id ?? 'ts';
  const mountRoutes = collectMountRoutes(
    usePlugins,
    useOptions,
    mountHost,
    routePrefix,
    input.operations ?? []
  );
  for (const m of mountRoutes) {
    routes.push({ method: 'GET', route: m.route, text: '', params: [] });
    router.get(m.route, async (req, res, next) => {
      try {
        const call = {
          operation: { id: m.route },
          data: {},
          envelope: {},
          ctx: new LayerContext(),
          transport: 'http',
          signal: input.signal ?? new AbortController().signal,
          raw: req,
        };
        res.json(await m.handler(call));
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(router);

  // §9 error handler — maps ApiError codes to correct HTTP status.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const status = toHttpStatus(err);
      const body = isApiError(err)
        ? err.toJSON()
        : {
            code: 'internal' as ApiErrorCode,
            message: (err as Error).message ?? 'Internal error',
          };
      res.status(status).json(body);
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
