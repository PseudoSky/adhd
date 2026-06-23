import type { LogicalKind, LogicalTypeId, SchemaNode } from './contracts';

/** @stable Reserved descriptor keywords (advisory; structure via format/$ref/oneOf is authoritative). */
export const X_APIGEN_LOGICAL = 'x-apigen-logical' as const;   // "scalar"|"nominal"|"union"|"map"|"set"
export const X_APIGEN_CODEC   = 'x-apigen-codec'   as const;   // the LogicalTypeId
export const X_APIGEN_CTOR    = 'x-apigen-ctor'    as const;   // optional decode hint
export const X_APIGEN_TOJSON  = 'x-apigen-tojson'  as const;   // optional encode hint
/** @stable Bumped on any wire-table OR pinned-lib-version change. */
export const LOGICAL_TYPE_VERSION = '0.1.0' as const;

const LOGICAL_KINDS: readonly LogicalKind[] = ['scalar', 'nominal', 'union', 'map', 'set'];

/**
 * @stable Read the advisory `x-apigen-logical` hint off a resolved schema node.
 *
 * Per invariant `[inv:hints-advisory]` the key is OPTIONAL: returns `undefined`
 * (never throws) when the key is absent or carries an unrecognized value. The
 * authoritative kind is derived from structure (format/$ref/oneOf); this is a
 * dispatch accelerator only.
 */
export function logicalKindOf(node: SchemaNode): LogicalKind | undefined {
  const raw = node[X_APIGEN_LOGICAL];
  return typeof raw === 'string' && (LOGICAL_KINDS as readonly string[]).includes(raw)
    ? (raw as LogicalKind)
    : undefined;
}

/**
 * @stable Read the advisory `x-apigen-codec` id off a resolved schema node.
 *
 * Per invariant `[inv:hints-advisory]` the key is OPTIONAL: returns `undefined`
 * (never throws) when the key is absent or not a string.
 */
export function codecIdOf(node: SchemaNode): LogicalTypeId | undefined {
  const raw = node[X_APIGEN_CODEC];
  return typeof raw === 'string' ? raw : undefined;
}
