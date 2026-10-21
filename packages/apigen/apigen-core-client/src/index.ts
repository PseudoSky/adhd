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
  LayerCapabilityShape,
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
  releaseExtractionMemory,
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
/**
 * `extract` derives operations from TS source; `tokenize`, `buildId`,
 * `renderIdSegment` and `canonicalOperationId` are the one canonical operation
 * id rule (ADR-0017 D3): every segment tokenized and its words joined by `-`,
 * segments joined by `/` (`fs/read_file` → `fs/read-file`).
 */
export {
  extract,
  tokenize,
  buildId,
  renderIdSegment,
  canonicalOperationId,
} from './lib/extract';
export type { ExtractOptions } from './lib/extract';
export {
  composeOnion,
  createExtractInvoker,
  createExtractInvokerFromPlugins,
  withSourceFiles,
  sourceFilesOf,
} from './lib/extract-invoker';
export type {
  ExtractCall,
  ExtractResult,
  ExtractMiddleware,
} from './lib/extract-invoker';
export {
  createExtractorRegistry,
  extractSourceEntry,
} from './lib/extraction-entry';
export type {
  Extractor,
  ExtractorRegistry,
  IExtractionResult,
  IExtractSourceEntryInput,
} from './lib/extraction-entry';
export { assertExtractorOptions } from './lib/extract-invoker';
export {
  createTypescriptSubprocessExtractor,
  registerTypescriptSubprocessExtractor,
  runExtractWorker,
  spawnExtractLauncher,
  EXTRACT_RESULT_MARKER,
  TS_SUBPROCESS_HOST,
} from './lib/extract-subprocess';
export type {
  ExtractLauncher,
  IExtractLaunchRequest,
  IExtractLaunchResult,
  ITypescriptSubprocessOptions,
} from './lib/extract-subprocess';
export { extractClasses } from './lib/extract-classes';
export type { ExtractClassesOptions } from './lib/extract-classes';
export {
  languageOfSource,
  pluginConsumesSource,
  sourcesForPlugin,
  effectiveLanguage,
  resolveSourceReference,
} from './lib/source-language';
export type {
  LanguageAwarePlugin,
  AssetKind,
  TranslatorId,
  SourceLocator,
  BindingSpec,
  ISourceResolution,
  SourceResolutionError,
  ISourceProbe,
} from './lib/source-language';

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
