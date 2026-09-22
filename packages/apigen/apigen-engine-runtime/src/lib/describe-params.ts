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

/** Renders one enum literal the way a caller would type it on the CLI/in JSON — a quoted string, or the bare JSON literal for a non-string value. */
function enumLiteral(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
}

/**
 * Renders an `enum` schema's actual allowed values, e.g. `'open'|'closed'|'all'`
 * — never the bare, contentless word `enum`. Unconditional (not gated by
 * `expand`): unlike an `object`'s fields (genuinely unbounded, hence the
 * one-level cap below), an enum's own value list is exactly the information a
 * caller needs to use the flag correctly, and is cheap to print in full at
 * any nesting depth (BUG-BACKLOG-CLI-HELP-BARE-ENUM-001 — `query --help`
 * rendered `view?: enum` for a ~10-value closed vocabulary, giving a caller no
 * way to discover `'projects'`/`'components'`/`'locations'` without reading
 * source or SPEC.md).
 */
function enumValues(def: SchemaProp): string {
  return (def.enum ?? []).map(enumLiteral).join('|');
}

/**
 * Renders a `oneOf`/`anyOf` union's member types, e.g.
 * `{ uid: string } | { registry: string, name: string }` — never the bare,
 * contentless word `union`. Only expanded when `expand` is true: each member
 * is itself rendered via `typeName(member, expand)`, so an object member gets
 * its OWN one-level field expansion too (this is what turns a mounted
 * discriminated-union verb's mounted top-level `{ input: union }` into the
 * member shapes a caller actually needs — BUG-BACKLOG-CLI-HELP-BARE-UNION-001,
 * `get --help` printed `{ input: union }` for its two structurally-disjoint
 * uid/registry variants, with zero way to discover either shape short of
 * reading source). When `expand` is false (a union nested inside an already-
 * expanded object's own field, or inside an array's `items`), stays the bare
 * `union` placeholder — same one-level bound `objectShape` already enforces,
 * so this can never runaway into an unbounded recursive dump.
 */
function unionValues(members: unknown[], expand: boolean): string {
  return (members as SchemaProp[])
    .map((member) => typeName(member, expand))
    .join(' | ');
}

/**
 * @param expand When true, an `object` schema with `properties` renders its
 *   field-level shape (`objectShape`) instead of the plain `object`
 *   placeholder, AND a `oneOf`/`anyOf` union renders its member shapes
 *   (`unionValues`) instead of the plain `union` placeholder — both instead of
 *   collapsing to a contentless placeholder word. Only ever passed `true` for
 *   a TOP-LEVEL param — every recursive call for a field NESTED inside an
 *   already-expanded object/union (array items, a nested object's own fields,
 *   a union member's own fields) omits it, keeping expansion to exactly one
 *   level (see `objectShape`'s doc comment for why: apigen `--help` output —
 *   and any snapshot test asserting it — must stay bounded and readable, not
 *   an unbounded JSON dump). `enum` is the one exception to this bound: its
 *   value list is rendered in full unconditionally (`enumValues`), never
 *   gated by `expand` — see that function's own doc comment for why.
 */
function typeName(def: SchemaProp | undefined, expand = false): string {
  if (!def) return 'unknown';
  if (def.type === 'array') return `${typeName(def.items)}[]`;
  if (def.enum) return enumValues(def);
  if (def.$ref) return String(def.$ref).split('/').pop() || 'object';
  const unionMembers = def.anyOf ?? def.oneOf;
  if (unionMembers) return expand ? unionValues(unionMembers, expand) : 'union';
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
