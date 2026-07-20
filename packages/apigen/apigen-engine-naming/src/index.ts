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

export type {
  TransportProjection,
  HttpVerb,
  ProjectionConfig,
  CollisionError,
} from './lib/naming';
