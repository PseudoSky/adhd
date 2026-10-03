import { Transform as _ } from '@adhd/data-base-transforms';

/**
 * A compiled field accessor.
 *
 * `source` is the caller's ORIGINAL reference (`'a.b'`, `'x,y[0]'`,
 * `'items[0].sku'`, …); `segments` is its `toPath` canonicalisation — the
 * transforms grammar treats `.`, `,`, `[` and `]` as equivalent separators, so
 * `'a.b'`, `'a,b'` and `'a[0]'` (for a one-element object key) all canonicalise
 * to the same segment list.
 *
 * Resolution is EXACT-NAME-FIRST, PATH-FALLBACK:
 *   1. if the row has an OWN property whose literal name is the whole `source`
 *      (`'a.b'`), return it. This is what makes a grouped output key — stored
 *      FLAT under its raw path name by `finalizeEntry` — addressable
 *      downstream by `order_by` / `distinct_on` / `having` / `select`; and
 *   2. otherwise walk `segments` with the transforms `get` semantics.
 *
 * Compile ONCE: `toPath` runs a single time here (never per row). The returned
 * `get` is the per-row hot path and is O(depth).
 */
export interface CompiledPath {
  readonly source: string;
  readonly segments: string[];
  get(row: unknown): unknown;
}

/** A bare per-row accessor — the shape stored on compiled plan nodes. */
export type PathGetter = (row: unknown) => unknown;

/**
 * `compilePath(source).get`, detached: the compiled plan nodes store the bare
 * function (not the wrapper) so the per-row hot path is a plain call.
 */
export const compileAccessor = (source: string): PathGetter =>
  compilePath(source).get;

export function compilePath(source: string): CompiledPath {
  const segments = _.toPath(source);
  if (segments.length === 1) {
    const only = segments[0];
    return {
      source,
      segments,
      get: (row) =>
        row === null || row === undefined
          ? undefined
          : (row as Record<string, unknown>)[only],
    };
  }
  return {
    source,
    segments,
    get(row) {
      if (row === null || row === undefined) return undefined;
      const obj = row as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(obj, source)) return obj[source];
      let current: unknown = obj;
      for (const segment of segments) {
        if (current === null || current === undefined) return undefined;
        current = (current as Record<string, unknown>)[segment];
      }
      return current;
    },
  };
}

/**
 * Project a row onto a list of references (SQL `SELECT a, b AS b`): each emitted
 * key is the reference string, each value is that reference resolved against
 * the row. Used by the final `select` phase.
 */
export function projectRefs(
  row: Record<string, unknown>,
  accessors: ReadonlyArray<{ ref: string; compiled: CompiledPath }>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { ref, compiled } of accessors) out[ref] = compiled.get(row);
  return out;
}

/**
 * Path-aware distinct: keeps the FIRST row for each distinct tuple of the given
 * references. Supersedes the shallow `uniqueBy` for the query tail so that a
 * dotted grouped key (`'a.b'` stored flat) is honoured.
 */
export function uniqueByPaths<T>(
  rows: ReadonlyArray<T>,
  refs: ReadonlyArray<string>
): T[] {
  const accessors = refs.map(compilePath);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = accessors
      .map((accessor) => {
        const value = accessor.get(row);
        return value === undefined ? '\u0000u' : JSON.stringify(value);
      })
      .join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
