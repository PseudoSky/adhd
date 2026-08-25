import type { LogicalTypeRegistry } from './registry';

/** @stable Stable identifier for a logical type.
 *  Scalars: the JSON-Schema `format` (e.g. "date-time"). Nominal/union: a
 *  namespace-qualified id (e.g. "cli.User"). */
export type LogicalTypeId = string;

/** @stable */
export type LogicalKind = 'scalar' | 'nominal' | 'union' | 'map' | 'set';

/** @stable The wire alphabet — exactly JSON's value space. */
export type Wire =
  | string
  | number
  | boolean
  | null
  | Wire[]
  | { [k: string]: Wire };

/** @stable A resolved (no-$ref-at-root) JSON Schema node. */
export type SchemaNode = Readonly<Record<string, unknown>>;

/** @stable Threaded through a transcode walk. */
export interface TranscodeCtx {
  readonly registry: LogicalTypeRegistry;
  readonly resolve: (ref: string) => SchemaNode; // $ref -> $def resolver (root-bound)
  readonly seen: WeakSet<object>; // cycle guard (encode side)
  readonly path: string; // JSON Pointer, for diagnostics
  readonly mode: 'strict' | 'lossy'; // strict: throw on unencodable; lossy: warn + best-effort
}

/** @stable Host-agnostic codec. One per logical type. Pure, deterministic, total over its domain. */
export interface LogicalTypeCodec<Host = unknown> {
  readonly id: LogicalTypeId;
  readonly kind: LogicalKind;
  /** Canonical schema fragment this codec owns (scalar: {type,format}; nominal: object $def). */
  readonly schema: SchemaNode;
  /** Structural, cheap test: does this codec own `node`? (format match, or x-apigen-codec===id). */
  matches(node: SchemaNode): boolean;
  /**
   * Value-side claim test, used ONLY on the schemaless path (a `{}` / `any`
   * schema node, where `matches(node)` cannot decide anything).
   *
   * Implement this on — and only on — codecs whose HOST type is not
   * JSON-native (`Date`, `bigint`, `Uint8Array`, non-finite `number`). Those
   * are the values that genuinely need the `{$apigen,v}` envelope to survive
   * a JSON round-trip. A codec whose host type IS JSON-native (`uuid` and
   * `decimal` are both branded strings) must NOT implement it: a plain string
   * already round-trips, and claiming it would rewrite a consumer's payload
   * for no gain.
   *
   * A codec that omits `ownsValue` is never eligible for schemaless claiming.
   * That is the safe default — passthrough loses nothing, whereas a wrong
   * claim silently destroys data.
   *
   * MUST be pure and side-effect free.
   */
  ownsValue?(value: unknown): boolean;
  /** Host -> wire. MUST NOT mutate `value`; MUST be deterministic. */
  encode(value: Host, node: SchemaNode, ctx: TranscodeCtx): Wire;
  /** Wire -> host. MUST validate-then-construct; MUST be the inverse of `encode` across the vectors. */
  decode(wire: Wire, node: SchemaNode, ctx: TranscodeCtx): Host;
}

/** @stable A language's handling of one logical type (drives codegen). `$` = the value being transformed. */
export interface TemplateCell {
  encode: string; // host value -> wire,  e.g. "$.toISOString()"
  decode: string; // wire -> host value,  e.g. "new Date($)"
  imports?: string[]; // import/use statements the glue needs
  dep?: { name: string; version: string }; // 3rd-party manifest entry (absent => stdlib)
  mode: 'native' | 'lib' | 'branded'; // branded = zero-dep primitive wrapper
  construct?: string; // nominal only: build instance from decoded field bag, e.g. "new {T}({fields})"
  toJSON?: string; // nominal only: instance -> field bag, e.g. "{v}.toJSON()"
}

/** @stable Used ONLY where the schema cannot disambiguate (type:{} / any). Plain JSON otherwise.
 *  Wire: { "$apigen": "<LogicalTypeId>", "v": <Wire> }. */
export const ENVELOPE_KEY = '$apigen' as const;
export interface ApigenEnvelope {
  readonly [ENVELOPE_KEY]: LogicalTypeId;
  readonly v: Wire;
}

/** @stable Schema-walking transcoder (impl is a LATER state — interface only here). */
export interface Transcoder {
  encode(value: unknown, schema: SchemaNode, ctx?: Partial<TranscodeCtx>): Wire;
  decode(wire: Wire, schema: SchemaNode, ctx?: Partial<TranscodeCtx>): unknown;
}
