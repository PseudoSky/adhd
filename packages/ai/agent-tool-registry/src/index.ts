// Public barrel — every store and schema table added by subsequent plan states
// should be re-exported here.

export { seed } from "./seed/index.js";

export { db, sqlite } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export { agentToolsTable, mcpServersTable, platformsTable, toolPlatformBindingsTable, toolTypesTable, toolsTable } from "./db/schema.js";
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
export {
    BindingStore,
    BindingStoreError,
} from "./store/binding-store.js";
export type {
    BindingCreateInput,
    BindingStoreErrorCode,
    Platform,
    PlatformSeedInput,
    ToolPlatformBinding,
} from "./store/binding-store.js";
export {
    McpServerStore,
    McpServerStoreError,
} from "./store/mcp-server-store.js";
export type {
    McpServer,
    McpServerCreateInput,
    McpServerStoreErrorCode,
} from "./store/mcp-server-store.js";
export {
    AgentToolStore,
    AgentToolStoreError,
} from "./store/agent-tool-store.js";
export type {
    AgentToolGrant,
    AgentToolGrantInput,
    AgentToolStoreErrorCode,
    PermissionLevel,
} from "./store/agent-tool-store.js";
