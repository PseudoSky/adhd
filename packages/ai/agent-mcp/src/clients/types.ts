import type { ToolDefinition } from "../providers/types.js";

export interface IMcpClient {
    /** Returns all tools advertised by this MCP server */
    listTools(): Promise<ToolDefinition[]>;

    /**
     * Call a single tool on this server.
     * @param toolName  the tool name (without server prefix)
     * @param args      the arguments to pass
     * @param signal    optional abort signal — when the task is cancelled (or
     *                  times out) this fires, so an in-flight tool call is
     *                  interrupted instead of running to completion. Composed
     *                  with any client-level timeout.
     */
    callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<unknown>;

    /** Tear down the client (kill child processes, close connections) */
    close(): Promise<void>;
}
