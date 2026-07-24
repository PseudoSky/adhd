/**
 * OpPlan — serve-core primitive (proposal §3a / [iface:op-plan]).
 *
 * Every transport re-derives the `Operation → wire` projection today (HTTP
 * route+verb, MCP tool name, gRPC package/service/method, CLI command path,
 * the §9.1 envelope binding table, and the CLI `--flag` table) independently,
 * per plugin, per request in some cases. `OpPlan` is the single authority:
 * given an `Operation` (or `MountedOperation`) and its composed schema, it
 * resolves EVERY transport-facing fact about that operation exactly ONCE.
 *
 * Built entirely on existing repo types — no new schema model:
 *   - `TransportProjection`/`project()` (`@adhd/apigen-engine-naming`) for
 *     http/mcp/grpc/cli projection.
 *   - `ParamInfo`/`describeParams` (`./describe-params`) for the human/JSON
 *     domain-param summary.
 *   - The §9.1 envelope binding helpers (`envelopeKey`/`envelopeCliFlag`/
 *     `envelopeEnvVar`, `@adhd/apigen-engine-naming`) for `envelope[]`.
 *   - `MountedOperation` (`@adhd/apigen-core-client`) for `isMount`/`mountHandler`.
 *
 * F2: `cliFlags` values carry `envVar?: string` (mirrors cli-output's
 * `FlagSpec`, `apigen-plugin-cli-output/src/lib/run.ts:53-59`) so the
 * flag→env-var fallback in `parseArgs` (`run.ts:300-306`) is not silently
 * regressed once cli-output migrates onto this primitive.
 *
 * F3 [fix:transport-stamping]: `transport` is stamped onto the plan by the
 * CALLER (the transport adapter building plans for one package/transport
 * pair) — never inferred or hardcoded here. `dispatchForPlan`'s mount branch
 * reads `plan.transport` back off to stamp the adapted core-client `Call`,
 * so a non-HTTP transport's mount calls are never mis-tagged `'http'`.
 */

import type {
  Call as CoreClientCall,
  ComposedSchemas,
  MountedOperation,
  Operation,
  Transport,
} from '@adhd/apigen-core-client';
import {
  envelopeCliFlag,
  envelopeEnvVar,
  envelopeKey,
  project,
} from '@adhd/apigen-engine-naming';
import type {
  HttpVerb,
  ProjectionConfig,
} from '@adhd/apigen-engine-naming';
import { describeParams } from './describe-params';
import type { ParamInfo } from './describe-params';
import type { LayerResult } from './invoke';

// ---------------------------------------------------------------------------
// Loose CLI-flag-typing schema prop shape — mirrors
// `apigen-plugin-cli-output/src/lib/schema-introspect.ts`'s `FlagProp`.
//
// BUG-APIGEN-CLI-ONEOF-001: `ts-json-schema-generator` renders an optional
// (`T | undefined`) array/object/boolean param as `oneOf: [{type:'null'},
// {type:...}]`, NOT `anyOf` — both must be checked identically or an
// optional array/object/boolean CLI flag round-trips as a raw unparsed
// string and fails the validate-Layer's schema check.
// ---------------------------------------------------------------------------

interface FlagProp {
  type?: string;
  anyOf?: Array<{ type?: string }>;
  oneOf?: Array<{ type?: string }>;
}

function unionMembers(prop: FlagProp): Array<{ type?: string }> | undefined {
  return prop.anyOf ?? prop.oneOf;
}

function isJsonTypedProp(prop: FlagProp | undefined): boolean {
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

function isBooleanTypedProp(prop: FlagProp | undefined): boolean {
  if (!prop) return false;
  if (prop.type === 'boolean') return true;
  const members = unionMembers(prop);
  if (members) {
    const nonNull = members.filter((m) => m.type !== 'null');
    return nonNull.length > 0 && nonNull.every((m) => m.type === 'boolean');
  }
  return false;
}

/** camelCase → kebab-case (e.g. `userId` → `user-id`). Matches Commander's own normalisation. */
function kebabCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/**
 * Resolves a composed schema entry's domain-param properties + required list
 * (the `data: {}` sub-object every composed input carries).
 */
function dataSchemaProps(schema: ComposedSchemas[string]): {
  props: Record<string, FlagProp>;
  required: string[];
} {
  const dataSchema = (
    (schema.input as Record<string, unknown>)?.['properties'] as
      | Record<string, unknown>
      | undefined
  )?.['data'] as Record<string, unknown> | undefined;
  const props = (dataSchema?.['properties'] as Record<string, FlagProp>) ?? {};
  const required = (dataSchema?.['required'] as string[]) ?? [];
  return { props, required };
}

// ---------------------------------------------------------------------------
// OpPlan — [iface:op-plan]
// ---------------------------------------------------------------------------

/** One §9.1 envelope side-channel field, projected to every transport binding. */
export interface OpPlanEnvelopeField {
  /** The bare field name as it appears in the composed schema. */
  field: string;
  /** pluginId resolved from `x-apigen-envelope` metadata (defaults to `'adhd'`). */
  pluginId: string;
  /** `x-<pluginId>-<field>` — used verbatim for HTTP headers and MCP `_meta` keys. */
  httpHeader: string;
  /** Same string as `httpHeader` — an explicit alias so call sites self-document. */
  mcpMetaKey: string;
  /** `--<pluginId>-<field>` CLI flag. */
  cliFlag: string;
  /** `APIGEN_<PLUGINID>_<FIELD>` env-var fallback. */
  envVar: string;
}

/**
 * One resolved `--flag` for a command, keyed by its argv name (without the
 * leading `--`) — the same shape `apigen-plugin-cli-output`'s `FlagSpec`
 * carries, computed once here instead of per-plugin (F2).
 */
export interface OpPlanCliFlag {
  /** The domain param name or envelope field name in camelCase. */
  camelKey: string;
  kind: 'domain' | 'envelope';
  valueKind: 'boolean' | 'json' | 'string';
  /** (envelope only) `APIGEN_<PLUGINID>_<FIELD>` fallback when the flag is absent. */
  envVar?: string;
}

/**
 * A fully-resolved, transport-complete plan for one `Operation` (proposal §3a).
 *
 * Computed ONCE per op — never re-derived per request — from the `Operation`
 * and its composed schema. `transport` is stamped by the caller (F3); it is
 * never inferred or hardcoded inside this module.
 */
export interface OpPlan {
  /** The canonical (or mounted) operation descriptor this plan was built from. */
  op: Operation;
  /** The transport this plan was resolved FOR — stamped by the caller (F3). */
  transport: Transport;
  http: { verb: HttpVerb; route: string };
  mcp: { name: string };
  cli: { path: string[] };
  grpc: { package: string; service: string; method: string };
  /** Domain-param summary; `undefined` for a mount op (no composed schema exists). */
  params?: ParamInfo[];
  /** §9.1 envelope fields, one entry per non-`data` top-level input property. */
  envelope: OpPlanEnvelopeField[];
  /** The precomputed `--flag` table, keyed by argv flag name (no leading `--`). */
  cliFlags: Map<string, OpPlanCliFlag>;
  /** True when the underlying export is async-iterable/streaming (`Operation.streaming`). */
  streaming: boolean;
  /** True when `op` is a `MountedOperation` (a `--use` mount capability, not an extracted source op). */
  isMount: boolean;
  /**
   * Present only when `isMount` is true — the mount's `handler`, normalised
   * to always return a `Promise<LayerResult>` (its raw return type is
   * `unknown | Promise<unknown> | AsyncIterable<Chunk>` — see
   * `MountedOperation.handler`). Takes the core-client `Call` shape;
   * `dispatchForPlan` is responsible for adapting the runtime `Call` into
   * this shape and stamping `transport` from `plan.transport` (F3).
   */
  mountHandler?: (call: CoreClientCall) => Promise<LayerResult>;
}

// ---------------------------------------------------------------------------
// Type guard — a `MountedOperation` carries a callable `handler`; a plain
// extracted `Operation` never does.
// ---------------------------------------------------------------------------

function isMountedOperation(op: Operation): op is MountedOperation {
  return typeof (op as Partial<MountedOperation>).handler === 'function';
}

// ---------------------------------------------------------------------------
// §9.1 envelope + CLI flag computation — ONCE, from the composed schema.
// ---------------------------------------------------------------------------

function computeEnvelopeFields(
  schema: ComposedSchemas[string]
): OpPlanEnvelopeField[] {
  const inputProps =
    ((schema.input as Record<string, unknown>)?.['properties'] as
      | Record<string, unknown>
      | undefined) ?? {};
  const meta = (schema as Record<string, unknown>)['x-apigen-envelope'] as
    | Record<string, string>
    | undefined;
  const fields: OpPlanEnvelopeField[] = [];
  for (const field of Object.keys(inputProps)) {
    if (field === 'data') continue;
    const pluginId = meta?.[field] ?? 'adhd';
    const headerKey = envelopeKey(pluginId, field);
    fields.push({
      field,
      pluginId,
      httpHeader: headerKey,
      mcpMetaKey: headerKey,
      cliFlag: envelopeCliFlag(pluginId, field),
      envVar: envelopeEnvVar(pluginId, field),
    });
  }
  return fields;
}

function computeCliFlags(
  schema: ComposedSchemas[string],
  envelope: OpPlanEnvelopeField[]
): Map<string, OpPlanCliFlag> {
  const flags = new Map<string, OpPlanCliFlag>();
  const { props } = dataSchemaProps(schema);
  for (const [param, prop] of Object.entries(props)) {
    let valueKind: OpPlanCliFlag['valueKind'] = 'string';
    if (isBooleanTypedProp(prop)) valueKind = 'boolean';
    else if (isJsonTypedProp(prop)) valueKind = 'json';
    flags.set(kebabCase(param), {
      camelKey: param,
      kind: 'domain',
      valueKind,
    });
  }
  for (const field of envelope) {
    const flagName = field.cliFlag.replace(/^--/, '');
    flags.set(flagName, {
      camelKey: field.field,
      kind: 'envelope',
      valueKind: 'string',
      envVar: field.envVar,
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// buildOpPlan — resolve ONE Operation (+ composed schema) into an OpPlan.
// ---------------------------------------------------------------------------

export interface BuildOpPlanInput {
  /** The canonical operation descriptor, or a `MountedOperation` contributed by a `--use` mount plugin. */
  op: Operation | MountedOperation;
  /**
   * The composed schema entry for `op`. Omitted for a mount op — mount ops
   * are synthetic and never flow through `composeSchemas()`, so no entry
   * exists for them in a package's `ComposedSchemas` map.
   */
  schema?: ComposedSchemas[string];
  /** The transport this plan is being resolved for (F3 — stamped by the caller, never inferred). */
  transport: Transport;
  /** Optional per-op projection overrides (`--opt http.verb.<id>=GET`, SPEC §5). */
  projection?: ProjectionConfig;
}

/**
 * Resolve `input.op` (+ its composed schema, when present) into a
 * transport-complete `OpPlan`. Call this ONCE per op, at package/transport
 * wiring time — never per request.
 */
export function buildOpPlan(input: BuildOpPlanInput): OpPlan {
  const { op, schema, transport, projection } = input;
  const projected = project(op, projection);

  const envelope = schema ? computeEnvelopeFields(schema) : [];
  const cliFlags = schema
    ? computeCliFlags(schema, envelope)
    : new Map<string, OpPlanCliFlag>();
  const params = schema ? describeParams(schema).params : undefined;

  const plan: OpPlan = {
    op,
    transport,
    http: projected.http,
    mcp: projected.mcp,
    cli: projected.cli,
    grpc: projected.grpc,
    params,
    envelope,
    cliFlags,
    streaming: op.streaming,
    isMount: isMountedOperation(op),
  };

  if (isMountedOperation(op)) {
    const handler = op.handler;
    plan.mountHandler = async (call: CoreClientCall): Promise<LayerResult> =>
      handler(call);
  }

  return plan;
}
