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

  // Uniqueness / collision check
  checkCollisions,
  CollisionDetectedError,

  // §9.1 Envelope-binding helpers
  envelopeKey,
  envelopeCliFlag,
  envelopeEnvVar,
  envelopeMetaKey,
} from './lib/naming'

export type {
  TransportProjection,
  HttpVerb,
  ProjectionConfig,
  CollisionError,
} from './lib/naming'
