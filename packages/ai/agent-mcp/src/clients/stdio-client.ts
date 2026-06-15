import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ChildProcess } from "node:child_process";

import { logger } from "../logger.js";
import type { ToolDefinition } from "../providers/types.js";
import type { McpStdioConfig } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import type { IMcpClient } from "./types.js";

export class StdioMcpClient implements IMcpClient {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private childProcess: ChildProcess | null = null;

    constructor(
        private readonly serverName: string,
        private readonly config: McpStdioConfig
    ) {}

    async connect(): Promise<void> {
        const transport = new StdioClientTransport({
            command: this.config.command,
            args: this.config.args ?? [],
            env: {
                ...process.env,
                ...this.config.env,
            } as Record<string, string>,
        });

        this.transport = transport;

        // Capture child process reference for lifecycle management.
        // The StdioClientTransport exposes it after start().
        const client = new Client(
            { name: "agent-mcp-client", version: "1.0.0" },
            { capabilities: {} }
        );

        this.client = client;
        await client.connect(transport);

        // Attach exit handler to the underlying child process.
        // StdioClientTransport exposes `process` after connect().
        const childProc = (transport as unknown as { process?: ChildProcess }).process;
        if (childProc) {
            this.childProcess = childProc;
            childProc.on("exit", (code, signal) => {
                logger.warn(
                    {
                        server: this.serverName,
                        exitCode: code,
                        signal,
                    },
                    "MCP child process exited unexpectedly"
                );
            });
        }
    }

    async listTools(): Promise<ToolDefinition[]> {
        if (!this.client) {
            throw new ToolError("MCP_CLIENT_ERROR", `Client '${this.serverName}' not connected`);
        }

        const response = await this.client.listTools();
        return response.tools.map(tool => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
                type: "object",
                properties: {},
            },
        }));
    }

    async callTool(toolName: string, args: unknown, callerSignal?: AbortSignal): Promise<unknown> {
        if (!this.client) {
            throw new ToolError("MCP_CLIENT_ERROR", `Client '${this.serverName}' not connected`);
        }

        // Compose the caller's cancellation/timeout signal (DEBT-003 — lets a
        // task cancel interrupt this in-flight call) with the client-level
        // per-call timeout. Either may fire first.
        const timeoutSignal = this.config.timeoutMs
            ? AbortSignal.timeout(this.config.timeoutMs)
            : undefined;
        const signal =
            callerSignal && timeoutSignal
                ? AbortSignal.any([callerSignal, timeoutSignal])
                : (callerSignal ?? timeoutSignal);

        const result = await this.client.callTool(
            { name: toolName, arguments: args as Record<string, unknown> },
            undefined,
            signal ? { signal } : undefined
        );

        if (result.isError) {
            throw new ToolError(
                "MCP_CLIENT_ERROR",
                `Tool '${toolName}' on server '${this.serverName}' returned an error: ${JSON.stringify(result.content)}`
            );
        }

        return result.content;
    }

    async close(): Promise<void> {
        try {
            await this.client?.close();
        } catch {
            // ignore close errors
        }

        if (this.childProcess && !this.childProcess.killed) {
            this.childProcess.kill("SIGTERM");

            // Force-kill after 5 seconds if still alive
            const killTimer = setTimeout(() => {
                if (this.childProcess && !this.childProcess.killed) {
                    this.childProcess.kill("SIGKILL");
                }
            }, 5_000);

            killTimer.unref();
        }
    }
}
