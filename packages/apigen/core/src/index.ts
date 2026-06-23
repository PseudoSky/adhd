export type {
  GeneratedSchemas,
  ComposedSchemas,
  ExportMode,
  GenerateSchemasOptions,
  PluginInput,
  PluginOutput,
  RunInput,
  OutputPlugin,
} from './lib/types'

export type {
  Operation,
  OperationKind,
  Segment,
  TypeText,
  JSONSchema,
  ApigenSchemaHints,
} from './lib/descriptor'

export type {
  // v2 Plugin interface (SPEC §7)
  Plugin,
  // capability interfaces
  TargetCapability,
  LayerCapability,
  MountCapability,
  MountedOperation,
  EnvelopeCapability,
  // layer call / result / streaming types
  Call,
  Next,
  Result,
  Chunk,
  // transport / harness / server types
  Transport,
  Extensions,
  Descriptor,
  Harness,
  Server,
  // emitted file
  File,
} from './lib/plugin'

export type { Logger } from 'pino'

export { generateSchemas } from './lib/generate-schemas'
export { composeSchemas } from './lib/compose-schemas'
export { extract, tokenize } from './lib/extract'
export type { ExtractOptions } from './lib/extract'
export { extractClasses } from './lib/extract-classes'
export type { ExtractClassesOptions } from './lib/extract-classes'
