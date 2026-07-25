// @adhd/agent-provider — barrel export
// Each subsequent plan state adds exports here as new modules are created.

export { runMigrationsOn, MIGRATIONS_FOLDER } from './db/migrate-runner.js';
export * from './db/schema.js';

export { ProviderStore, ProviderStoreError } from './store/provider-store.js';
export type {
  Provider,
  ProviderCreateInput,
  ProviderErrorCode,
} from './store/provider-store.js';

export { ModelStore, ModelStoreError } from './store/model-store.js';
export type {
  Model,
  ModelCreateInput,
  ModelErrorCode,
  ModelPlatformBinding,
  ModelPlatformBindingCreateInput,
} from './store/model-store.js';

export {
  ToolFormatStore,
  ToolFormatStoreError,
} from './store/tool-format-store.js';
export type {
  ToolFormat,
  ToolFormatCreateInput,
  ToolFormatErrorCode,
  EmitShape,
} from './store/tool-format-store.js';

export { ProviderAdapterImpl } from './adapter/provider-adapter.js';

export {
  emitTool,
  emitToolsForProvider,
  UnsupportedNativeToolError,
} from './runtime/emit-tools.js';
export type {
  EmittedCustomTool,
  EmittedServerSideTool,
  EmittedTool,
  ToolFormatLookup,
  UnsupportedNativeToolErrorCode,
} from './runtime/emit-tools.js';

export { seed, seedProviders, seedModels, seedBindings } from './seed/index.js';
export { SEEDED_PROVIDER_IDS } from './seed/index.js';
export { MODEL_ROWS, SEEDED_MODEL_IDS } from './seed/index.js';
export { BINDING_ROWS } from './seed/index.js';

export { RATE_CARD, estimateCostUsd } from './pricing/rate-card.js';
export type { ModelRate } from './pricing/rate-card.js';
