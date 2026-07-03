import type { ToolDefinition } from "../providers/types.js";
import type { ExecutionContext } from "../validation/index.js";
import type { IMcpClient } from "./types.js";

export type InProcessToolHandler = (
    toolName: string,
    args: unknown,
    ctx: ExecutionContext
) => Promise<unknown>;

export type InProcessToolDescriptor = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
};

export class InProcessMcpClient implements IMcpClient {
    constructor(
        private readonly tools: InProcessToolDescriptor[],
        private readonly handler: InProcessToolHandler,
        private readonly context: ExecutionContext
    ) {}

    async listTools(): Promise<ToolDefinition[]> {
        return this.tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        }));
    }

    async callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted();
        return this.handler(toolName, args, this.context);
    }

    async close(): Promise<void> {
        // no-op
    }
}
