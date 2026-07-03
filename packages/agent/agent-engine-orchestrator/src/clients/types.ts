import type { ToolDefinition } from "../providers/types.js";

export interface IMcpClient {
    listTools(): Promise<ToolDefinition[]>;
    callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
    close(): Promise<void>;
}
