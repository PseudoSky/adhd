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
} from './lib/naming';

// Shared codegen emit primitives (BUG-APIGEN-032 family): the single,
// context-correct escape/identifier/path surface every generator splices
// through. `sanitizeIdentifier` is re-exported from `./lib/emit` too, but is
// already exported above from its single definition in `./lib/naming`.
export { escapeStringLiteral, toPosixPath } from './lib/emit';

export type {
  TransportProjection,
  HttpVerb,
  ProjectionConfig,
  CollisionError,
} from './lib/naming';
