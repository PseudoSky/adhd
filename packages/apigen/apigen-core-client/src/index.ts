export type {
  GeneratedSchemas,
  ComposedSchemas,
  ExportMode,
  PluginInput,
  PluginOutput,
  RunInput,
  OutputPlugin,
  PluginLanguage,
} from './lib/types';

export type {
  Operation,
  OperationKind,
  Segment,
  TypeText,
  JSONSchema,
  ApigenSchemaHints,
} from './lib/descriptor';

export type {
  // v2 Plugin interface (SPEC §7)
  Plugin,
  // capability interfaces
  TargetCapability,
  LayerCapability,
  ExtractLayerCapability,
  MountCapability,
  MountedOperation,
  // hostBridge (batch-rollout, BATCH_0.0.1.md §2/§F1)
  MountHostBridge,
  MountHostBridgeInvokeOptions,
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
  // shared synthetic-op builder (F2)
  SyntheticOpFields,
} from './lib/plugin';
export { syntheticOp } from './lib/plugin';

export type { Logger } from 'pino';

export {
  createExtractionSession,
  clearPersistentProjectCache,
  collectLocalImportPaths,
} from './lib/extraction-session';
export type {
  ExtractionSession,
  ISessionStats,
} from './lib/extraction-session';
export {
  composeSchemas,
  pluginsToEnvelopeMiddlewares,
} from './lib/compose-schemas';
export { isPrimitiveOnlyInputSchema } from './lib/get-safety';
export { extract, tokenize } from './lib/extract';
export type { ExtractOptions } from './lib/extract';
export {
  composeOnion,
  createExtractInvoker,
  createExtractInvokerFromPlugins,
} from './lib/extract-invoker';
export type {
  ExtractCall,
  ExtractResult,
  ExtractMiddleware,
} from './lib/extract-invoker';
export { extractClasses } from './lib/extract-classes';
export type { ExtractClassesOptions } from './lib/extract-classes';
export {
  languageOfSource,
  pluginConsumesSource,
  sourcesForPlugin,
  effectiveLanguage,
} from './lib/source-language';
export type { LanguageAwarePlugin } from './lib/source-language';

// F1 (BATCH_0.0.1.md) — host-agnostic batch/bulk fan-out schema derivation.
export {
  deriveBatchOperationBranch,
  groupBatchableOperationsByKind,
  buildBatchKindSchema,
  buildBatchMountedOperations,
} from './lib/batch';
export type {
  BatchMountOptions,
  BatchOperationBranch,
  BatchKindSchema,
  BatchKindOperation,
} from './lib/batch';
