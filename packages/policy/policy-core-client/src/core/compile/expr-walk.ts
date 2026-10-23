const LOGICAL = new Set(['_and', '_or', '_not']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** One field an expression reads, as path segments plus the JSON path of its key. */
export interface IFieldRef {
  readonly segments: readonly string[];
  readonly jsonPath: string;
}

/**
 * Collects every field an expression reads (descending through `_and`, `_or`,
 * `_not`, dotted keys and nested objects). Operator keys are not fields.
 * `basePath` prefixes the JSON paths.
 */
export function collectFieldPaths(expression: unknown, basePath: string): readonly IFieldRef[] {
  const refs: IFieldRef[] = [];
  const node = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((child, i) => node(child, `${path}/${i}`));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, member] of Object.entries(value)) {
      const keyPath = `${path}/${key}`;
      if (LOGICAL.has(key)) {
        node(member, keyPath);
      } else if (!key.startsWith('_')) {
        field(key.split('.'), member, keyPath);
      }
    }
  };
  const field = (segments: string[], value: unknown, path: string): void => {
    if (!isPlainObject(value)) {
      refs.push({ segments, jsonPath: path });
      return;
    }
    const entries = Object.entries(value);
    const nestedFields = entries.filter(([k]) => !k.startsWith('_'));
    // A field object that only nests further fields is a path prefix, not a read.
    if (nestedFields.length < entries.length || entries.length === 0) {
      refs.push({ segments, jsonPath: path });
    }
    for (const [key, member] of entries) {
      if (LOGICAL.has(key)) node({ [key]: member }, path);
      else if (!key.startsWith('_')) field([...segments, ...key.split('.')], member, `${path}/${key}`);
    }
  };
  node(expression, basePath);
  return refs;
}

/** One string leaf of an expression with its JSON path. */
export interface IStringLeaf {
  readonly value: string;
  readonly jsonPath: string;
}

/** Collects every string leaf (operands, list elements) of a JSON value. */
export function collectStringLeaves(value: unknown, basePath: string): readonly IStringLeaf[] {
  const leaves: IStringLeaf[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') leaves.push({ value: v, jsonPath: path });
    else if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${path}/${i}`));
    else if (isPlainObject(v)) {
      for (const [key, member] of Object.entries(v)) walk(member, `${path}/${key}`);
    }
  };
  walk(value, basePath);
  return leaves;
}

/** Matches a `$attributes.<name>` placeholder exactly. */
export const ATTRIBUTE_PLACEHOLDER = /^\$attributes\.([A-Za-z_][A-Za-z0-9_]*)$/;
