/**
 * Canonical JSON: keys sorted lexicographically at every depth, no whitespace,
 * UTF-8; `undefined` members are omitted. Equal input gives byte-equal output
 * (CL-05). Throws `TypeError` on values JSON cannot represent (function,
 * symbol, bigint, NaN, Infinity).
 */
export function canonicalize(value: unknown): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalize: non-finite number ${String(value)}`);
      }
      return JSON.stringify(value);
    case 'undefined':
      return 'null';
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalize: unsupported ${typeof value} value`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => write(item)).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const member = record[key];
    if (member === undefined) continue;
    parts.push(JSON.stringify(key) + ':' + write(member));
  }
  return '{' + parts.join(',') + '}';
}
