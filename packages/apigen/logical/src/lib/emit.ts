import type {
  LogicalTypeId,
  SchemaNode,
  TemplateCell,
} from './contracts';
import { ENVELOPE_KEY } from './contracts';
import type { LogicalTypeRegistry } from './registry';

/**
 * @stable Generate-time emitter (DESIGN §11 codegen-first, §4.4 walk algorithm).
 *
 * apigen always knows the schema at generate-time, so we do NOT ship a
 * schema-interpreting runtime transcoder per host. Instead, the generator walks
 * the JSON-Schema node ONCE and emits a string expression of direct, typed
 * (de)hydration glue, splicing per-language {@link TemplateCell} columns.
 *
 * Everything here is a PURE function over `(schema, registry, template table)`:
 * deterministic, no I/O, no globals. The emitted text is host-language source
 * (the minimal column shipped here is TypeScript) — `emit.ts` itself never runs
 * it.
 */

/**
 * @stable A per-language template table: maps a {@link LogicalTypeId} (the id a
 * codec is registered under) to that language's {@link TemplateCell}.
 *
 * The registry tells us WHICH logical type owns a node; the table tells us HOW
 * the target language (de)hydrates it. Splitting the two keeps the walk
 * language-agnostic — swap the table to retarget a host.
 */
export type TemplateTable = Readonly<Record<LogicalTypeId, TemplateCell>>;

/**
 * @stable Threaded through an emit walk. Mirrors the structural inputs of a
 * transcode (`registry` + `$ref` resolver) but carries codegen-only state: the
 * language `table`, a JSON-Pointer `path` for diagnostics, a cycle guard over
 * resolved `$ref` targets, and a monotonic counter that mints collision-free
 * lambda parameter names for nested `map`/`object` glue.
 */
export interface EmitCtx {
  /** Resolves which logical type owns a node (format / `x-apigen-codec`). */
  readonly registry: LogicalTypeRegistry;
  /** The active per-language template table. */
  readonly table: TemplateTable;
  /** `$ref` → `$def` resolver (root-bound). See {@link rootRefResolver}. */
  readonly resolve: (ref: string) => SchemaNode;
  /** JSON Pointer to the current node, for diagnostics. */
  readonly path: string;
  /** Cycle guard over `$ref` strings already on the active path. */
  readonly seenRefs: ReadonlySet<string>;
  /** Mints fresh lambda parameter names (`x0`, `x1`, …) for nested glue. */
  readonly mint: () => string;
}

/** Direction of an emit walk. `encode` = host→wire, `decode` = wire→host. */
type Dir = 'encode' | 'decode';

/**
 * @stable Thrown when the schema cannot be lowered to glue in `strict` codegen
 * (e.g. a `$ref` to a `$def` the resolver does not know, or a codec-owned node
 * with no matching column in the active template table).
 */
export class EmitError extends Error {
  /** Stable, transport-neutral error code. */
  readonly code = 'E_EMIT' as const;
  /** JSON Pointer to the offending node. */
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} (at ${path || '#'})`);
    this.name = 'EmitError';
    this.path = path;
  }
}

/**
 * @stable Build the default `$ref` resolver for a generate-time walk: standard
 * JSON-Schema `#/$defs/<name>` (and legacy `#/definitions/<name>`) lookup
 * against a `root` document.
 *
 * @param root The schema document holding `$defs` / `definitions`.
 * @returns A resolver suitable for {@link EmitCtx.resolve}.
 */
export function rootRefResolver(root: SchemaNode): (ref: string) => SchemaNode {
  return (ref: string): SchemaNode => {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    if (!m) {
      throw new EmitError(`E_EMIT: unresolvable $ref "${ref}"`, '');
    }
    const bag = root[m[1]] as Record<string, unknown> | undefined;
    const def = bag?.[decodePointerToken(m[2])];
    if (def == null || typeof def !== 'object') {
      throw new EmitError(`E_EMIT: $ref "${ref}" has no $def target`, '');
    }
    return def as SchemaNode;
  };
}

/** Decode a single JSON-Pointer reference token (`~1`→`/`, `~0`→`~`). */
function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * @stable Construct an {@link EmitCtx} with sensible defaults.
 *
 * @param registry Resolves the owning codec for a node.
 * @param table The target-language template table.
 * @param opts.root Schema document for the default `$ref` resolver.
 * @param opts.resolve Explicit `$ref` resolver (overrides `root`).
 */
export function createEmitCtx(
  registry: LogicalTypeRegistry,
  table: TemplateTable,
  opts: { root?: SchemaNode; resolve?: (ref: string) => SchemaNode } = {},
): EmitCtx {
  const resolve =
    opts.resolve ?? (opts.root ? rootRefResolver(opts.root) : missingResolver);
  let counter = 0;
  return {
    registry,
    table,
    resolve,
    path: '',
    seenRefs: new Set<string>(),
    mint: () => `x${counter++}`,
  };
}

function missingResolver(ref: string): never {
  throw new EmitError(
    `E_EMIT: $ref "${ref}" encountered but no resolver/root was provided`,
    '',
  );
}

/**
 * @stable Emit the host→wire expression for `valueExpr` at `node`.
 *
 * @param valueExpr The source expression holding the host value (e.g. `"data"`).
 * @param node The resolved JSON-Schema node describing `valueExpr`.
 * @param ctx The emit context (registry + table + resolver).
 * @returns A target-language expression producing the wire value.
 */
export function emitEncode(
  valueExpr: string,
  node: SchemaNode,
  ctx: EmitCtx,
): string {
  return walk('encode', valueExpr, node, ctx);
}

/**
 * @stable Emit the wire→host expression for `wireExpr` at `node`.
 *
 * @param wireExpr The source expression holding the wire value.
 * @param node The resolved JSON-Schema node describing the host shape.
 * @param ctx The emit context (registry + table + resolver).
 * @returns A target-language expression reconstructing the host value.
 */
export function emitDecode(
  wireExpr: string,
  node: SchemaNode,
  ctx: EmitCtx,
): string {
  return walk('decode', wireExpr, node, ctx);
}

/**
 * The single schema walk (DESIGN §4.4), specialized to EMIT a string expression
 * rather than to run the transcode. Order of precedence matters and mirrors the
 * transcoder exactly so generated glue and any run-mode interpreter agree:
 *
 *   1. codec-owned node      → splice the language `TemplateCell` (`$` = expr)
 *   2. `$ref`                → recurse the resolved `$def`
 *   3. `oneOf`               → discriminator branch (ternary chain)
 *   4. `type: 'array'`       → `.map` over `items`
 *   5. `type: 'object'`      → object literal over `properties`
 *   6. schema-less (no type) → `$apigen` self-describing envelope (§4.5)
 *   7. plain JSON            → passthrough (`expr` unchanged)
 */
function walk(dir: Dir, expr: string, node: SchemaNode, ctx: EmitCtx): string {
  // 1. A node OWNED by a codec: splice its template cell.
  const codec = ctx.registry.resolve(node);
  if (codec) {
    return spliceCell(dir, expr, codec.id, ctx);
  }

  // 2. $ref: recurse the referenced $def (with a cycle guard).
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    if (ctx.seenRefs.has(ref)) {
      throw new EmitError(
        `E_EMIT: cyclic $ref "${ref}" cannot be lowered to a finite expression`,
        ctx.path,
      );
    }
    const target = ctx.resolve(ref);
    return walk(dir, expr, target, {
      ...ctx,
      path: ref,
      seenRefs: new Set([...ctx.seenRefs, ref]),
    });
  }

  // 3. oneOf: emit a discriminator-driven ternary chain.
  const oneOf = node['oneOf'];
  if (Array.isArray(oneOf)) {
    return emitOneOf(dir, expr, node, oneOf as SchemaNode[], ctx);
  }

  const type = node['type'];

  // 4. array: map each item through the item schema.
  if (type === 'array') {
    const items = (node['items'] as SchemaNode | undefined) ?? {};
    const param = ctx.mint();
    const child = childCtx(ctx, '/items');
    const inner = walk(dir, param, items, child);
    // Passthrough item → avoid a no-op `.map`.
    if (inner === param) return expr;
    return `(${expr}).map((${param}) => ${inner})`;
  }

  // 5. object: rebuild an object literal over declared properties.
  if (type === 'object') {
    const props = node['properties'] as
      | Record<string, SchemaNode>
      | undefined;
    if (props && Object.keys(props).length > 0) {
      return emitObject(dir, expr, props, ctx);
    }
    // Object with no declared properties → plain JSON passthrough.
    return expr;
  }

  // 6. schema-less position (no `type`, no structural keyword we handle):
  //    fall back to the self-describing envelope (§4.5).
  if (type === undefined) {
    return emitEnvelope(dir, expr);
  }

  // 7. plain JSON scalar/array/object the host serializes natively: passthrough.
  return expr;
}

/** Substitute `$` in a template-cell expression with the current value expr. */
function spliceCell(
  dir: Dir,
  expr: string,
  id: LogicalTypeId,
  ctx: EmitCtx,
): string {
  const cell = ctx.table[id];
  if (!cell) {
    throw new EmitError(
      `E_EMIT: no template cell for logical type "${id}" in the active table`,
      ctx.path,
    );
  }
  return substituteDollar(cell[dir], expr);
}

/**
 * Replace every unescaped `$` placeholder with `expr`. A literal dollar in the
 * template can be escaped as `$$` (rare, but keeps the contract total). We wrap
 * `expr` in parens when it is not already an atom so operator precedence in the
 * surrounding template holds (e.g. `String($)` over `a ?? b`).
 */
function substituteDollar(template: string, expr: string): string {
  const safe = isAtom(expr) ? expr : `(${expr})`;
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '$') {
      if (template[i + 1] === '$') {
        out += '$';
        i++;
      } else {
        out += safe;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * An expression is an "atom" (no surrounding parens needed) when it is a plain
 * identifier, a member/index access chain off one, or already parenthesized.
 * Conservative: anything else gets wrapped.
 */
function isAtom(expr: string): boolean {
  if (/^\(.*\)$/.test(expr) && balanced(expr)) return true;
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^[\]]*\])*$/.test(expr);
}

/** True when the string is a single fully-balanced parenthesized group. */
function balanced(expr: string): boolean {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')') {
      depth--;
      if (depth === 0 && i !== expr.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Emit an object literal that (de)hydrates each declared property. */
function emitObject(
  dir: Dir,
  expr: string,
  props: Record<string, SchemaNode>,
  ctx: EmitCtx,
): string {
  // Bind the source once so we don't re-evaluate `expr` per property.
  const src = ctx.mint();
  const entries: string[] = [];
  for (const key of Object.keys(props)) {
    const child = childCtx(ctx, `/properties/${escapePointerToken(key)}`);
    const access = `${src}${memberAccess(key)}`;
    const valueExpr = walk(dir, access, props[key], child);
    entries.push(`${propKey(key)}: ${valueExpr}`);
  }
  const body = `{ ${entries.join(', ')} }`;
  return `((${src}) => (${body}))(${expr})`;
}

/** Emit a discriminator-driven ternary chain over `oneOf` branches. */
function emitOneOf(
  dir: Dir,
  expr: string,
  node: SchemaNode,
  branches: SchemaNode[],
  ctx: EmitCtx,
): string {
  const disc = discriminatorProp(node);
  const src = ctx.mint();
  // Each branch is selected by its const tag on the discriminator property.
  const arms: { tag: string; expr: string }[] = [];
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i];
    const tag = branchTag(branch, disc);
    const child = childCtx(ctx, `/oneOf/${i}`);
    arms.push({ tag, expr: walk(dir, src, branch, child) });
  }
  // Build right-to-left so the last arm is the final fallback.
  let chain = arms.length > 0 ? arms[arms.length - 1].expr : src;
  for (let i = arms.length - 2; i >= 0; i--) {
    const a = arms[i];
    chain = `${src}${memberAccess(disc)} === ${JSON.stringify(a.tag)} ? ${a.expr} : (${chain})`;
  }
  return `((${src}) => (${chain}))(${expr})`;
}

/** The discriminator property name for a `oneOf` (default `"kind"`). */
function discriminatorProp(node: SchemaNode): string {
  const d = node['discriminator'];
  if (d && typeof d === 'object' && typeof (d as Record<string, unknown>)['propertyName'] === 'string') {
    return (d as Record<string, string>)['propertyName'];
  }
  return 'kind';
}

/** The const tag a branch carries on the discriminator property. */
function branchTag(branch: SchemaNode, disc: string): string {
  const props = branch['properties'] as Record<string, SchemaNode> | undefined;
  const prop = props?.[disc];
  const c = prop?.['const'];
  if (typeof c === 'string') return c;
  if (typeof c === 'number' || typeof c === 'boolean') return String(c);
  // Fall back to a `title`/`$id` if no const tag is present.
  const title = branch['title'] ?? branch['$id'];
  return typeof title === 'string' ? title : '';
}

/** Emit the `$apigen` self-describing envelope for a schema-less position. */
function emitEnvelope(dir: Dir, expr: string): string {
  if (dir === 'encode') {
    // We cannot know the logical id at a schema-less position from the schema;
    // the host emits it from the runtime value. Defer to the engine helper.
    return `__apigenEnvelopeEncode(${expr})`;
  }
  // Decode: read the tagged value back out of the envelope.
  return `__apigenEnvelopeDecode(${expr})`;
}

/**
 * @stable The runtime helper pair the envelope fallback (§4.5) compiles against.
 * Emitted glue references `__apigenEnvelopeEncode` / `__apigenEnvelopeDecode`;
 * a host prelude provides them. Exposed as source so a generator can inline a
 * prelude and so the wire shape (`{ $apigen, v }`) is asserted in one place.
 */
export const ENVELOPE_HELPER_SOURCE = `
function __apigenEnvelopeEncode(v) {
  // Schema-less position: pass typed JSON through unchanged. A richer host
  // prelude may wrap recognized runtime types as { ${JSON.stringify(ENVELOPE_KEY)}: id, v }.
  return v;
}
function __apigenEnvelopeDecode(w) {
  return w != null && typeof w === 'object' && ${JSON.stringify(ENVELOPE_KEY)} in w
    ? w.v
    : w;
}
`.trim();

/** Derive a child context with an extended diagnostic path. */
function childCtx(ctx: EmitCtx, segment: string): EmitCtx {
  return { ...ctx, path: ctx.path + segment };
}

/** Member access for a key: dotted when an identifier, bracketed otherwise. */
function memberAccess(key: string): string {
  return isIdentifier(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** An object-literal key: bare when an identifier, quoted otherwise. */
function propKey(key: string): string {
  return isIdentifier(key) ? key : JSON.stringify(key);
}

function isIdentifier(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s);
}

/** Escape a JSON-Pointer reference token (`~`→`~0`, `/`→`~1`). */
function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * @stable A minimal TypeScript template table covering the well-known scalar
 * columns from DESIGN §13.2 (date-time, int64/bigint, byte/bytes). Sufficient
 * to drive and test the walk; the full per-language tables land in later states.
 *
 * Keyed by the {@link LogicalTypeId} a scalar codec registers under (its JSON
 * Schema `format`).
 */
// DEBT-LT-004: the table previously contained `bigint` and `bytes` as
// aliases alongside the canonical ids `int64`/`byte`. These aliases do not
// correspond to any registered codec id — iterating the table keys would see
// 5 entries instead of the 4 canonical ids (`CANONICAL_LOGICAL_TYPE_IDS`
// has 4 scalar entries). Removed. Canonical keys only.
export const TS_TEMPLATE_TABLE: TemplateTable = Object.freeze({
  'date-time': {
    encode: '$.toISOString()',
    decode: 'new Date($)',
    mode: 'native',
  },
  int64: {
    encode: 'String($)',
    decode: 'BigInt($)',
    mode: 'native',
  },
  byte: {
    encode: "Buffer.from($).toString('base64')",
    decode: "new Uint8Array(Buffer.from($, 'base64'))",
    mode: 'native',
  },
});
