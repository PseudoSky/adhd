export {
  // Casing projectors
  toKebab,
  toCamel,
  toPascal,
  toSnake,

  // File-name normalisation
  normalizeFileName,

  // Per-transport projection
  project,

  // Shared HTTP-verb resolver (BUG-APIGEN-025 / FEAT-APIGEN-022)
  httpVerb,

  // Uniqueness / collision check
  checkCollisions,
  CollisionDetectedError,

  // §9.1 Envelope-binding helpers
  envelopeKey,
  envelopeCliFlag,
  envelopeEnvVar,
  envelopeMetaKey,

  // Identifier sanitisation
  sanitizeIdentifier,
  uniqueSanitizedIdentifiers,
} from './lib/naming';

// Shared codegen emit primitives (BUG-APIGEN-032 family): the single,
// context-correct escape/identifier/path surface every generator splices
// through. `sanitizeIdentifier` / `uniqueSanitizedIdentifiers` are re-exported
// from `./lib/emit` too, but are already exported above from their single
// definitions in `./lib/naming`.
export {
  escapeLineTerminators,
  escapeStringLiteral,
  toPosixPath,
  coercePort,
} from './lib/emit';

export type {
  TransportProjection,
  HttpVerb,
  ProjectionConfig,
  CollisionError,
} from './lib/naming';
