/**
 * A small structural validator for the JSON Schemas this package ships
 * (draft 2020-12 subset: `$ref` into `#/...`, `anyOf`, `const`, `enum`, `type`,
 * `properties`, `required`, `additionalProperties`, `items`, `minItems`,
 * `minLength`, `minimum`, `pattern`). No ajv dependency. Pure.
 */
export interface ISchemaIssue {
  /** JSON path into the validated value (prefixed by `basePath`). */
  readonly path: string;
  readonly message: string;
}

type Schema = Readonly<Record<string, unknown>>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Own-property test: `constructor`, `toString` and friends are never schema members. */
const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    node = isObject(node) && own(node, part) ? node[part] : undefined;
  }
  if (!isObject(node)) throw new Error(`unresolvable $ref ${ref}`);
  return node;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function check(root: Schema, node: Schema, v: unknown, path: string, out: ISchemaIssue[]): void {
  if (typeof node['$ref'] === 'string') {
    check(root, resolveRef(root, node['$ref']), v, path, out);
    return;
  }
  if ('const' in node && !same(node['const'], v)) {
    out.push({ path, message: `must equal ${JSON.stringify(node['const'])}` });
    return;
  }
  if (Array.isArray(node['enum'])) {
    const allowed = node['enum'] as unknown[];
    if (!allowed.some((candidate) => same(candidate, v))) {
      out.push({
        path,
        message: `must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`,
      });
      return;
    }
  }
  if (Array.isArray(node['anyOf'])) {
    const matched = (node['anyOf'] as Schema[]).some((branch) => {
      const probe: ISchemaIssue[] = [];
      check(root, branch, v, path, probe);
      return probe.length === 0;
    });
    if (!matched) {
      out.push({ path, message: 'does not match any allowed form' });
      return;
    }
  }
  if (typeof node['type'] === 'string' && !typeMatches(node['type'], v)) {
    out.push({ path, message: `must be ${node['type']} (got ${typeOf(v)})` });
    return;
  }
  if (typeof v === 'string') {
    if (typeof node['minLength'] === 'number' && v.length < node['minLength']) {
      out.push({ path, message: `must have at least ${node['minLength']} character(s)` });
    }
    if (typeof node['pattern'] === 'string' && !new RegExp(node['pattern']).test(v)) {
      out.push({ path, message: `must match ${node['pattern']}` });
    }
  }
  if (typeof v === 'number' && typeof node['minimum'] === 'number' && v < node['minimum']) {
    out.push({ path, message: `must be at least ${node['minimum']}` });
  }
  if (Array.isArray(v)) {
    if (typeof node['minItems'] === 'number' && v.length < node['minItems']) {
      out.push({ path, message: `must have at least ${node['minItems']} item(s)` });
    }
    if (isObject(node['items'])) {
      const items = node['items'];
      v.forEach((item, i) => check(root, items, item, `${path}/${i}`, out));
    }
  }
  if (isObject(v)) {
    const properties = isObject(node['properties'])
      ? (node['properties'] as Record<string, Schema>)
      : {};
    if (Array.isArray(node['required'])) {
      for (const key of node['required'] as string[]) {
        if (!own(v, key)) out.push({ path: `${path}/${key}`, message: 'is required' });
      }
    }
    for (const [key, member] of Object.entries(v)) {
      const memberPath = `${path}/${key}`;
      if (own(properties, key)) {
        check(root, properties[key], member, memberPath, out);
      } else if (node['additionalProperties'] === false) {
        out.push({ path: memberPath, message: `unknown key "${key}"` });
      } else if (isObject(node['additionalProperties'])) {
        check(root, node['additionalProperties'], member, memberPath, out);
      }
    }
  }
}

/**
 * Validates `value` against `schema`, returning every issue (not just the
 * first). `basePath` is prepended to each issue path. Total: a malformed
 * schema throws (a programming error), malformed `value` never does.
 */
export function validateSchema(
  schema: Schema,
  value: unknown,
  basePath = ''
): readonly ISchemaIssue[] {
  const out: ISchemaIssue[] = [];
  check(schema, schema, value, basePath, out);
  return out;
}
