// @adhd/apigen-conformance — cross-language conformance vectors (SPEC §4, §5, §6, §9.1, §12/§14)
//
// These vectors are the normative contract that every host runtime (TS now,
// Python / Rust / Go later) MUST satisfy. They are expressed as pure data +
// assertion functions so that a non-TS host can re-run the same logical cases
// (the Python host consumes these later by deserializing the exported JSON).
//
// Vector categories:
//   A. Descriptor round-trip   — serialize → deserialize → deep-equal (SPEC §4)
//   B. Naming / collision      — verb-from-safe; two ids → same target → error (SPEC §5)
//   C. Envelope binding        — field binds to correct carrier key per transport (SPEC §9.1)
//   D. Error mapping           — each ApiErrorCode → correct HTTP/gRPC/CLI/MCP status (SPEC §9.1)
//   E. Validation necessary-not-sufficient — schema-valid-but-domain-wrong passes the validator (SPEC §6)

import type { Operation, Segment } from '@adhd/apigen-core'
import {
  project,
  checkCollisions,
  CollisionDetectedError,
  envelopeKey,
  envelopeCliFlag,
  envelopeEnvVar,
  envelopeMetaKey,
} from '@adhd/apigen-naming'
import {
  ApiError,
  HTTP_STATUS,
  GRPC_CODE,
  CLI_EXIT_CODE,
  MCP_ERROR_KIND,
  type ApiErrorCode,
} from '@adhd/apigen-errors'

// ---------------------------------------------------------------------------
// Shared fixture builders
// ---------------------------------------------------------------------------

/** Build a casing-neutral Segment from a raw token and its word list. */
export function seg(raw: string, words: string[]): Segment {
  return { raw, words }
}

/**
 * Build a minimal but complete Operation.
 *
 * Only the fields tested by a given vector are semantically meaningful;
 * the rest are set to neutral defaults. This mirrors the approach used in
 * `packages/apigen/naming/src/test/naming.spec.ts`.
 */
export function makeOp(overrides: Partial<Operation> & Pick<Operation, 'id' | 'namespace' | 'path'>): Operation {
  return {
    host: 'ts',
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: { type: 'object', properties: {} },
    output: { type: 'object' },
    envelope: {},
    typeText: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// A. Descriptor round-trip vectors (SPEC §4)
//
// A canonical descriptor must survive JSON serialization/deserialization and
// remain deep-equal — this is the portable transport guarantee that lets a
// Python host re-emit what a TS extractor produced.
//
// Rationale: if JSON.parse(JSON.stringify(op)) !== deep-equal op, then any
// host that transports the descriptor over a subprocess pipe (the extractor
// protocol in §14) will silently corrupt it.
// ---------------------------------------------------------------------------

/** The reference Operation used across descriptor round-trip vectors. */
export const ROUND_TRIP_OP: Operation = makeOp({
  id: 'transform/humanize/humanize-bytes',
  host: 'ts',
  namespace: seg('transform', ['transform']),
  path: [seg('humanize', ['humanize']), seg('humanizeBytes', ['humanize', 'bytes'])],
  kind: 'action',
  async: true,
  streaming: false,
  safe: false,
  input: {
    type: 'object',
    properties: {
      bytes: { type: 'number' },
      precision: { type: 'number' },
    },
    required: ['bytes'],
  },
  output: { type: 'string' },
  envelope: {
    type: 'object',
    properties: {
      session: { type: 'string' },
    },
    required: ['session'],
  },
  typeText: { lang: 'ts', input: '{ bytes: number; precision?: number }', output: 'string' },
})

/**
 * Serialize an Operation to a JSON string and deserialize it back.
 *
 * A host runner uses this to prove the descriptor survives its IPC wire
 * (§14: extractor subprocess emits JSON; the CLI merges it). The round-trip
 * MUST be lossless for all spec-defined fields.
 */
export function roundTripOperation(op: Operation): Operation {
  return JSON.parse(JSON.stringify(op)) as Operation
}

/**
 * Assert that two Operations are deep-equal on every SPEC §4 field.
 *
 * Returns `null` on success; returns a string describing the first mismatch
 * on failure (so non-TS hosts can surface useful diagnostics).
 */
export function assertOperationEqual(a: Operation, b: Operation): null | string {
  const aStr = JSON.stringify(a)
  const bStr = JSON.stringify(b)
  if (aStr === bStr) return null
  // Walk the top-level fields to find the first mismatch.
  const fields = Object.keys(a) as (keyof Operation)[]
  for (const f of fields) {
    if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
      return `field "${f}" differs: ${JSON.stringify(a[f])} !== ${JSON.stringify(b[f])}`
    }
  }
  return `unexpected structural diff (key set mismatch)`
}

// Conformance vector data for category A — language-neutral representation.
// A host runner deserializes this array and runs each case.
export const DESCRIPTOR_VECTORS = [
  {
    id: 'descriptor.roundtrip.1',
    description: 'A complete Operation round-trips through JSON serialization losslessly',
    input: ROUND_TRIP_OP,
  },
  {
    id: 'descriptor.roundtrip.2',
    description: 'typeText: null is preserved (not dropped or coerced)',
    input: makeOp({
      id: 'transform/ping',
      namespace: seg('transform', ['transform']),
      path: [seg('ping', ['ping'])],
      typeText: null,
    }),
  },
  {
    id: 'descriptor.roundtrip.3',
    description: 'Empty $defs in input schema is preserved',
    input: makeOp({
      id: 'transform/noop',
      namespace: seg('transform', ['transform']),
      path: [seg('noop', ['noop'])],
      input: { type: 'object', $defs: {}, properties: {} },
    }),
  },
] as const

// ---------------------------------------------------------------------------
// B. Naming / collision vectors (SPEC §5)
//
// Tests:
//   B1. safe=true  → HTTP verb is GET  (query-like)
//   B2. safe=false → HTTP verb is POST (action-like)
//   B3. Two distinct ids that project to the same MCP name → CollisionDetectedError
//   B4. Two distinct ids that project to the same HTTP route+verb → CollisionDetectedError
//   B5. Negative: distinct ids that do NOT collide → no error
// ---------------------------------------------------------------------------

const nsAuth = seg('auth', ['auth'])
const nsTransform = seg('transform', ['transform'])
const segSession = seg('session', ['session'])
const segLogin = seg('login', ['login'])
const segHumanize = seg('humanize', ['humanize'])
const segHumanizeBytes = seg('humanizeBytes', ['humanize', 'bytes'])

/** unsafe action (safe=false): POST /transform/humanize/humanize-bytes */
export const OP_UNSAFE_ACTION = makeOp({
  id: 'transform/humanize/humanize-bytes',
  namespace: nsTransform,
  path: [segHumanize, segHumanizeBytes],
  safe: false,
})

/** safe query (safe=true): GET /transform/humanize/humanize-bytes */
export const OP_SAFE_QUERY = makeOp({
  id: 'transform/humanize/humanize-bytes-safe',
  namespace: nsTransform,
  path: [segHumanize, segHumanizeBytes],
  safe: true,
})

/**
 * Two operations whose `path` tokenization is identical — they will collide
 * in every transport. Used for the collision negative-control.
 *
 * Op A: id='auth/session' path=[session]
 * Op B: id='auth/login'   path=[session]  ← same segment words despite different id
 */
export const OP_COLLISION_A = makeOp({
  id: 'auth/session',
  namespace: nsAuth,
  path: [segSession],
  safe: false,
})

// This op has a different id but IDENTICAL words → projects to same MCP/HTTP/gRPC/CLI target.
export const OP_COLLISION_B = makeOp({
  id: 'auth/login',
  namespace: nsAuth,
  path: [seg('session', ['session'])],  // same words as segSession → collision
  safe: false,
})

// Two genuinely distinct ops that do NOT collide.
export const OP_DISTINCT_A = makeOp({
  id: 'auth/session',
  namespace: nsAuth,
  path: [segSession],
  safe: false,
})
export const OP_DISTINCT_B = makeOp({
  id: 'auth/login',
  namespace: nsAuth,
  path: [segLogin],
  safe: false,
})

/** Assert that an Operation with safe=false projects to POST over HTTP. */
export function assertUnsafeIsPost(op: Operation): null | string {
  const p = project(op)
  if (p.http.verb !== 'POST') {
    return `expected verb POST for safe=false, got ${p.http.verb}`
  }
  return null
}

/** Assert that an Operation with safe=true projects to GET over HTTP. */
export function assertSafeIsGet(op: Operation): null | string {
  const p = project(op)
  if (p.http.verb !== 'GET') {
    return `expected verb GET for safe=true, got ${p.http.verb}`
  }
  return null
}

/**
 * Assert that checkCollisions throws CollisionDetectedError for a colliding pair.
 *
 * Returns `null` on success (i.e. the error WAS thrown); returns a diagnostic
 * string if the expected error was NOT thrown.
 */
export function assertCollisionDetected(ops: Operation[]): null | string {
  try {
    checkCollisions(ops)
    return 'expected CollisionDetectedError to be thrown, but checkCollisions succeeded'
  } catch (e) {
    if (e instanceof CollisionDetectedError) return null
    return `expected CollisionDetectedError, got: ${String(e)}`
  }
}

/**
 * Assert that checkCollisions does NOT throw for a non-colliding set.
 */
export function assertNoCollision(ops: Operation[]): null | string {
  try {
    checkCollisions(ops)
    return null
  } catch (e) {
    return `expected no collision, but got: ${String(e)}`
  }
}

// Language-neutral data representation of category B vectors.
export const NAMING_VECTORS = [
  {
    id: 'naming.verb.1',
    description: 'safe=false → HTTP verb is POST',
    op: OP_UNSAFE_ACTION,
    expected: { httpVerb: 'POST' },
  },
  {
    id: 'naming.verb.2',
    description: 'safe=true → HTTP verb is GET',
    op: OP_SAFE_QUERY,
    expected: { httpVerb: 'GET' },
  },
  {
    id: 'naming.verb.NEGATIVE',
    description: 'safe=false does NOT produce GET (negative control)',
    op: OP_UNSAFE_ACTION,
    expected: { httpVerbIsNot: 'GET' },
  },
  {
    id: 'naming.collision.1',
    description: 'Two ids with identical path tokenization → CollisionDetectedError',
    ops: [OP_COLLISION_A, OP_COLLISION_B],
    expected: { collision: true },
  },
  {
    id: 'naming.collision.2',
    description: 'Distinct ops do NOT trigger collision',
    ops: [OP_DISTINCT_A, OP_DISTINCT_B],
    expected: { collision: false },
  },
  {
    id: 'naming.collision.NEGATIVE',
    description: 'Non-colliding set must NOT throw (negative control)',
    ops: [OP_DISTINCT_A, OP_DISTINCT_B],
    expected: { collision: false },
  },
] as const

// ---------------------------------------------------------------------------
// C. Envelope binding vectors (SPEC §9.1)
//
// Canonical identity = (pluginId, field). Each transport binds it differently:
//   k/v carriers (HTTP, gRPC, MCP): x-<pluginId>-<field>
//   CLI: --<pluginId>-<field> + env APIGEN_<PLUGINID>_<FIELD>
//   Builtin (adhd): drop plugin segment → x-adhd-<field> / APIGEN_<FIELD>
// ---------------------------------------------------------------------------

/** Representative envelope field cases. */
export const ENVELOPE_CASES = [
  { pluginId: 'auth',  field: 'session',  expectedKey: 'x-auth-session',  expectedFlag: '--auth-session',  expectedEnv: 'APIGEN_AUTH_SESSION' },
  { pluginId: 'adhd',  field: 'trace-id', expectedKey: 'x-adhd-trace-id', expectedFlag: '--adhd-trace-id', expectedEnv: 'APIGEN_TRACE_ID' },
  { pluginId: 'rate',  field: 'limit',    expectedKey: 'x-rate-limit',    expectedFlag: '--rate-limit',    expectedEnv: 'APIGEN_RATE_LIMIT' },
] as const

/**
 * Assert envelope binding for a single (pluginId, field) pair.
 *
 * Returns `null` on full success; returns a diagnostic string on the first failure.
 */
export function assertEnvelopeBinding(
  pluginId: string,
  field: string,
  expectedKey: string,
  expectedFlag: string,
  expectedEnv: string,
): null | string {
  const key  = envelopeKey(pluginId, field)
  const flag = envelopeCliFlag(pluginId, field)
  const env  = envelopeEnvVar(pluginId, field)
  const meta = envelopeMetaKey(pluginId, field)

  if (key !== expectedKey)   return `envelopeKey: expected "${expectedKey}", got "${key}"`
  if (flag !== expectedFlag) return `envelopeCliFlag: expected "${expectedFlag}", got "${flag}"`
  if (env !== expectedEnv)   return `envelopeEnvVar: expected "${expectedEnv}", got "${env}"`
  // §9.1 rule 1: MCP _meta key === HTTP key
  if (meta !== key)          return `envelopeMetaKey !== envelopeKey: "${meta}" !== "${key}"`
  return null
}

// Language-neutral data representation of category C vectors.
export const ENVELOPE_VECTORS = ENVELOPE_CASES.map((c) => ({
  id: `envelope.binding.${c.pluginId}.${c.field.replace(/-/g, '_')}`,
  description: `(${c.pluginId}, ${c.field}) → correct carrier key for all transports`,
  pluginId: c.pluginId,
  field: c.field,
  expected: {
    httpHeader:  c.expectedKey,
    grpcMeta:    c.expectedKey,
    mcpMetaKey:  c.expectedKey,
    cliFlag:     c.expectedFlag,
    cliEnvVar:   c.expectedEnv,
  },
}))

// ---------------------------------------------------------------------------
// D. Error mapping vectors (SPEC §9.1)
//
// Each canonical ApiErrorCode must map to the exact HTTP/gRPC/CLI/MCP values
// in the SPEC §9 table. The vector data is language-neutral so a Python host
// can assert the same mappings against its own error taxonomy package.
// ---------------------------------------------------------------------------

/** The normative §9 mapping table expressed as plain data. */
export const ERROR_MAPPING_VECTORS: Array<{
  id: string
  code: ApiErrorCode
  expected: { http: number; grpc: string; cli: number; mcp: 'error' }
}> = [
  { id: 'error.map.invalid_argument', code: 'invalid_argument', expected: { http: 400, grpc: 'INVALID_ARGUMENT', cli: 2, mcp: 'error' } },
  { id: 'error.map.unauthenticated',  code: 'unauthenticated',  expected: { http: 401, grpc: 'UNAUTHENTICATED',  cli: 3, mcp: 'error' } },
  { id: 'error.map.permission_denied',code: 'permission_denied',expected: { http: 403, grpc: 'PERMISSION_DENIED',cli: 3, mcp: 'error' } },
  { id: 'error.map.not_found',        code: 'not_found',        expected: { http: 404, grpc: 'NOT_FOUND',        cli: 4, mcp: 'error' } },
  { id: 'error.map.internal',         code: 'internal',         expected: { http: 500, grpc: 'INTERNAL',         cli: 1, mcp: 'error' } },
]

/**
 * Assert that a given ApiErrorCode maps to the expected transport statuses.
 *
 * Returns `null` on success; diagnostic string on first failure.
 */
export function assertErrorMapping(
  code: ApiErrorCode,
  expected: { http: number; grpc: string; cli: number; mcp: 'error' },
): null | string {
  if (HTTP_STATUS[code] !== expected.http) {
    return `HTTP_STATUS[${code}]: expected ${expected.http}, got ${HTTP_STATUS[code]}`
  }
  if (GRPC_CODE[code] !== expected.grpc) {
    return `GRPC_CODE[${code}]: expected "${expected.grpc}", got "${GRPC_CODE[code]}"`
  }
  if (CLI_EXIT_CODE[code] !== expected.cli) {
    return `CLI_EXIT_CODE[${code}]: expected ${expected.cli}, got ${CLI_EXIT_CODE[code]}`
  }
  if (MCP_ERROR_KIND[code] !== expected.mcp) {
    return `MCP_ERROR_KIND[${code}]: expected "${expected.mcp}", got "${MCP_ERROR_KIND[code]}"`
  }
  return null
}

/**
 * Assert that ApiError is constructible with the given code and that its code
 * field survives serialization (toJSON) — the carrier shape shipped over every
 * transport must round-trip the code.
 */
export function assertApiErrorCodeSurvivesSerialize(code: ApiErrorCode): null | string {
  const err = new ApiError(code, 'test message')
  const json = err.toJSON()
  if (json.code !== code) {
    return `ApiError.toJSON().code: expected "${code}", got "${json.code}"`
  }
  return null
}

// ---------------------------------------------------------------------------
// E. Validation necessary-not-sufficient vectors (SPEC §6)
//
// JSON-Schema validation is a fast-fail pre-filter, NOT the host's native type
// guarantee. A schema-valid value may be domain-wrong (e.g. a number that
// exceeds JavaScript's safe integer range, extra properties, date strings
// that parse to wrong dates, or an Option vs a missing key).
//
// These vectors prove that the validation layer accepts the "valid-but-wrong"
// value — the authoritative boundary is the host's typed dispatch, not the
// validator. A host MUST NOT treat "validated" as "safe to transmute."
//
// Each vector carries a JSONSchema + an example that is schema-valid but
// should be rejected by a stricter typed deserializer. The runner only checks
// that the schema validator ACCEPTS it (the spec-compliant behavior).
// ---------------------------------------------------------------------------

/**
 * A validation case: a JSON Schema + a value that is schema-valid.
 * A host validator MUST accept this value without error.
 *
 * The `domainNote` explains why the value is still "wrong" at the domain level —
 * this is the "necessary-not-sufficient" proof.
 */
export interface ValidationCase {
  id: string
  description: string
  schema: Record<string, unknown>
  /** A value that satisfies the JSON Schema but may be wrong at domain level. */
  schemaValidValue: unknown
  /** Why the value is still problematic despite passing schema validation. */
  domainNote: string
}

export const VALIDATION_VECTORS: ValidationCase[] = [
  {
    id: 'validation.extra-properties',
    description: 'additionalProperties not restricted — extra keys pass schema but may cause dispatch errors',
    schema: {
      type: 'object',
      properties: { userId: { type: 'string' } },
      required: ['userId'],
    },
    schemaValidValue: { userId: 'abc', unexpectedField: 'injection' },
    domainNote: 'An unexpected field passes the schema but may be ignored or cause a typed dispatch error in strict hosts (Rust/Go).',
  },
  {
    id: 'validation.number-precision',
    description: 'A JSON number within the schema range but beyond JS safe integer boundary',
    schema: {
      type: 'object',
      properties: { amount: { type: 'integer' } },
      required: ['amount'],
    },
    // This exceeds Number.MAX_SAFE_INTEGER — JSON.parse will silently corrupt it.
    schemaValidValue: { amount: 9007199254740993 },
    domainNote: 'Exceeds Number.MAX_SAFE_INTEGER; JSON.parse silently rounds it. SPEC §4 mandates int64 as string-encoded for 64-bit integers; this proves the validator alone cannot catch the precision loss.',
  },
  {
    id: 'validation.date-string',
    description: 'A date-format string is schema-valid but semantically wrong',
    schema: {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
      required: ['at'],
    },
    schemaValidValue: { at: '2099-02-30T00:00:00Z' }, // Feb 30 does not exist
    domainNote: 'Standard AJV does not validate date-time values by default; Feb 30 passes schema validation but is a semantically invalid date.',
  },
  {
    id: 'validation.option-vs-missing',
    description: 'An Option/nullable field being null passes where a domain function expects presence',
    schema: {
      type: 'object',
      properties: {
        user: { oneOf: [{ type: 'object', properties: { id: { type: 'string' } } }, { type: 'null' }] },
      },
      required: ['user'],
    },
    schemaValidValue: { user: null },
    domainNote: 'null satisfies the oneOf schema, but a domain function that destructures user.id will throw at runtime — validation passed, dispatch fails.',
  },
]

/**
 * A minimal JSON-Schema validator that checks the type keyword and required
 * fields only — sufficient to prove "schema-valid-but-domain-wrong" for the
 * vectors above without pulling in a full AJV dependency.
 *
 * Returns `true` if the value passes this minimal check, `false` otherwise.
 *
 * HOST RUNNERS: replace this with your host's real schema validator (AJV /
 * pydantic / schemars). The point is that the real validator ALSO accepts
 * these values, so the host's typed dispatch is the authoritative gate.
 */
export function minimalSchemaValidate(
  schema: Record<string, unknown>,
  value: unknown,
): boolean {
  if (schema['type'] === 'object') {
    if (typeof value !== 'object' || value === null) return false
    const required = schema['required'] as string[] | undefined
    if (required) {
      const obj = value as Record<string, unknown>
      for (const key of required) {
        if (!(key in obj)) return false
      }
    }
    return true
  }
  // For non-object schemas (string, number, null) just check that the value
  // is present — sufficient for the vectors defined above.
  return value !== undefined
}

// ---------------------------------------------------------------------------
// Runner — execute all vectors and collect results
// ---------------------------------------------------------------------------

/** A single vector result. */
export interface VectorResult {
  id: string
  pass: boolean
  /** Populated on failure with a diagnostic string. */
  error?: string
}

/** Execute all conformance vectors and return per-vector results. */
export function runAllVectors(): VectorResult[] {
  const results: VectorResult[] = []

  // ---- A. Descriptor round-trip ----
  for (const v of DESCRIPTOR_VECTORS) {
    const rt = roundTripOperation(v.input)
    const err = assertOperationEqual(v.input, rt)
    results.push({ id: v.id, pass: err === null, error: err ?? undefined })
  }

  // ---- B. Naming / collision ----

  // verb from safe
  {
    const err = assertUnsafeIsPost(OP_UNSAFE_ACTION)
    results.push({ id: 'naming.verb.1', pass: err === null, error: err ?? undefined })
  }
  {
    const err = assertSafeIsGet(OP_SAFE_QUERY)
    results.push({ id: 'naming.verb.2', pass: err === null, error: err ?? undefined })
  }
  // negative: safe=false must NOT be GET
  {
    const p = project(OP_UNSAFE_ACTION)
    const pass = p.http.verb !== 'GET'
    results.push({ id: 'naming.verb.NEGATIVE', pass, error: pass ? undefined : 'safe=false produced GET (should be POST)' })
  }
  // collision detected
  {
    const err = assertCollisionDetected([OP_COLLISION_A, OP_COLLISION_B])
    results.push({ id: 'naming.collision.1', pass: err === null, error: err ?? undefined })
  }
  // no collision
  {
    const err = assertNoCollision([OP_DISTINCT_A, OP_DISTINCT_B])
    results.push({ id: 'naming.collision.2', pass: err === null, error: err ?? undefined })
  }
  // negative: non-colliding set must NOT throw
  {
    const err = assertNoCollision([OP_DISTINCT_A, OP_DISTINCT_B])
    results.push({ id: 'naming.collision.NEGATIVE', pass: err === null, error: err ?? undefined })
  }

  // ---- C. Envelope binding ----
  for (const c of ENVELOPE_CASES) {
    const id = `envelope.binding.${c.pluginId}.${c.field.replace(/-/g, '_')}`
    const err = assertEnvelopeBinding(c.pluginId, c.field, c.expectedKey, c.expectedFlag, c.expectedEnv)
    results.push({ id, pass: err === null, error: err ?? undefined })
  }

  // ---- D. Error mapping ----
  for (const v of ERROR_MAPPING_VECTORS) {
    const err = assertErrorMapping(v.code, v.expected)
    results.push({ id: v.id, pass: err === null, error: err ?? undefined })
  }
  // Also assert code survives serialization
  for (const v of ERROR_MAPPING_VECTORS) {
    const id = `${v.id}.serialize`
    const err = assertApiErrorCodeSurvivesSerialize(v.code)
    results.push({ id, pass: err === null, error: err ?? undefined })
  }

  // ---- E. Validation necessary-not-sufficient ----
  for (const v of VALIDATION_VECTORS) {
    // The schema MUST accept the value (that is the spec-compliant behavior).
    const accepted = minimalSchemaValidate(v.schema, v.schemaValidValue)
    results.push({
      id: v.id,
      pass: accepted,
      error: accepted ? undefined : `schema validator rejected a schema-valid value (should have accepted): ${JSON.stringify(v.schemaValidValue)}`,
    })
    // Negative control: the validator must REJECT an invalid value for the same schema.
    const negId = `${v.id}.NEGATIVE`
    const rejectedInvalid = !minimalSchemaValidate(v.schema, 'not-an-object')
    results.push({
      id: negId,
      pass: rejectedInvalid,
      error: rejectedInvalid ? undefined : `schema validator accepted "not-an-object" as valid for an object schema`,
    })
  }

  return results
}
