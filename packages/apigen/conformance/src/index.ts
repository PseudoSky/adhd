// @adhd/apigen-conformance — cross-language conformance suite (SPEC §12/§14)
//
// Every host runtime (TS now, Python/Rust/Go later) MUST pass every vector
// exported from this package. The runner (`runAllVectors`) is the TS-native
// entry point; non-TS hosts consume the vector data arrays directly.

export {
  // Fixture builders (re-usable in host-specific test suites)
  seg,
  makeOp,

  // A. Descriptor round-trip
  ROUND_TRIP_OP,
  DESCRIPTOR_VECTORS,
  roundTripOperation,
  assertOperationEqual,

  // B. Naming / collision
  OP_UNSAFE_ACTION,
  OP_SAFE_QUERY,
  OP_COLLISION_A,
  OP_COLLISION_B,
  OP_DISTINCT_A,
  OP_DISTINCT_B,
  NAMING_VECTORS,
  assertUnsafeIsPost,
  assertSafeIsGet,
  assertCollisionDetected,
  assertNoCollision,

  // C. Envelope binding
  ENVELOPE_CASES,
  ENVELOPE_VECTORS,
  assertEnvelopeBinding,

  // D. Error mapping
  ERROR_MAPPING_VECTORS,
  assertErrorMapping,
  assertApiErrorCodeSurvivesSerialize,

  // E. Validation necessary-not-sufficient
  VALIDATION_VECTORS,
  minimalSchemaValidate,

  // Runner
  runAllVectors,
} from './lib/vectors'

export type { ValidationCase, VectorResult } from './lib/vectors'
