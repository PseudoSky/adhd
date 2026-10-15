import { ApiError } from '@adhd/apigen-base-errors';
import type { SchemaNode, TranscodeCtx, Wire } from '@adhd/apigen-base-logical';
import {
  buildTranscoder,
  createRegistry,
  registerWellKnown,
} from '@adhd/apigen-base-logical';
import type { ComposedSchemas } from './types';

// ---------------------------------------------------------------------------
// Module-level transcoder: built once from the well-known TS scalar codecs.
// Frozen registry → safe to share across concurrent dispatch calls.
// ---------------------------------------------------------------------------
const _registry = createRegistry();
registerWellKnown(_registry);
const _transcoder = buildTranscoder(_registry.freeze());

/**
 * The client factory `dispatch` builds a function's `ctx` with. The second
 * argument carries the invocation's cancellation signal (adhd ADR-0019 D4,
 * SPEC §8.1): a `ctx`-taking function receives the signal through the `ctx`
 * its host's factory builds, never as a positional argument. It is passed
 * only when the invocation has a signal, so a factory written against the
 * one-argument form sees exactly the call it always saw.
 */
export type CreateClientFn = (
  envelope: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// $ref resolution (adhd ADR-0019 / REMEDIATION-PLAN R3 behaviour change 4)
// ---------------------------------------------------------------------------

/** The local definition pointers the extractors emit: `#/definitions/<name>` and `#/$defs/<name>`. */
const DEFINITION_POINTER = /^#\/(?:definitions|\$defs)\/(.+)$/;

/** Keys that make a schema node more than a bare alias of another `$ref`. */
const STRUCTURAL_KEYS = [
  'type',
  'properties',
  'items',
  'oneOf',
  'anyOf',
  'allOf',
  'enum',
  'const',
  'additionalProperties',
  'format',
];

/**
 * Normalise a definition name taken from a `$ref` pointer or a definitions
 * key: JSON-pointer unescaping (`~1` → `/`, `~0` → `~`) after percent
 * decoding (`ts-json-schema-generator` percent-encodes generic names such as
 * `Page<User>` in the pointer but keys the definition by the raw name).
 */
function normaliseDefinitionName(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A literal `%` that is not an escape: keep the raw spelling.
  }
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The transcoder ctx override of one composed schema entry; `undefined` when the entry declares no definitions. */
type EntryTranscodeCtx = Partial<TranscodeCtx> | undefined;

/**
 * One ctx override per composed schema entry and operation name, built on
 * first use and reused: the schema objects are immutable once composed, so
 * the definitions walk runs once per entry rather than once per call. Keyed
 * by name as well because one schema object may back several operations, and
 * the resolver's errors name the operation.
 */
const transcodeCtxCache = new WeakMap<object, Map<string, EntryTranscodeCtx>>();

/**
 * Collect every `definitions` / `$defs` dictionary in `node` (at any depth)
 * into `into`, keyed by normalised definition name. The first definition seen
 * for a name wins, matching the order a document-root lookup would use.
 * Keys already written as a full pointer (`'#/$defs/User'`, the hand-built
 * fixture convention `validateComposedRefs` also accepts) are normalised to
 * their bare name.
 */
function collectDefinitions(
  node: unknown,
  into: Map<string, SchemaNode>,
  seen: Set<object>
): void {
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectDefinitions(item, into, seen);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const defKey of ['definitions', '$defs']) {
    const defs = obj[defKey];
    if (defs === null || typeof defs !== 'object' || Array.isArray(defs)) continue;
    for (const [key, def] of Object.entries(defs as Record<string, unknown>)) {
      const pointer = DEFINITION_POINTER.exec(key);
      const name = normaliseDefinitionName(pointer?.[1] ?? key);
      if (!into.has(name) && def !== null && typeof def === 'object') {
        into.set(name, def as SchemaNode);
      }
    }
  }
  for (const value of Object.values(obj)) collectDefinitions(value, into, seen);
}

/** True when `node` is a pure alias: a `$ref` with no structure of its own. */
function isRefAlias(node: SchemaNode): boolean {
  if (typeof node['$ref'] !== 'string') return false;
  return !STRUCTURAL_KEYS.some((key) => key in node);
}

/**
 * The transcoder ctx override for one composed schema entry: a
 * definitions-backed `resolve()`, so a `$ref` decodes and encodes instead of
 * hitting the transcoder's run-mode stub ("cannot be resolved in run-mode
 * without a descriptor root"). The definitions come from the entry's `input` root
 * (`composeSchemas` hoists them there) and its `output` root (the extractor
 * hoists them there), so one resolver serves both directions.
 *
 * A recursive type resolves on demand: the transcoder walks the VALUE, so a
 * self-referential definition terminates with the data. Only a chain of pure
 * aliases that returns to itself (`A → B → A` with no structure in between)
 * can never terminate; it is rejected here, naming the chain.
 *
 * @throws ApiError('internal') naming the operation and the pointer, when a
 *   pointer is not a local definition pointer, names no collected definition,
 *   or starts an alias cycle. These are server-side schema defects, not caller
 *   errors.
 */
function transcodeCtxFor(
  fnName: string,
  schema: ComposedSchemas[string]
): EntryTranscodeCtx {
  let byName = transcodeCtxCache.get(schema);
  if (byName === undefined) {
    byName = new Map();
    transcodeCtxCache.set(schema, byName);
  }
  if (byName.has(fnName)) return byName.get(fnName);
  const definitions = new Map<string, SchemaNode>();
  const seen = new Set<object>();
  collectDefinitions(schema.input, definitions, seen);
  collectDefinitions(schema.output, definitions, seen);
  const lookup = (ref: string): SchemaNode => {
    const match = DEFINITION_POINTER.exec(ref);
    const def =
      match?.[1] === undefined
        ? undefined
        : definitions.get(normaliseDefinitionName(match[1]));
    if (def === undefined) {
      throw new ApiError(
        'internal',
        `apigen dispatch: operation "${fnName}" has an unresolved $ref "${ref}" (no matching local definition in its schema)`
      );
    }
    return def;
  };
  const resolve = (ref: string): SchemaNode => {
    const chain = [ref];
    let node = lookup(ref);
    while (isRefAlias(node)) {
      const next = node['$ref'] as string;
      if (chain.includes(next)) {
        throw new ApiError(
          'internal',
          `apigen dispatch: operation "${fnName}" has a cyclic $ref alias chain (${[...chain, next].join(' -> ')})`
        );
      }
      chain.push(next);
      node = lookup(next);
    }
    return node;
  };
  // No definitions: keep the transcoder's own default (its run-mode stub),
  // so a schema with no definitions behaves exactly as before.
  const ctx: EntryTranscodeCtx = definitions.size === 0 ? undefined : { resolve };
  byName.set(fnName, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// Cancellation (adhd ADR-0019 D4, SPEC §8.1)
// ---------------------------------------------------------------------------

/**
 * The error an aborted dispatch rejects with: `ApiError('internal')` whose
 * message names the operation and carries "aborted", plus the abort reason
 * when the signal has one.
 */
function abortedError(fnName: string, signal: AbortSignal): ApiError {
  const reason: unknown = signal.reason;
  let detail = '';
  if (reason instanceof Error) detail = reason.message;
  else if (reason !== undefined) detail = String(reason);
  return new ApiError(
    'internal',
    `apigen dispatch: operation "${fnName}" aborted${detail.length > 0 ? `: ${detail}` : ''}`
  );
}

/**
 * Settle with `work`, or reject with {@link abortedError} the moment `signal`
 * aborts, whichever comes first. The abort listener is removed once `work`
 * settles, so a long-lived signal shared by many calls accumulates no
 * listeners. A `work` rejection that arrives after the abort already won is
 * observed and dropped (never an unhandled rejection).
 */
function raceAbort<T>(
  work: Promise<T>,
  fnName: string,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(abortedError(fnName, signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortedError(fnName, signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/** Returns true when the composed schema has `field` in input.properties (i.e. an envelope field). */
export function needsEnvelopeField(
  fnSchema: ComposedSchemas[string],
  field: string
): boolean {
  const props =
    ((fnSchema.input as Record<string, unknown>)?.['properties'] as Record<
      string,
      unknown
    >) ?? {};
  return field in props;
}

/** Returns ordered domain parameter names (keys of the data: {} sub-object). */
export function dataParamNames(fnSchema: ComposedSchemas[string]): string[] {
  const data = (
    (fnSchema.input as Record<string, unknown>)?.['properties'] as Record<
      string,
      unknown
    >
  )?.['data'] as Record<string, unknown> | undefined;
  return Object.keys((data?.['properties'] as Record<string, unknown>) ?? {});
}

/**
 * Return the resolved schema node for a single domain parameter.
 * Navigates `schema.input.properties.data.properties[paramName]`.
 * Returns `undefined` when the node is absent (plain-JSON passthrough).
 */
function paramSchemaNode(
  fnSchema: ComposedSchemas[string],
  paramName: string
): SchemaNode | undefined {
  const dataProps = (
    (
      (fnSchema.input as Record<string, unknown>)?.['properties'] as Record<
        string,
        unknown
      >
    )?.['data'] as Record<string, unknown> | undefined
  )?.['properties'] as Record<string, unknown> | undefined;
  const node = dataProps?.[paramName];
  return node !== undefined ? (node as SchemaNode) : undefined;
}

/**
 * Decode a single wire value against its schema node using the module-level
 * transcoder. When no node is present the value passes through unchanged.
 *
 * BUG-APIGEN-027: an ABSENT optional param (`wire === undefined` — the caller
 * simply omitted it, which is valid whenever the param isn't in the schema's
 * `required` array) must also pass through unchanged, exactly like the
 * `node === undefined` case above it. Before this guard, `_transcoder.decode`
 * was called with `undefined` for every declared param the caller omitted,
 * regardless of the node's type. For a bare `{type:'number'}` node this
 * resolves to `numberSpecialCodec`, whose `decode()` correctly rejects
 * `undefined` in strict mode (it's not a valid number OR one of the
 * NaN/Infinity/-Infinity sentinels) — so ANY optional numeric param a caller
 * omitted crashed dispatch with "[number-special] unrecognized wire value at
 * \"\": undefined", even though the AJV schema had already correctly allowed
 * the omission (the param isn't `required`). This mirrors the guard
 * `encodeNode`/`decodeNode`'s own OBJECT-property walk already applies
 * internally in `runmode.ts` (`if (v !== undefined)`) — this was the one
 * top-level per-parameter call site that lacked it, because dispatch calls
 * the transcoder once per declared param name rather than walking a nested
 * object schema.
 */
function decodeArg(
  wire: unknown,
  node: SchemaNode | undefined,
  ctx: Partial<TranscodeCtx> | undefined
): unknown {
  if (node === undefined || wire === undefined) return wire;
  return _transcoder.decode(wire as Wire, node, ctx);
}

/**
 * Encode the function's return value against the output schema node.
 * When the output schema is empty ({}), the value passes through unchanged.
 */
function encodeResult(
  value: unknown,
  fnSchema: ComposedSchemas[string],
  ctx: Partial<TranscodeCtx> | undefined
): unknown {
  const outputSchema = fnSchema.output as SchemaNode;
  // An empty object schema `{}` has no `type` — the transcoder treats it as
  // schema-less / plain-JSON passthrough; only typed output schemas are encoded.
  if (!outputSchema || Object.keys(outputSchema).length === 0) return value;
  return _transcoder.encode(value, outputSchema, ctx);
}

/**
 * Single canonical dispatch path used by ALL plugins in both generate and run modes.
 * No plugin may inline this logic. [inv:dispatch-single-path]
 *
 * Logical-type decode/encode seam (DESIGN.md §4.4 / §6):
 *   - BEFORE calling the fn: each domain arg is decoded from wire → host using
 *     the schema node at `input.properties.data.properties[k]`. A param whose
 *     node carries `{type:string, format:date-time}` arrives as a real `Date`;
 *     a plain `string` node passes through unchanged.
 *   - AFTER the fn returns: the result is encoded from host → wire using the
 *     output schema. A `Date` return becomes an RFC 3339 string; plain JSON
 *     values pass through unchanged.
 *
 * `$ref` resolution: a param or output node that is (or contains) a local
 * `$ref` resolves against the definitions of the operation's own composed
 * schema entry (see {@link transcodeCtxFor}); the transcoder's run-mode stub is
 * never reached for a schema that carries its definitions.
 *
 * Cancellation (adhd ADR-0019 D4): `signal` is never a positional argument of
 * the user function. A `ctx`-taking function receives it through
 * `createClient(envelope, { signal })`. A signal that is already aborted
 * rejects before any argument is decoded or any client is built; a signal
 * that aborts while the function runs rejects the dispatch at once (the
 * function's own later settlement is dropped). Both rejections are
 * `ApiError('internal')` carrying "aborted".
 *
 * All existing behaviors (session ctx injection, BUG-APIGEN-001 ctx-param path,
 * envelope handling) are preserved unchanged.
 *
 * @param fns          The live function table (fn-name → implementation).
 * @param createClient The `ctx` factory, or `undefined` when the host has none.
 * @param schema       The operation's composed schema entry.
 * @param fnName       The dispatch-table key of the function to call.
 * @param envelope     The request's envelope side-channel.
 * @param domainArgs   The request's domain arguments (wire form).
 * @param signal       The invocation's cancellation signal, when it has one.
 * @returns The function's result, encoded host → wire.
 */
export async function dispatch(
  fns: Record<string, (...args: unknown[]) => unknown>,
  createClient: CreateClientFn | undefined,
  schema: ComposedSchemas[string],
  fnName: string,
  envelope: Record<string, unknown>,
  domainArgs: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  if (signal?.aborted) throw abortedError(fnName, signal);
  return raceAbort(
    dispatchUnguarded(fns, createClient, schema, fnName, envelope, domainArgs, signal),
    fnName,
    signal
  );
}

/** The body of {@link dispatch}, without the abort race. */
async function dispatchUnguarded(
  fns: Record<string, (...args: unknown[]) => unknown>,
  createClient: CreateClientFn | undefined,
  schema: ComposedSchemas[string],
  fnName: string,
  envelope: Record<string, unknown>,
  domainArgs: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<unknown> {
  const paramNames = dataParamNames(schema);
  const transcodeCtx = transcodeCtxFor(fnName, schema);
  const buildClient = (
    factory: CreateClientFn,
    clientEnvelope: Record<string, unknown>
  ): Promise<unknown> =>
    signal === undefined ? factory(clientEnvelope) : factory(clientEnvelope, { signal });

  // ── Decode: wire → host for every domain arg ───────────────────────────────
  const args = paramNames.map((k) =>
    decodeArg(domainArgs[k], paramSchemaNode(schema, k), transcodeCtx)
  );

  // Session middleware: build ctx from the session envelope and inject it as the
  // first arg. Preserves [dod.4] envelope behavior.
  if (needsEnvelopeField(schema, 'session') && createClient) {
    const ctx = await buildClient(createClient, { session: envelope['session'] });
    const raw = await (
      fns[fnName] as (ctx: unknown, ...a: unknown[]) => unknown
    )(ctx, ...args);
    return encodeResult(raw, schema, transcodeCtx);
  }

  // ctx-param fn WITHOUT session middleware (BUG-APIGEN-001): the source fn's
  // first param is named `ctx` ([inv:ctx-name-only]), so it must still receive a
  // first arg or the first DOMAIN arg lands in the ctx slot. Build ctx via
  // createClient when a client exists, else pass undefined (the fn may ignore it).
  if (schema.hasCtx) {
    const ctx = createClient ? await buildClient(createClient, envelope) : undefined;
    const raw = await (
      fns[fnName] as (ctx: unknown, ...a: unknown[]) => unknown
    )(ctx, ...args);
    return encodeResult(raw, schema, transcodeCtx);
  }

  const raw = await fns[fnName](...args);
  return encodeResult(raw, schema, transcodeCtx);
}
