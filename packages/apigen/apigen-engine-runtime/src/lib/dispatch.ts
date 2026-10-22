import { ApiError } from '@adhd/apigen-base-errors';
import type { SchemaNode, TranscodeCtx, Wire } from '@adhd/apigen-base-logical';
import {
  buildTranscoder,
  createRegistry,
  registerWellKnown,
  rootRefResolver,
} from '@adhd/apigen-base-logical';
import type { ComposedSchemas } from './types';
import type { ApiStream } from './stream';
import { isApiStream } from './stream';

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
 * Build a transcoder context whose `$ref` resolver is bound to one schema
 * document root (the op's `input` or `output` schema, whose `definitions` /
 * `$defs` the extractor hoisted onto that root).
 *
 * A `$ref` that is unsupported or has no matching definition throws an error
 * naming both the ref and the operation id (the resolver's `E_EMIT` message is
 * kept, and the original `EmitError` is attached as `cause`), so the failure
 * points at the schema, not the codec.
 *
 * @param root  The schema document the `$ref`s inside it are relative to.
 * @param fnName The operation id, used only in the error message.
 */
function refCtx(root: SchemaNode, fnName: string): Partial<TranscodeCtx> {
  const lookup = rootRefResolver(root);
  return {
    resolve: (ref: string): SchemaNode => {
      // `rootRefResolver` (apigen-base-logical) is the single owner of which
      // `$ref` forms are resolvable: it throws an `E_EMIT` EmitError for an
      // unsupported form and a distinct one for a missing definition. Re-throw
      // with the op id prefixed and the EmitError kept as `cause`, so the
      // failure points at the schema and the original diagnosis is not lost.
      try {
        return lookup(ref);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        // The package compiles below ES2022, whose `lib` lacks `ErrorOptions`,
        // so the standard `cause` property is attached by assignment.
        const wrapped: Error & { cause?: unknown } = new Error(
          `[apigen-engine-runtime] op "${fnName}": ${detail}`
        );
        wrapped.cause = cause;
        throw wrapped;
      }
    },
  };
}

/**
 * Wrap a stream so each chunk is encoded against the declared chunk schema.
 * The wrapper is itself an `ApiStream`, so transports still take the SSE
 * branch. Iteration is delegated to the source's `for await`, so a consumer's
 * `break` or cancellation reaches the source's `return()`.
 */
function encodeChunks(
  source: ApiStream<unknown>,
  chunkSchema: SchemaNode,
  ctx: Partial<TranscodeCtx>
): ApiStream<Wire> {
  return {
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<Wire> {
      for await (const chunk of source) {
        yield _transcoder.encode(chunk, chunkSchema, ctx);
      }
    },
  };
}

/**
 * Encode the function's return value against the output schema node.
 *
 * When the output schema is empty ({}), the value passes through unchanged.
 * A streaming result (`isApiStream`) is never transcoded as a single value:
 * the transcoder would walk the output schema's properties against the
 * iterator object and return `{}`. Instead the stream is kept and each chunk
 * is encoded against the output schema (the chunk schema).
 * `$ref`s in the output schema resolve against the output schema's own root.
 */
function encodeResult(
  value: unknown,
  fnName: string,
  fnSchema: ComposedSchemas[string]
): unknown {
  const outputSchema = fnSchema.output as SchemaNode;
  // An empty object schema `{}` has no `type` — the transcoder treats it as
  // schema-less / plain-JSON passthrough; only typed output schemas are encoded.
  if (!outputSchema || Object.keys(outputSchema).length === 0) return value;
  const ctx = refCtx(outputSchema, fnName);
  // Ruling: a streaming result is NOT returned as the identical object the fn
  // produced. The returned value is a new ApiStream (same `Symbol.asyncIterator`
  // contract, so transports still take the SSE branch) whose chunks are
  // wire-encoded against the output schema. Identity is intentionally not
  // preserved; consumers must rely on the ApiStream contract, not on `===`.
  if (isApiStream(value)) return encodeChunks(value, outputSchema, ctx);
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
 * `$ref` resolution: a param node's `$ref`s resolve against the operation's
 * `input` schema root and a result's against its `output` root (where the
 * extractor hoisted `definitions` / `$defs`), via {@link refCtx}; the
 * transcoder's run-mode stub is never reached for a schema that carries its
 * definitions. A streaming result is returned as a new stream whose chunks are
 * encoded against the output schema.
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
  const buildClient = (
    factory: CreateClientFn,
    clientEnvelope: Record<string, unknown>
  ): Promise<unknown> =>
    signal === undefined ? factory(clientEnvelope) : factory(clientEnvelope, { signal });

  // ── Decode: wire → host for every domain arg ───────────────────────────────
  // Param `$ref`s resolve against the input schema root (where the extractor
  // hoists `definitions`/`$defs` for the `data` envelope).
  const inputCtx = refCtx(schema.input as SchemaNode, fnName);
  const args = paramNames.map((k) =>
    decodeArg(domainArgs[k], paramSchemaNode(schema, k), inputCtx)
  );

  // Session middleware: build ctx from the session envelope and inject it as the
  // first arg. Preserves [dod.4] envelope behavior.
  if (needsEnvelopeField(schema, 'session') && createClient) {
    const ctx = await buildClient(createClient, { session: envelope['session'] });
    const raw = await (
      fns[fnName] as (ctx: unknown, ...a: unknown[]) => unknown
    )(ctx, ...args);
    return encodeResult(raw, fnName, schema);
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
    return encodeResult(raw, fnName, schema);
  }

  const raw = await fns[fnName](...args);
  return encodeResult(raw, fnName, schema);
}
