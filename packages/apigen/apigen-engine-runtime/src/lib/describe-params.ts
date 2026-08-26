/** Loose JSON-Schema property shape (only what we need for a human summary). */
interface SchemaProp {
  type?: string;
  enum?: unknown[];
  $ref?: string;
  items?: SchemaProp;
  anyOf?: unknown[];
  oneOf?: unknown[];
  properties?: Record<string, SchemaProp>;
  required?: string[];
}

export interface ParamInfo {
  name: string;
  type: string;
  required: boolean;
}

/**
 * Renders one nested `object` schema's own fields as `{ a: string, b?: number }`
 * — the field-level detail a per-command `--help` needs. Deliberately bounded
 * to exactly ONE level: a field's own type is rendered via `typeName(propDef)`
 * with expansion OFF, so a doubly-nested object still collapses to the plain
 * `object` placeholder rather than fanning out into an unbounded recursive
 * dump. Returns `undefined` when the schema carries no `properties` to show
 * (an object with no declared shape, or a non-object schema) — the caller
 * falls back to the plain `object` placeholder in that case.
 */
function objectShape(def: SchemaProp | undefined): string | undefined {
  if (!def || def.type !== 'object' || !def.properties) return undefined;
  const entries = Object.entries(def.properties);
  if (entries.length === 0) return undefined;
  const required = new Set<string>(def.required ?? []);
  const fields = entries
    .map(([name, propDef]) => `${name}${required.has(name) ? '' : '?'}: ${typeName(propDef)}`)
    .join(', ');
  return `{ ${fields} }`;
}

/**
 * @param expand When true and `def` is an `object` schema with `properties`,
 *   renders its field-level shape (`objectShape`) instead of the plain
 *   `object` placeholder. Only ever passed `true` for a TOP-LEVEL param —
 *   every recursive call (array items, a nested object's own fields) omits
 *   it, keeping expansion to exactly one level (see `objectShape`'s doc
 *   comment for why: apigen `--help` output — and any snapshot test
 *   asserting it — must stay bounded and readable, not an unbounded JSON dump).
 */
function typeName(def: SchemaProp | undefined, expand = false): string {
  if (!def) return 'unknown';
  if (def.type === 'array') return `${typeName(def.items)}[]`;
  if (def.enum) return 'enum';
  if (def.$ref) return String(def.$ref).split('/').pop() || 'object';
  if (def.anyOf || def.oneOf) return 'union';
  if (expand && def.type === 'object') return objectShape(def) ?? 'object';
  return def.type ?? 'object';
}

/**
 * Extract a composed schema entry's domain parameters for logging AND for a
 * per-command `--help` rendering.
 *
 * Params live under `input.properties.data.properties` — the `data` envelope
 * wrapper is always present (see [def:ComposedSchemas]). Returns both a
 * structured list (for JSON logs) and a `name?: type` summary string.
 *
 * Every TOP-LEVEL param's type is expanded one level deep when it is an
 * `object` with declared `properties` — e.g. `update`'s single `input` param
 * renders as `input: { repo: string, humanId: string, patch: object, by:
 * string }` instead of the placebo `input: object` that told a reader
 * nothing about what the command actually accepts (the surviving half of
 * FEAT-BACKLOG-003 / the `--help` finding in P5-cli-serve-transport).
 */
export function describeParams(schema: { input?: unknown } | undefined): {
  params: ParamInfo[];
  text: string;
} {
  const input = (schema?.input ?? {}) as {
    properties?: Record<
      string,
      { properties?: Record<string, SchemaProp>; required?: string[] }
    >;
  };
  const data = input.properties?.['data'];
  const props = (data?.properties ?? {}) as Record<string, SchemaProp>;
  const required = new Set<string>(data?.required ?? []);
  const params: ParamInfo[] = Object.entries(props).map(([name, def]) => ({
    name,
    type: typeName(def, true),
    required: required.has(name),
  }));
  const text = params
    .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
    .join(', ');
  return { params, text };
}
