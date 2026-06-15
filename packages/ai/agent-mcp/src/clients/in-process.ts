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

/**
 * InProcessMcpClient routes tool calls directly to runtime handler
 * functions without any network round-trip.
 *
 * This is the client used when an agent definition includes an
 * "agent-mcp" server entry — it allows recursive delegation while
 * preserving the ExecutionContext thread.
 */
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
        // If the task was already cancelled/timed out, don't start the in-process
        // call (which would spin up a recursive sub-task). Mid-flight cancellation
        // of an in-process sub-task is handled by that sub-task's own cancellation
        // signal via the task registry, not by this signal. (DEBT-003)
        signal?.throwIfAborted();
        return this.handler(toolName, args, this.context);
    }

    async close(): Promise<void> {
        // no-op — in-process, nothing to tear down
    }
}
