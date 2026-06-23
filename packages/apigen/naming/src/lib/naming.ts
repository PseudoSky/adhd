// @adhd/apigen-naming — canonical naming & projection helpers (SPEC §5 + §9.1).
//
// This module is the single source of truth for all transport-specific name
// projections derived from an `Operation`'s casing-neutral `Segment` tokens.
// No transport may inline its own casing logic; it must call one of the helpers
// exported here.
//
// Design invariants (from SPEC §5):
//   - Casing is per-plugin: each transport derives its own form from `words`.
//   - HTTP verb is a function of `safe`, NOT of `kind`.
//   - The uniqueness / collision check is a hard extract-time error — never silent.
//   - All `x-<pluginId>-<field>` key conventions (§9.1) are centralised here.

import type { Segment, Operation } from '@adhd/apigen-core'

// ---------------------------------------------------------------------------
// Casing projectors — consume Segment.words
// ---------------------------------------------------------------------------

/**
 * Returns a kebab-case rendering of a {@link Segment}'s tokenized words.
 *
 * Used by HTTP routes (`/transform/humanize/humanize-bytes`) and CLI commands
 * (`transform humanize humanize-bytes`).
 *
 * @example toKebab({ raw: 'humanizeBytes', words: ['humanize', 'bytes'] })
 *   // → 'humanize-bytes'
 */
export function toKebab(seg: Segment): string {
  return seg.words.join('-')
}

/**
 * Returns a camelCase rendering of a {@link Segment}'s tokenized words.
 *
 * @example toCamel({ raw: 'humanizeBytes', words: ['humanize', 'bytes'] })
 *   // → 'humanizeBytes'
 */
export function toCamel(seg: Segment): string {
  return seg.words
    .map((w, i) => (i === 0 ? w : capitalize(w)))
    .join('')
}

/**
 * Returns a PascalCase rendering of a {@link Segment}'s tokenized words.
 *
 * Used by gRPC service/method names (`HumanizeBytes`).
 *
 * @example toPascal({ raw: 'humanizeBytes', words: ['humanize', 'bytes'] })
 *   // → 'HumanizeBytes'
 */
export function toPascal(seg: Segment): string {
  return seg.words.map(capitalize).join('')
}

/**
 * Returns a snake_case rendering of a {@link Segment}'s tokenized words.
 *
 * @example toSnake({ raw: 'humanizeBytes', words: ['humanize', 'bytes'] })
 *   // → 'humanize_bytes'
 */
export function toSnake(seg: Segment): string {
  return seg.words.join('_')
}

// ---------------------------------------------------------------------------
// File-name normalisation (SPEC §5)
// ---------------------------------------------------------------------------

/**
 * Normalises a raw file name segment to a kebab-case path component.
 *
 * Rules (SPEC §5):
 * - Strip extension.
 * - Dots and underscores → hyphens (`file.name.ts` → `file-name`).
 *
 * @example normalizeFileName('file.name.ts') // → 'file-name'
 * @example normalizeFileName('my_util.js')   // → 'my-util'
 */
export function normalizeFileName(raw: string): string {
  // Strip the file extension (everything from the last dot onward).
  const noExt = raw.replace(/\.[^.]+$/, '')
  // Dots and underscores become hyphens; collapse sequences.
  return noExt.replace(/[._]+/g, '-')
}

// ---------------------------------------------------------------------------
// Per-transport projection helpers
// ---------------------------------------------------------------------------

/**
 * Result of a full per-transport projection for one {@link Operation}.
 */
export interface TransportProjection {
  /** HTTP: full route (e.g. `POST /transform/humanize/humanize-bytes`). */
  http: { verb: HttpVerb; route: string }
  /** MCP: flat tool name joined with `_` (e.g. `transform_humanize_humanize_bytes`). */
  mcp: { name: string }
  /**
   * gRPC: dotted package + Pascal service (file segment) + Pascal method (export segment).
   * e.g. `{ package: 'transform.humanize', service: 'Humanize', method: 'HumanizeBytes' }`.
   */
  grpc: { package: string; service: string; method: string }
  /** CLI: ordered kebab command segments (e.g. `['transform', 'humanize', 'humanize-bytes']`). */
  cli: { path: string[] }
}

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Per-operation override configuration for projection.
 *
 * Pass at generate/run time via `--opt http.verb.<id>=GET` or a project
 * config file. **Never** modify source (Tenet 1).
 */
export interface ProjectionConfig {
  /**
   * Override the HTTP verb for specific operations by their canonical `id`.
   *
   * Example: `{ 'transform/humanize/humanize-bytes': 'GET' }`.
   */
  http?: { verb?: Record<string, HttpVerb> }
}

/**
 * Projects one {@link Operation} to all transport targets per SPEC §5.
 *
 * Verb derivation: `safe → GET`, `!safe → POST` — then overridable via
 * {@link ProjectionConfig}. **Never** derived from `kind`.
 *
 * @param op     The canonical operation descriptor.
 * @param config Optional projection overrides (e.g. http.verb per id).
 */
export function project(op: Operation, config: ProjectionConfig = {}): TransportProjection {
  const allSegs: Segment[] = [op.namespace, ...op.path]

  // HTTP
  const defaultVerb: HttpVerb = op.safe ? 'GET' : 'POST'
  const verb: HttpVerb = config.http?.verb?.[op.id] ?? defaultVerb
  const route = '/' + allSegs.map((s) => toKebab(s)).join('/')

  // MCP — flat name, segments joined with `_`
  const mcpName = allSegs.map((s) => toSnake(s)).join('_')

  // gRPC — package = lower-dotted (all but last path seg);
  //         service = Pascal(second-to-last, i.e. the "file" seg);
  //         method  = Pascal(last, i.e. the export seg).
  // SPEC §5 example: namespace=transform, path=[humanize, humanizeBytes]
  //   → package: 'transform.humanize', service: 'Humanize', method: 'HumanizeBytes'
  const grpcParts = allSegs.map((s) => toSnake(s))
  const grpcPackage = grpcParts.slice(0, -1).join('.')
  const grpcService = toPascal(allSegs[allSegs.length - 2] ?? allSegs[0])
  const grpcMethod = toPascal(allSegs[allSegs.length - 1])

  // CLI — nested kebab commands
  const cliPath = allSegs.map((s) => toKebab(s))

  return {
    http: { verb, route },
    mcp: { name: mcpName },
    grpc: { package: grpcPackage, service: grpcService, method: grpcMethod },
    cli: { path: cliPath },
  }
}

// ---------------------------------------------------------------------------
// Uniqueness invariant / collision check (SPEC §5)
// ---------------------------------------------------------------------------

/**
 * A collision detected between two operations that project to the same target.
 */
export interface CollisionError {
  /** The transport where the collision occurred. */
  transport: 'http' | 'mcp' | 'grpc' | 'cli'
  /** The projected target string that both operations map to. */
  target: string
  /** The two distinct operation ids that collide. */
  ids: [string, string]
}

/**
 * Thrown when {@link checkCollisions} finds two operations that project to
 * the same transport target. This is a **hard extract-time error** (SPEC §5) —
 * never silent last-writer-wins.
 */
export class CollisionDetectedError extends Error {
  readonly collisions: CollisionError[]

  constructor(collisions: CollisionError[]) {
    const lines = collisions.map(
      (c) => `  [${c.transport}] "${c.target}" ← ${c.ids[0]} vs ${c.ids[1]}`,
    )
    super(`apigen-naming: ${collisions.length} projection collision(s) detected:\n${lines.join('\n')}`)
    this.name = 'CollisionDetectedError'
    this.collisions = collisions
  }
}

/**
 * Runs the uniqueness invariant over a merged descriptor array (SPEC §5).
 *
 * Checks every transport target (HTTP route+verb, MCP name, gRPC
 * package+service+method, CLI path) across all operations. Two distinct `id`s
 * that project to the same target in **any** transport constitute a hard
 * extract-time error — {@link CollisionDetectedError} is thrown.
 *
 * Call this **once** over the full merged descriptor after all operations have
 * been built. Guards the default-object recursion + multi-file glob cases.
 *
 * @param operations The merged set of operations to check.
 * @param config     Optional projection overrides (passed through to `project`).
 * @throws {CollisionDetectedError} if any two distinct ids project to the same target.
 */
export function checkCollisions(
  operations: Operation[],
  config: ProjectionConfig = {},
): void {
  const httpSeen = new Map<string, string>()  // key → opId
  const mcpSeen  = new Map<string, string>()
  const grpcSeen = new Map<string, string>()
  const cliSeen  = new Map<string, string>()

  const collisions: CollisionError[] = []

  for (const op of operations) {
    const p = project(op, config)

    // HTTP: key = verb + route
    const httpKey = `${p.http.verb} ${p.http.route}`
    const existingHttp = httpSeen.get(httpKey)
    if (existingHttp !== undefined && existingHttp !== op.id) {
      collisions.push({ transport: 'http', target: httpKey, ids: [existingHttp, op.id] })
    } else {
      httpSeen.set(httpKey, op.id)
    }

    // MCP: key = flat tool name
    const existingMcp = mcpSeen.get(p.mcp.name)
    if (existingMcp !== undefined && existingMcp !== op.id) {
      collisions.push({ transport: 'mcp', target: p.mcp.name, ids: [existingMcp, op.id] })
    } else {
      mcpSeen.set(p.mcp.name, op.id)
    }

    // gRPC: key = package + service + method
    const grpcKey = `${p.grpc.package}.${p.grpc.service}/${p.grpc.method}`
    const existingGrpc = grpcSeen.get(grpcKey)
    if (existingGrpc !== undefined && existingGrpc !== op.id) {
      collisions.push({ transport: 'grpc', target: grpcKey, ids: [existingGrpc, op.id] })
    } else {
      grpcSeen.set(grpcKey, op.id)
    }

    // CLI: key = joined path
    const cliKey = p.cli.path.join(' ')
    const existingCli = cliSeen.get(cliKey)
    if (existingCli !== undefined && existingCli !== op.id) {
      collisions.push({ transport: 'cli', target: cliKey, ids: [existingCli, op.id] })
    } else {
      cliSeen.set(cliKey, op.id)
    }
  }

  if (collisions.length > 0) {
    throw new CollisionDetectedError(collisions)
  }
}

// ---------------------------------------------------------------------------
// §9.1 Envelope-binding projection helpers
// ---------------------------------------------------------------------------

/**
 * Computes the canonical **HTTP / gRPC metadata / MCP `_meta`** key for an
 * envelope field, following the `x-<pluginId>-<field>` convention (SPEC §9.1).
 *
 * Builtin fields (pluginId = `'adhd'`) drop the plugin segment and use
 * `x-adhd-<field>` (per SPEC §9.1, rule 3).
 *
 * The **same key** is used for HTTP headers, gRPC metadata (ASCII value), and
 * MCP `_meta` entries — one mental model across all k/v carriers (rule 1).
 *
 * For **binary gRPC metadata** append `-bin` to the returned key and base64-
 * encode the value; that detail lives in the gRPC transport adapter, not here.
 *
 * @example envelopeKey('auth', 'session')   // → 'x-auth-session'
 * @example envelopeKey('adhd', 'trace-id')  // → 'x-adhd-trace-id'
 */
export function envelopeKey(pluginId: string, field: string): string {
  return `x-${pluginId}-${field}`
}

/**
 * Computes the **CLI flag name** for an envelope field (SPEC §9.1, rule 2).
 *
 * Surface: `--<pluginId>-<field>` (e.g. `--auth-session`).
 * Builtin fields (`pluginId = 'adhd'`) use `--adhd-<field>`.
 *
 * @example envelopeCliFlag('auth', 'session')  // → '--auth-session'
 * @example envelopeCliFlag('adhd', 'trace-id') // → '--adhd-trace-id'
 */
export function envelopeCliFlag(pluginId: string, field: string): string {
  return `--${pluginId}-${field}`
}

/**
 * Computes the **environment variable name** for an envelope field
 * (SPEC §9.1, rule 2). CLI flag takes precedence over env when both present.
 *
 * Surface: `APIGEN_<PLUGINID>_<FIELD>` (upper-cased, hyphens → underscores).
 * Builtin fields (pluginId = `'adhd'`) drop the plugin segment and use
 * `APIGEN_<FIELD>` (SPEC §9.1, rule 3).
 *
 * @example envelopeEnvVar('auth', 'session')   // → 'APIGEN_AUTH_SESSION'
 * @example envelopeEnvVar('adhd', 'trace-id')  // → 'APIGEN_TRACE_ID'
 */
export function envelopeEnvVar(pluginId: string, field: string): string {
  const toUpperSnake = (s: string) => s.toUpperCase().replace(/-/g, '_')
  if (pluginId === 'adhd') {
    return `APIGEN_${toUpperSnake(field)}`
  }
  return `APIGEN_${toUpperSnake(pluginId)}_${toUpperSnake(field)}`
}

/**
 * Computes the **MCP `_meta` key** for an envelope field — the same
 * `x-<pluginId>-<field>` string used in HTTP/gRPC (SPEC §9.1, rule 1).
 *
 * This is an explicit alias of {@link envelopeKey} with a transport-specific
 * name so call sites are self-documenting.
 *
 * @example envelopeMetaKey('auth', 'session') // → 'x-auth-session'
 */
export const envelopeMetaKey = envelopeKey

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function capitalize(word: string): string {
  if (word.length === 0) return word
  return word[0].toUpperCase() + word.slice(1)
}
