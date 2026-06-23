// @adhd/agent-provider — barrel export
// Each subsequent plan state adds exports here as new modules are created.

export { db, sqlite } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export * from "./db/schema.js";

export { ProviderStore, ProviderStoreError } from "./store/provider-store.js";
export type { Provider, ProviderCreateInput, ProviderErrorCode } from "./store/provider-store.js";

export { ModelStore, ModelStoreError } from "./store/model-store.js";
export type {
    Model,
    ModelCreateInput,
    ModelErrorCode,
    ModelPlatformBinding,
    ModelPlatformBindingCreateInput,
} from "./store/model-store.js";

export { ToolFormatStore, ToolFormatStoreError } from "./store/tool-format-store.js";
export type {
    ToolFormat,
    ToolFormatCreateInput,
    ToolFormatErrorCode,
    EmitShape,
} from "./store/tool-format-store.js";
