import type { SchemaNode, TranscodeCtx } from '@adhd/apigen-base-logical';
import {
  buildTranscoder,
  createRegistry,
  registerWellKnown,
  rootRefResolver,
} from '@adhd/apigen-base-logical';
import type { ComposedSchemas } from './types';

// ---------------------------------------------------------------------------
// Module-level transcoder: built once from the well-known TS scalar codecs.
// Frozen registry → safe to share across concurrent dispatch calls.
// ---------------------------------------------------------------------------
const _registry = createRegistry();
registerWellKnown(_registry);
const _transcoder = buildTranscoder(_registry.freeze());

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
  ctx: Partial<TranscodeCtx>
): unknown {
  if (node === undefined || wire === undefined) return wire;
  return _transcoder.decode(
    wire as import('@adhd/apigen-base-logical').Wire,
    node,
    ctx
  );
}

/**
 * Build a transcoder context whose `$ref` resolver is bound to one schema
 * document root (the op's `input` or `output` schema, whose `definitions` /
 * `$defs` the extractor hoisted onto that root).
 *
 * A `$ref` that does not match any definition throws an error naming both the
 * ref and the operation id, so the failure points at the schema, not the codec.
 *
 * @param root  The schema document the `$ref`s inside it are relative to.
 * @param fnName The operation id, used only in the error message.
 */
function refCtx(root: SchemaNode, fnName: string): Partial<TranscodeCtx> {
  const lookup = rootRefResolver(root);
  return {
    resolve: (ref: string): SchemaNode => {
      try {
        return lookup(ref);
      } catch {
        throw new Error(
          `[apigen-engine-runtime] op "${fnName}": $ref "${ref}" has no matching definition in this operation's schema (define it under "definitions" or "$defs" on the schema root)`
        );
      }
    },
  };
}

/**
 * Encode the function's return value against the output schema node.
 * When the output schema is empty ({}), the value passes through unchanged.
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
  return _transcoder.encode(value, outputSchema, refCtx(outputSchema, fnName));
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
 * All existing behaviors (session ctx injection, BUG-APIGEN-001 ctx-param path,
 * envelope handling) are preserved unchanged.
 */
export async function dispatch(
  fns: Record<string, (...args: unknown[]) => unknown>,
  createClient: ((e: Record<string, unknown>) => Promise<unknown>) | undefined,
  schema: ComposedSchemas[string],
  fnName: string,
  envelope: Record<string, unknown>,
  domainArgs: Record<string, unknown>
): Promise<unknown> {
  const paramNames = dataParamNames(schema);

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
    const ctx = await createClient({ session: envelope['session'] });
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
    const ctx = createClient ? await createClient(envelope) : undefined;
    const raw = await (
      fns[fnName] as (ctx: unknown, ...a: unknown[]) => unknown
    )(ctx, ...args);
    return encodeResult(raw, fnName, schema);
  }

  const raw = await fns[fnName](...args);
  return encodeResult(raw, fnName, schema);
}
