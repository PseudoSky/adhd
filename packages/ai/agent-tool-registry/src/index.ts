// Public barrel — every store and schema table added by subsequent plan states
// should be re-exported here.

export { db, sqlite } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export { toolTypesTable, toolsTable } from "./db/schema.js";
export {
    ToolStore,
    ToolStoreError,
} from "./store/tool-store.js";
export type {
    Tool,
    ToolCreateInput,
    ToolType,
    ToolStoreErrorCode,
} from "./store/tool-store.js";
