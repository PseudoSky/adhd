import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ToolDefinition } from "../providers/types.js";
import type { McpHttpConfig, McpSseConfig } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import type { IMcpClient } from "./types.js";

abstract class BaseHttpMcpClient implements IMcpClient {
    protected client: Client | null = null;

    constructor(protected readonly serverName: string) {}

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

    async callTool(toolName: string, args: unknown): Promise<unknown> {
        if (!this.client) {
            throw new ToolError("MCP_CLIENT_ERROR", `Client '${this.serverName}' not connected`);
        }

        const result = await this.client.callTool({
            name: toolName,
            arguments: args as Record<string, unknown>,
        });

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
        this.client = null;
    }
}

export class HttpMcpClient extends BaseHttpMcpClient {
    constructor(
        serverName: string,
        private readonly config: McpHttpConfig
    ) {
        super(serverName);
    }

    async connect(): Promise<void> {
        const url = new URL(this.config.url);
        const transport = new StreamableHTTPClientTransport(url, {
            requestInit: {
                headers: this.config.headers as HeadersInit | undefined,
                signal: this.config.timeoutMs
                    ? AbortSignal.timeout(this.config.timeoutMs)
                    : undefined,
            },
        });

        const client = new Client(
            { name: "agent-mcp-client", version: "1.0.0" },
            { capabilities: {} }
        );

        this.client = client;
        await client.connect(transport);
    }
}

export class SseMcpClient extends BaseHttpMcpClient {
    constructor(
        serverName: string,
        private readonly config: McpSseConfig
    ) {
        super(serverName);
    }

    async connect(): Promise<void> {
        const url = new URL(this.config.url);
        const transport = new SSEClientTransport(url, {
            eventSourceInit: {
                fetch: (input, init) =>
                    fetch(input, {
                        ...init,
                        headers: {
                            ...(init?.headers as Record<string, string>),
                            ...(this.config.headers as Record<string, string>),
                        } as HeadersInit,
                        signal: this.config.timeoutMs
                            ? AbortSignal.timeout(this.config.timeoutMs)
                            : undefined,
                    }),
            },
        });

        const client = new Client(
            { name: "agent-mcp-client", version: "1.0.0" },
            { capabilities: {} }
        );

        this.client = client;
        await client.connect(transport);
    }
}
