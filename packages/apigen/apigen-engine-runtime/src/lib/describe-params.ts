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
 * — the field-level detail a per-command `--help` needs. TERMINAL: each field's
 * own type is rendered via `typeName(propDef)` at depth 0 (see `typeName`'s
 * doc comment for the depth contract), so a doubly-nested object still
 * collapses to the plain `object` placeholder rather than fanning out into an
 * unbounded recursive dump. Returns `undefined` when the schema carries no
 * `properties` to show (an object with no declared shape, or a non-object
 * schema) — the caller falls back to the plain `object` placeholder.
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
 * — never the bare, contentless word `enum`. Unconditional (not gated by the
 * depth budget): unlike an `object`'s fields (genuinely unbounded, hence the
 * one-level cap below), an enum's own value list is exactly the information a
 * caller needs to use the flag correctly, and is cheap to print in full at
 * any nesting depth (BUG-BACKLOG-CLI-HELP-BARE-ENUM-001 — `query --help`
 * rendered `view?: enum` for a ~10-value closed vocabulary, giving a caller no
 * way to discover `'projects'`/`'components'`/`'locations'` without reading
 * source or SPEC.md).
 *
 * An EMPTY `enum: []` has no values to render; `[].map(...).join('|')` would
 * produce the empty string and leave a bare `mode?: ` with nothing after the
 * colon (C-21), so it collapses to the same `unknown` placeholder used for an
 * absent schema — an enum that constrains to nothing tells a caller nothing,
 * and `unknown` says so rather than restating the JSON-Schema keyword `enum`.
 */
function enumValues(def: SchemaProp): string {
  const values = def.enum ?? [];
  if (values.length === 0) return 'unknown';
  return values.map(enumLiteral).join('|');
}

/**
 * Renders a `oneOf`/`anyOf` union's member types, e.g.
 * `{ uid: string } | { registry: string, name: string }` — never the bare,
 * contentless word `union`. Each member is rendered via `typeName(member,
 * depth)`, where `depth` is the budget `typeName` has ALREADY decremented for
 * this level (see `typeName`'s doc comment for the full depth contract);
 * `unionValues` deliberately does NOT re-inject or reset it. Re-injecting it
 * (as the old boolean `expand` did) is exactly what let a union directly
 * nested in a union re-expand at every level — unbounded recursion on a
 * deeply nested schema (S-19). A member that is itself a union therefore
 * receives `depth < 2` and collapses to the `union` placeholder, keeping the
 * whole render bounded.
 */
function unionValues(members: unknown[], depth: number): string {
  return (members as SchemaProp[])
    .map((member) => typeName(member, depth))
    .join(' | ');
}

/**
 * Renders a schema node as a human-readable type, bounded by an integer
 * `depth` budget rather than the old boolean `expand` flag (S-19: `expand` was
 * threaded through `unionValues` unchanged, so a union directly nested inside
 * a union re-expanded at every level and a deeply nested schema blew the call
 * stack). `depth` is a strict superset of the boolean: the top-level caller
 * that used to pass `true` now passes `2`, and `depth = 0` (the default, used
 * for every nested field) is exactly the old `false`.
 *
 * The contract, exactly:
 * - `!def`                   → `'unknown'`.
 * - `array`                  → `${typeName(def.items, 0)}[]` — items always
 *   render at depth 0; an element type is never expanded.
 * - `enum`                   → `enumValues(def)`, unconditional at ANY depth
 *   (see `enumValues`).
 * - `$ref`                   → the ref's trailing name, unconditional.
 * - `anyOf`/`oneOf` (union)  → `depth >= 2` → `unionValues(members, depth - 1)`
 *   (member shapes); otherwise → the `'union'` truncation placeholder.
 * - `object`                 → `depth >= 1` → `objectShape(def)` (terminal —
 *   its fields render at depth 0); otherwise → `'object'`.
 * - anything else            → `def.type ?? 'object'`.
 *
 * So exactly one level of object fields and one level of union members expand
 * at the top (depth 2); a union member's own nested union/object collapses to
 * the `'union'`/`'object'` placeholder. Both truncation markers are the
 * pre-existing contentless placeholders — no new symbols — so every prior
 * snapshot stays byte-identical.
 */
function typeName(def: SchemaProp | undefined, depth = 0): string {
  if (!def) return 'unknown';
  if (def.type === 'array') return `${typeName(def.items, 0)}[]`;
  if (def.enum) return enumValues(def);
  if (def.$ref) return String(def.$ref).split('/').pop() || 'object';
  const unionMembers = def.anyOf ?? def.oneOf;
  if (unionMembers) return depth >= 2 ? unionValues(unionMembers, depth - 1) : 'union';
  if (depth >= 1 && def.type === 'object') return objectShape(def) ?? 'object';
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
 * Every TOP-LEVEL param's type is expanded one level deep — an integer `depth`
 * budget of 2 is passed to `typeName` (see its doc comment for the exact
 * contract) — so an `object` with declared `properties` renders its fields and
 * a `oneOf`/`anyOf` union renders its member shapes, e.g. `update`'s single
 * `input` param renders as `input: { repo: string, humanId: string, patch:
 * object, by: string }` instead of the placebo `input: object` that told a
 * reader nothing about what the command actually accepts (the surviving half of
 * FEAT-BACKLOG-003 / the `--help` finding in P5-cli-serve-transport). Nested
 * unions/objects collapse to their placeholders, keeping the render bounded.
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
    type: typeName(def, 2),
    required: required.has(name),
  }));
  const text = params
    .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
    .join(', ');
  return { params, text };
}
