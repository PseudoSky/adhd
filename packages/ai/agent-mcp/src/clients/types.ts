import type { ToolDefinition } from "../providers/types.js";

export interface IMcpClient {
    /** Returns all tools advertised by this MCP server */
    listTools(): Promise<ToolDefinition[]>;

    /**
     * Call a single tool on this server.
     * @param toolName  the tool name (without server prefix)
     * @param args      the arguments to pass
     */
    callTool(toolName: string, args: unknown): Promise<unknown>;

    /** Tear down the client (kill child processes, close connections) */
    close(): Promise<void>;
}
