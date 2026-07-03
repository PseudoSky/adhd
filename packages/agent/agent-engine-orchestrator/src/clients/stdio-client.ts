import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ChildProcess } from "node:child_process";

import type { ToolDefinition } from "../providers/types.js";
import type { McpStdioConfig } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import type { IMcpClient } from "./types.js";
import type { EngineLogger, EngineConfig } from "../interfaces.js";

export class StdioMcpClient implements IMcpClient {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private childProcess: ChildProcess | null = null;
    private readonly logger: EngineLogger;
    private readonly config: EngineConfig;

    constructor(
        private readonly serverName: string,
        private readonly serverConfig: McpStdioConfig,
        config?: EngineConfig,
        logger?: EngineLogger
    ) {
        this.config = config ?? { subprocessEnv: () => ({}) } as EngineConfig;
        this.logger = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
    }

    async connect(): Promise<void> {
        const transport = new StdioClientTransport({
            command: this.serverConfig.command,
            args: this.serverConfig.args ?? [],
            env: {
                ...this.config.subprocessEnv(),
                ...this.serverConfig.env,
            } as Record<string, string>,
        });

        this.transport = transport;

        const client = new Client(
            { name: "agent-mcp-client", version: "1.0.0" },
            { capabilities: {} }
        );

        this.client = client;
        await client.connect(transport);

        const childProc = (transport as unknown as { process?: ChildProcess }).process;
        if (childProc) {
            this.childProcess = childProc;
            childProc.on("exit", (code, signal) => {
                this.logger.warn(
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

        const timeoutSignal = this.serverConfig.timeoutMs
            ? AbortSignal.timeout(this.serverConfig.timeoutMs)
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

            const killTimer = setTimeout(() => {
                if (this.childProcess && !this.childProcess.killed) {
                    this.childProcess.kill("SIGKILL");
                }
            }, 5_000);

            killTimer.unref();
        }
    }
}
