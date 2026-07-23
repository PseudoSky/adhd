import { envelopeCliFlag, envelopeEnvVar } from '@adhd/apigen-engine-naming';
import type { ComposedSchemas } from '@adhd/apigen-core-client';

// ---------------------------------------------------------------------------
// Shared schema-introspection helpers for the CLI plugin's two "consumers" of
// a composed schema: `generate()` (emits a Commander program that hardcodes
// flags at codegen time) and `run()` (parses live argv against the same
// schema at dispatch time). Per AGENTS.md §8 "Two-Use Refactor Rule" — this
// logic was duplicated verbatim between the two call sites; it now lives in
// exactly one place so the generated CLI and the live `run()` path can never
// silently drift on flag naming / typing.
// ---------------------------------------------------------------------------

/** Loose JSON-Schema property shape — only what flag-typing decisions need. */
export interface FlagProp {
  type?: string;
  anyOf?: Array<{ type?: string }>;
  /**
   * BUG-APIGEN-CLI-ONEOF-001: `ts-json-schema-generator` renders an optional
   * (`T | undefined`) array/object/boolean param as `oneOf: [{type:'null'},
   * {type:'array'|'object'|'boolean', ...}]`, NOT `anyOf` — confirmed via the
   * real extraction pipeline (`run-cli-integration.spec.ts`'s real-subprocess
   * test against a genuinely optional `tags?: string[]` param). Both
   * `isJsonTypedProp` and `isBooleanTypedProp` must treat `oneOf` identically
   * to `anyOf` or an optional array/object/boolean CLI flag round-trips as a
   * raw unparsed string and fails the validate-Layer's schema check — this
   * silently affected BOTH the generated CLI (`generate.ts`, since retired)
   * and the live `run()` path before this fix, since neither previously
   * inspected `oneOf` at all.
   */
  oneOf?: Array<{ type?: string }>;
  default?: unknown;
}

/** Reads whichever of `anyOf`/`oneOf` is present (never both) — see {@link FlagProp.oneOf}. */
function unionMembers(prop: FlagProp): Array<{ type?: string }> | undefined {
  return prop.anyOf ?? prop.oneOf;
}

// ---------------------------------------------------------------------------
// §9.1 — envelope field binding for CLI (flag + env var per field)
// ---------------------------------------------------------------------------

export interface EnvelopeFieldBinding {
  /** The bare field name as it appears in the composed schema. */
  field: string;
  /** pluginId resolved from x-apigen-envelope metadata (defaults to 'adhd'). */
  pluginId: string;
  /** Generated CLI flag, e.g. '--auth-session' or '--adhd-session'. */
  flag: string;
  /** Generated env var, e.g. 'APIGEN_AUTH_SESSION' or 'APIGEN_SESSION'. */
  envVar: string;
}

/**
 * Collects all envelope field bindings for a schema, following SPEC §9.1:
 *   flag: --<pluginId>-<field>  +  env: APIGEN_<PLUGINID>_<FIELD>
 *   (flag takes precedence over env when both are present)
 *
 * Reads x-apigen-envelope (Record<field, pluginId>) from the schema;
 * defaults to pluginId='adhd' for any field without an explicit entry.
 */
export function envelopeBindings(
  schema: Record<string, unknown>
): EnvelopeFieldBinding[] {
  const inputProps =
    ((schema['input'] as Record<string, unknown> | undefined)?.[
      'properties'
    ] as Record<string, unknown> | undefined) ?? {};
  const meta = schema['x-apigen-envelope'] as
    | Record<string, string>
    | undefined;
  const bindings: EnvelopeFieldBinding[] = [];
  for (const field of Object.keys(inputProps)) {
    if (field === 'data') continue;
    const pluginId = meta?.[field] ?? 'adhd';
    bindings.push({
      field,
      pluginId,
      flag: envelopeCliFlag(pluginId, field),
      envVar: envelopeEnvVar(pluginId, field),
    });
  }
  return bindings;
}

// ---------------------------------------------------------------------------
// BUG-APIGEN-031: array/object-typed params arrive as raw strings over the
// CLI wire — see the doc comment on isJsonTypedProp's original home
// (generate.ts) for the full rationale. Both codegen (generate.ts, emitting
// __apigenParseJsonArg calls) and live run() (parsing argv directly) need the
// identical "is this param JSON-typed" decision.
// ---------------------------------------------------------------------------

export function isJsonTypedProp(prop: FlagProp | undefined): boolean {
  if (!prop) return false;
  if (prop.type === 'array' || prop.type === 'object') return true;
  const members = unionMembers(prop);
  if (members) {
    const nonNull = members.filter((m) => m.type !== 'null');
    return (
      nonNull.length > 0 &&
      nonNull.every((m) => m.type === 'array' || m.type === 'object')
    );
  }
  return false;
}

/** True when `prop` is boolean-typed (directly, or via an `anyOf`/`oneOf` of only booleans/null). */
export function isBooleanTypedProp(prop: FlagProp | undefined): boolean {
  if (!prop) return false;
  if (prop.type === 'boolean') return true;
  const members = unionMembers(prop);
  if (members) {
    const nonNull = members.filter((m) => m.type !== 'null');
    return nonNull.length > 0 && nonNull.every((m) => m.type === 'boolean');
  }
  return false;
}

// ---------------------------------------------------------------------------
// Domain-param schema access — `input.properties.data.{properties,required}`
// ---------------------------------------------------------------------------

/**
 * Resolves a composed schema entry's domain-param properties + required list
 * (the `data: {}` sub-object every composed input carries — see
 * [def:ComposedSchemas]).
 */
export function dataSchemaProps(schema: ComposedSchemas[string]): {
  props: Record<string, FlagProp>;
  required: string[];
} {
  const dataSchema = (
    (schema.input as Record<string, unknown>)?.['properties'] as Record<
      string,
      unknown
    >
  )?.['data'] as Record<string, unknown> | undefined;
  const props =
    (dataSchema?.['properties'] as Record<string, FlagProp>) ?? {};
  const required = (dataSchema?.['required'] as string[]) ?? [];
  return { props, required };
}

// ---------------------------------------------------------------------------
// Casing helpers — camelCase param name <-> kebab-case CLI flag
// ---------------------------------------------------------------------------

/** camelCase → kebab-case (e.g. `userId` → `user-id`). Matches Commander's own normalisation. */
export function kebabCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/** kebab-case → camelCase (e.g. `user-id` → `userId`). Inverse of {@link kebabCase}. */
export function camelFromKebab(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
