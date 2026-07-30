import { envelopeCliFlag, envelopeEnvVar } from '@adhd/apigen-engine-naming';
import type { ComposedSchemas } from '@adhd/apigen-core-client';

// ---------------------------------------------------------------------------
// Schema-introspection helpers for `generate()` — the STATIC codegen path
// that emits a Commander program hardcoding flags at codegen time.
//
// serve-core migration (cli-adapter): this module used to be shared between
// TWO consumers — `generate()` and the LIVE `run()` dispatch path — per
// AGENTS.md §8 "Two-Use Refactor Rule". `run()` has since migrated onto the
// transport-neutral `OpPlan` primitive (`@adhd/apigen-engine-runtime`'s
// `buildOpPlan`/`OpPlan.cliFlags`/`OpPlan.envelope`), which resolves the
// IDENTICAL flag-naming/typing/§9.1-envelope decisions this module computes,
// just off `Operation`+composed-schema instead of composed-schema alone — see
// `op-plan.ts`'s own doc comment ("F2: cliFlags values carry envVar? …
// mirrors cli-output's FlagSpec"). `run.ts` no longer imports anything from
// this file ([cli-adapter.1] — no re-derivation at dispatch time).
//
// `generate()` still needs these helpers verbatim: it renders TypeScript
// SOURCE TEXT (`.option(...)` lines) from a bare composed schema with no
// `Operation`/`buildOpPlan` involved, so it cannot consume `OpPlan.cliFlags`
// (a runtime `Map`, not codegen-able source) directly. Keeping the flag/
// envelope typing RULES here (kebab-casing, boolean/json detection, §9.1
// binding) identical to `op-plan.ts`'s private `computeCliFlags`/
// `computeEnvelopeFields` is what keeps the generated CLI and the live
// `run()` dispatch path flag-for-flag compatible — a future state may migrate
// `generate()` onto `buildOpPlan` too (using `PluginInput.operations`, per
// BUG-APIGEN-024) to collapse this duplication entirely; out of scope here.
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
// BUG-APIGEN-CLI-ROOT-ONEOF-UNSUPPORTED-001 — root-level `oneOf`+`discriminator`
// domain schema detection (a WHOLE operation's domain data is a discriminated
// union, e.g. `apigen-core-client`'s `buildBatchKindSchema` output — used by
// the shipped `apigen-plugin-batch`'s `_batch/<kind>` mount operations).
//
// Deliberately NOT the same mechanism as `FlagProp.oneOf` above
// (BUG-APIGEN-CLI-ONEOF-001): that one is scoped to a single NESTED property
// whose optional (`T | undefined`) type renders as `oneOf: [{type:'null'},
// {type:X}]` — a leaf-level nullable-field shape. This one operates on the
// domain schema (`schema.input.properties.data`) AS A WHOLE: the whole
// operation's domain input is itself `{oneOf: [...], discriminator: {...}}`,
// with no top-level `properties` to iterate at all. Conflating the two would
// be wrong — a `oneOf`-typed *property* is not a reason to fan an operation
// out into N subcommands.
// ---------------------------------------------------------------------------

/** One discriminator branch of a root-level union domain schema. */
export interface RootUnionBranch {
  /** The literal discriminator value selecting this branch (e.g. a target operation id). */
  value: string;
  /** Sanitized kebab-case Commander subcommand name derived from {@link value}. */
  commandName: string;
  /** This branch's own flat property map — rendered via the EXISTING flag logic, unchanged. */
  props: Record<string, FlagProp>;
  /** This branch's own required-field list (still includes the discriminator field itself). */
  required: string[];
}

/** A root-level discriminated-union domain schema, decomposed into per-branch flag data. */
export interface RootUnionSchema {
  /** The shared property name carrying the discriminator literal (e.g. `'operation'`). */
  discriminatorProperty: string;
  branches: RootUnionBranch[];
}

/** Parses a same-document JSON Pointer of the form `#/oneOf/<n>` into `<n>`; `undefined` if malformed. */
function oneOfPointerIndex(pointer: string): number | undefined {
  const match = /^#\/oneOf\/(\d+)$/.exec(pointer);
  if (!match) return undefined;
  return Number(match[1]);
}

/** Sanitizes an arbitrary discriminator literal into a safe Commander subcommand token. */
function sanitizeCommandName(value: string): string {
  const kebabed = kebabCase(value);
  const cleaned = kebabed.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.toLowerCase() : 'branch';
}

/**
 * Detects whether `schema`'s domain (`data`) schema is a root-level
 * `oneOf`+`discriminator` union (BUG-APIGEN-CLI-ROOT-ONEOF-UNSUPPORTED-001)
 * and, if so, decomposes it into per-branch flag data. Returns `undefined`
 * for the (overwhelmingly common) flat `{type:'object', properties:{...}}`
 * domain schema — callers must fall back to {@link dataSchemaProps} /
 * `dataParamNames` in that case, unchanged.
 */
export function resolveRootUnion(
  schema: ComposedSchemas[string]
): RootUnionSchema | undefined {
  const dataSchema = (
    (schema.input as Record<string, unknown>)?.['properties'] as
      | Record<string, unknown>
      | undefined
  )?.['data'] as Record<string, unknown> | undefined;
  if (!dataSchema) return undefined;

  const oneOf = dataSchema['oneOf'] as
    | Array<Record<string, unknown>>
    | undefined;
  const discriminator = dataSchema['discriminator'] as
    | { propertyName: string; mapping: Record<string, string> }
    | undefined;
  if (!oneOf || !discriminator) return undefined;

  const branches: RootUnionBranch[] = [];
  for (const [value, pointer] of Object.entries(discriminator.mapping)) {
    const idx = oneOfPointerIndex(pointer);
    if (idx === undefined) continue;
    const branchSchema = oneOf[idx];
    if (!branchSchema) continue;
    const props =
      (branchSchema['properties'] as Record<string, FlagProp>) ?? {};
    const required = (branchSchema['required'] as string[]) ?? [];
    branches.push({
      value,
      commandName: sanitizeCommandName(value),
      props,
      required,
    });
  }
  if (branches.length === 0) return undefined;

  return { discriminatorProperty: discriminator.propertyName, branches };
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
