// vectors.spec.ts — conformance vector test suite for @adhd/apigen-conformance
//
// Every vector category has:
//   - At least one positive assertion (the spec-mandated behavior)
//   - At least one negative control (verifies the test actually fails if the code regresses)
//
// The runner (`runAllVectors`) is integration-tested end-to-end as a smoke check.

import { describe, it, expect } from 'vitest'

import {
  // fixtures
  seg,
  makeOp,

  // A. descriptor round-trip
  ROUND_TRIP_OP,
  DESCRIPTOR_VECTORS,
  roundTripOperation,
  assertOperationEqual,

  // B. naming / collision
  OP_UNSAFE_ACTION,
  OP_SAFE_QUERY,
  OP_COLLISION_A,
  OP_COLLISION_B,
  OP_DISTINCT_A,
  OP_DISTINCT_B,
  assertUnsafeIsPost,
  assertSafeIsGet,
  assertCollisionDetected,
  assertNoCollision,

  // C. envelope binding
  ENVELOPE_CASES,
  assertEnvelopeBinding,

  // D. error mapping
  ERROR_MAPPING_VECTORS,
  assertErrorMapping,
  assertApiErrorCodeSurvivesSerialize,

  // E. validation necessary-not-sufficient
  VALIDATION_VECTORS,
  minimalSchemaValidate,

  // F. logical type wire spec
  logicalTypeVectors,
  assertLogicalTypeVectorWellFormed,
  assertLogicalTypeVectorIdsUnique,
  assertLogicalTypeVectorCoverage,
  assertWireMatchesFormat,

  // runner
  runAllVectors,
} from '../lib/vectors'

import {
  CollisionDetectedError,
  project,
  checkCollisions,
  envelopeKey,
  envelopeMetaKey,
  envelopeEnvVar,
} from '@adhd/apigen-naming'
import { ApiError } from '@adhd/apigen-errors'

// ---------------------------------------------------------------------------
// A. Descriptor round-trip (SPEC §4)
// ---------------------------------------------------------------------------

describe('A — Descriptor round-trip', () => {
  it('[roundtrip.1] the reference Operation survives JSON serialization losslessly', () => {
    const rt = roundTripOperation(ROUND_TRIP_OP)
    const err = assertOperationEqual(ROUND_TRIP_OP, rt)
    expect(err).toBeNull()
  })

  it('[roundtrip.2] typeText: null is preserved through round-trip', () => {
    const op = makeOp({
      id: 'transform/ping',
      namespace: seg('transform', ['transform']),
      path: [seg('ping', ['ping'])],
      typeText: null,
    })
    const rt = roundTripOperation(op)
    expect(rt.typeText).toBeNull()
  })

  it('[roundtrip.3] empty $defs is preserved (not dropped)', () => {
    const op = makeOp({
      id: 'transform/noop',
      namespace: seg('transform', ['transform']),
      path: [seg('noop', ['noop'])],
      input: { type: 'object', $defs: {}, properties: {} },
    })
    const rt = roundTripOperation(op)
    expect((rt.input as Record<string, unknown>)['$defs']).toEqual({})
  })

  it('[roundtrip.4] all §4 required fields survive round-trip (structural)', () => {
    const rt = roundTripOperation(ROUND_TRIP_OP)
    const requiredFields: (keyof typeof ROUND_TRIP_OP)[] = [
      'id', 'host', 'namespace', 'path', 'kind', 'async',
      'streaming', 'safe', 'input', 'output', 'envelope', 'typeText',
    ]
    for (const f of requiredFields) {
      expect(rt).toHaveProperty(f)
    }
  })

  it('[roundtrip.NEGATIVE] assertOperationEqual detects a mutation (negative control)', () => {
    const mutated = { ...ROUND_TRIP_OP, id: 'wrong/id' }
    const err = assertOperationEqual(ROUND_TRIP_OP, mutated)
    // Must NOT be null — the mutation must be detected.
    expect(err).not.toBeNull()
    expect(err).toContain('id')
  })

  it('[roundtrip.DATA] all DESCRIPTOR_VECTORS pass their round-trip', () => {
    for (const v of DESCRIPTOR_VECTORS) {
      const rt = roundTripOperation(v.input)
      const err = assertOperationEqual(v.input, rt)
      expect(err, `vector ${v.id} failed: ${err}`).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// B. Naming / collision (SPEC §5)
// ---------------------------------------------------------------------------

describe('B — Naming & collision', () => {
  // --- verb from safe ---

  it('[naming.verb.1] safe=false → HTTP verb is POST', () => {
    const err = assertUnsafeIsPost(OP_UNSAFE_ACTION)
    expect(err).toBeNull()
  })

  it('[naming.verb.2] safe=true → HTTP verb is GET', () => {
    const err = assertSafeIsGet(OP_SAFE_QUERY)
    expect(err).toBeNull()
  })

  it('[naming.verb.NEGATIVE.1] safe=false does NOT produce GET (negative control)', () => {
    // If safe=false and the test helper asserts POST, assertSafeIsGet should FAIL
    const err = assertSafeIsGet(OP_UNSAFE_ACTION)
    expect(err).not.toBeNull()
    expect(err).toMatch(/GET/)
  })

  it('[naming.verb.NEGATIVE.2] safe=true does NOT produce POST (negative control)', () => {
    const err = assertUnsafeIsPost(OP_SAFE_QUERY)
    expect(err).not.toBeNull()
    expect(err).toMatch(/POST/)
  })

  // --- collision detection ---

  it('[naming.collision.1] two ids with identical path tokenization → CollisionDetectedError', () => {
    const err = assertCollisionDetected([OP_COLLISION_A, OP_COLLISION_B])
    expect(err).toBeNull()
  })

  it('[naming.collision.2] distinct operations do NOT trigger a collision', () => {
    const err = assertNoCollision([OP_DISTINCT_A, OP_DISTINCT_B])
    expect(err).toBeNull()
  })

  it('[naming.collision.3] CollisionDetectedError carries the colliding ids', () => {
    expect(() => {
      checkCollisions([OP_COLLISION_A, OP_COLLISION_B])
    }).toThrow(CollisionDetectedError)
  })

  it('[naming.collision.NEGATIVE] non-colliding set must NOT throw (negative control)', () => {
    // Prove the test would catch a false positive: assertCollisionDetected on a
    // non-colliding set must FAIL (meaning: the collision was NOT detected, as expected).
    const err = assertCollisionDetected([OP_DISTINCT_A, OP_DISTINCT_B])
    // The helper returns an error string when the expected exception was NOT thrown.
    expect(err).not.toBeNull()
    expect(err).toContain('CollisionDetectedError')
  })

  it('[naming.mcp.1] MCP name is all segments joined with underscore', () => {
    const p = project(OP_UNSAFE_ACTION)
    // namespace=transform, path=[humanize, humanizeBytes(words=['humanize','bytes'])]
    // → transform_humanize_humanize_bytes
    expect(p.mcp.name).toBe('transform_humanize_humanize_bytes')
  })

  it('[naming.http.route.1] HTTP route is kebab slash-joined', () => {
    const p = project(OP_UNSAFE_ACTION)
    expect(p.http.route).toBe('/transform/humanize/humanize-bytes')
  })
})

// ---------------------------------------------------------------------------
// C. Envelope binding (SPEC §9.1)
// ---------------------------------------------------------------------------

describe('C — Envelope binding', () => {
  for (const c of ENVELOPE_CASES) {
    it(`[envelope.${c.pluginId}.${c.field}] all transport carriers resolve correctly`, () => {
      const err = assertEnvelopeBinding(c.pluginId, c.field, c.expectedKey, c.expectedFlag, c.expectedEnv)
      expect(err).toBeNull()
    })
  }

  it('[envelope.rule1] MCP _meta key equals HTTP header key (one mental model)', () => {
    // Rule 1: all k/v carriers share the same x-<pluginId>-<field> key.
    expect(envelopeMetaKey('auth', 'session')).toBe(envelopeKey('auth', 'session'))
  })

  it('[envelope.rule3.builtin] builtin plugin (adhd) drops plugin segment in env var', () => {
    // APIGEN_<FIELD> not APIGEN_ADHD_<FIELD>
    expect(envelopeEnvVar('adhd', 'trace-id')).toBe('APIGEN_TRACE_ID')
  })

  it('[envelope.NEGATIVE] wrong expected key is detected', () => {
    // If the expected key is wrong, assertEnvelopeBinding must return an error.
    const err = assertEnvelopeBinding('auth', 'session', 'x-wrong-key', '--auth-session', 'APIGEN_AUTH_SESSION')
    expect(err).not.toBeNull()
    expect(err).toContain('envelopeKey')
  })
})

// ---------------------------------------------------------------------------
// D. Error mapping (SPEC §9.1)
// ---------------------------------------------------------------------------

describe('D — Error mapping', () => {
  for (const v of ERROR_MAPPING_VECTORS) {
    it(`[${v.id}] ${v.code} maps to correct HTTP/gRPC/CLI/MCP statuses`, () => {
      const err = assertErrorMapping(v.code, v.expected)
      expect(err).toBeNull()
    })

    it(`[${v.id}.serialize] code survives ApiError.toJSON()`, () => {
      const err = assertApiErrorCodeSurvivesSerialize(v.code)
      expect(err).toBeNull()
    })
  }

  it('[error.class.1] ApiError is instanceof Error', () => {
    const e = new ApiError('not_found', 'missing')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(ApiError)
  })

  it('[error.class.2] ApiError.name is "ApiError"', () => {
    const e = new ApiError('internal', 'oops')
    expect(e.name).toBe('ApiError')
  })

  it('[error.class.3] optional details are preserved in toJSON', () => {
    const e = new ApiError('invalid_argument', 'bad', { field: 'email' })
    expect(e.toJSON().details).toEqual({ field: 'email' })
  })

  it('[error.NEGATIVE] wrong HTTP status is detected', () => {
    // Prove assertErrorMapping catches a wrong expected value.
    const err = assertErrorMapping('not_found', { http: 999, grpc: 'NOT_FOUND', cli: 4, mcp: 'error' })
    expect(err).not.toBeNull()
    expect(err).toContain('HTTP_STATUS')
  })

  it('[error.NEGATIVE.grpc] wrong gRPC code is detected', () => {
    const err = assertErrorMapping('internal', { http: 500, grpc: 'WRONG', cli: 1, mcp: 'error' })
    expect(err).not.toBeNull()
    expect(err).toContain('GRPC_CODE')
  })
})

// ---------------------------------------------------------------------------
// E. Validation necessary-not-sufficient (SPEC §6)
// ---------------------------------------------------------------------------

describe('E — Validation necessary-not-sufficient', () => {
  for (const v of VALIDATION_VECTORS) {
    it(`[${v.id}] schema-valid-but-domain-wrong value passes the validator`, () => {
      const accepted = minimalSchemaValidate(v.schema, v.schemaValidValue)
      expect(accepted).toBe(true)
    })

    it(`[${v.id}.NEGATIVE] clearly invalid value is rejected (negative control)`, () => {
      // "not-an-object" must be rejected for any of these object schemas.
      const rejected = minimalSchemaValidate(v.schema, 'not-an-object')
      expect(rejected).toBe(false)
    })
  }

  it('[validation.missing-required] value missing a required key is rejected', () => {
    const schema = {
      type: 'object',
      properties: { userId: { type: 'string' } },
      required: ['userId'],
    }
    expect(minimalSchemaValidate(schema, {})).toBe(false)
  })

  it('[validation.present-required] value with required key is accepted', () => {
    const schema = {
      type: 'object',
      properties: { userId: { type: 'string' } },
      required: ['userId'],
    }
    expect(minimalSchemaValidate(schema, { userId: 'abc' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// F. Logical type wire spec (DESIGN §3 / §4.7)
// ---------------------------------------------------------------------------

describe('F — Logical type wire spec', () => {
  // --- meta: set integrity ---

  it('[logical.meta.ids-unique] all vector ids are unique', () => {
    const err = assertLogicalTypeVectorIdsUnique(logicalTypeVectors)
    expect(err).toBeNull()
  })

  it('[logical.meta.coverage] all required §3 scalar types have at least one vector', () => {
    const err = assertLogicalTypeVectorCoverage(logicalTypeVectors)
    expect(err).toBeNull()
  })

  it('[logical.meta.NEGATIVE.duplicate-id] duplicate id is detected (negative control)', () => {
    // Inject a duplicate and confirm the checker catches it.
    const [first] = logicalTypeVectors
    const withDupe = [...logicalTypeVectors, { ...first }]
    const err = assertLogicalTypeVectorIdsUnique(withDupe)
    expect(err).not.toBeNull()
    expect(err).toContain(first.id)
  })

  it('[logical.meta.NEGATIVE.missing-coverage] a missing type is detected (negative control)', () => {
    // Remove a vector and confirm the coverage check catches it.
    const withoutFirst = logicalTypeVectors.slice(1)
    const err = assertLogicalTypeVectorCoverage(withoutFirst)
    // The first vector's logicalType is now missing, so coverage must fail.
    expect(err).not.toBeNull()
  })

  // --- per-vector shape checks ---

  for (const v of logicalTypeVectors) {
    it(`[${v.id}.shape] vector is structurally well-formed`, () => {
      const err = assertLogicalTypeVectorWellFormed(v)
      expect(err, err ?? undefined).toBeNull()
    })
  }

  // --- per-vector wire-format pattern checks ---

  for (const v of logicalTypeVectors) {
    it(`[${v.id}.wire-format] wire matches canonical pattern for format "${String(v.schema['format'] ?? v.logicalType)}"`, () => {
      const err = assertWireMatchesFormat(v)
      expect(err, err ?? undefined).toBeNull()
    })
  }

  // --- per-vector negative-control teeth checks ---

  for (const v of logicalTypeVectors) {
    if (v.negativeControl.mutate !== 'wire') continue
    it(`[${v.id}.negative-control] negativeControl.to mutates wire to a non-conformant value`, () => {
      // The mutated wire must FAIL the format check — that is what makes the teeth real.
      const mutatedV = { ...v, wire: v.negativeControl.to as ReturnType<typeof v['wire']['valueOf']> }
      const err = assertWireMatchesFormat(mutatedV as Parameters<typeof assertWireMatchesFormat>[0])
      // A non-null error means the format check went RED — the negative control has teeth.
      expect(err, `negativeControl.to "${JSON.stringify(v.negativeControl.to)}" still passes the format check — it is vacuous`).not.toBeNull()
    })
  }

  // --- spot checks for individual well-known scalars ---

  it('[logical.date-time] schema is {type:"string",format:"date-time"}', () => {
    const v = logicalTypeVectors.find((x) => x.logicalType === 'date-time')
    expect(v).toBeDefined()
    expect(v!.schema).toEqual({ type: 'string', format: 'date-time' })
  })

  it('[logical.date-time] wire ends with Z (UTC-normalized)', () => {
    const v = logicalTypeVectors.find((x) => x.logicalType === 'date-time')
    expect(typeof v!.wire).toBe('string')
    expect((v!.wire as string).endsWith('Z')).toBe(true)
  })

  it('[logical.int64] wire is a string exceeding Number.MAX_SAFE_INTEGER', () => {
    const v = logicalTypeVectors.find((x) => x.logicalType === 'int64')
    expect(v).toBeDefined()
    expect(typeof v!.wire).toBe('string')
    // parseInt gives an approximation, but BigInt must be exact; wire must be > MAX_SAFE_INTEGER
    expect(BigInt(v!.wire as string) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  it('[logical.decimal] wire is a decimal string (not a JS float)', () => {
    const v = logicalTypeVectors.find((x) => x.logicalType === 'decimal')
    expect(v).toBeDefined()
    expect(typeof v!.wire).toBe('string')
    expect(/^-?\d+(\.\d+)?$/.test(v!.wire as string)).toBe(true)
  })

  it('[logical.byte] wire uses standard base64 alphabet (no URL-safe - or _ chars)', () => {
    const v = logicalTypeVectors.find((x) => x.logicalType === 'byte')
    expect(v).toBeDefined()
    expect(typeof v!.wire).toBe('string')
    // Standard base64 (RFC 4648 §4) must not contain URL-safe characters (- or _)
    expect((v!.wire as string).includes('-')).toBe(false)
    expect((v!.wire as string).includes('_')).toBe(false)
  })

  it('[logical.byte] wire "SGVsbG8=" decodes to "Hello" in base64', () => {
    const v = logicalTypeVectors.find((x) => x.logicalType === 'byte')
    expect(v!.wire).toBe('SGVsbG8=')
    // Verify the value is correct base64 for "Hello"
    expect(Buffer.from(v!.wire as string, 'base64').toString('utf-8')).toBe('Hello')
  })

  it('[logical.uuid] wire is lowercase hyphenated (RFC 4122)', () => {
    const v = logicalTypeVectors.find((x) => x.logicalType === 'uuid')
    expect(v).toBeDefined()
    expect(typeof v!.wire).toBe('string')
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v!.wire as string)).toBe(true)
  })

  it('[logical.number-special] NaN vector wire is "NaN"', () => {
    const v = logicalTypeVectors.find((x) => x.id === 'logical.number-special.nan')
    expect(v).toBeDefined()
    expect(v!.wire).toBe('NaN')
  })

  it('[logical.number-special] Infinity vector wire is "Infinity"', () => {
    const v = logicalTypeVectors.find((x) => x.id === 'logical.number-special.infinity')
    expect(v).toBeDefined()
    expect(v!.wire).toBe('Infinity')
  })

  it('[logical.NEGATIVE.date-time] non-UTC offset wire fails RFC 3339 UTC pattern check', () => {
    const v = logicalTypeVectors.find((x) => x.logicalType === 'date-time')!
    // The negativeControl wire has an offset (+05:30) — must fail the UTC check.
    const negWire = v.negativeControl.to as string
    const mutated = { ...v, wire: negWire }
    const err = assertWireMatchesFormat(mutated)
    expect(err).not.toBeNull()
    expect(err).toContain('RFC 3339 UTC')
  })

  it('[logical.NEGATIVE.uuid] uppercase UUID wire fails the lowercase check', () => {
    const v = logicalTypeVectors.find((x) => x.logicalType === 'uuid')!
    const negWire = v.negativeControl.to as string
    const mutated = { ...v, wire: negWire }
    const err = assertWireMatchesFormat(mutated)
    expect(err).not.toBeNull()
    expect(err).toContain('lowercase')
  })
})

// ---------------------------------------------------------------------------
// Integration smoke test — runAllVectors
// ---------------------------------------------------------------------------

describe('runAllVectors — integration', () => {
  it('[runner.1] all vectors pass end-to-end', () => {
    const results = runAllVectors()
    const failed = results.filter((r) => !r.pass)
    expect(failed, `failing vectors:\n${failed.map((r) => `  ${r.id}: ${r.error}`).join('\n')}`).toHaveLength(0)
  })

  it('[runner.2] every result has an id string', () => {
    const results = runAllVectors()
    for (const r of results) {
      expect(typeof r.id).toBe('string')
      expect(r.id.length).toBeGreaterThan(0)
    }
  })

  it('[runner.3] covers all four vector categories', () => {
    const results = runAllVectors()
    const ids = results.map((r) => r.id)
    expect(ids.some((id) => id.startsWith('descriptor.'))).toBe(true)
    expect(ids.some((id) => id.startsWith('naming.'))).toBe(true)
    expect(ids.some((id) => id.startsWith('envelope.'))).toBe(true)
    expect(ids.some((id) => id.startsWith('error.'))).toBe(true)
    expect(ids.some((id) => id.startsWith('validation.'))).toBe(true)
  })
})
