/**
 * Re-exports HookRegistry from @adhd/agent-mcp-types so the server can
 * import it via the local path "./engine/hooks.js" without the implementation
 * living in this package. This keeps @adhd/agent-mcp-budget's test suite able
 * to instantiate HookRegistry from @adhd/agent-mcp-types without creating a
 * circular Nx dependency with @adhd/agent-mcp.
 */
export { HookRegistry } from "@adhd/agent-mcp-types";
