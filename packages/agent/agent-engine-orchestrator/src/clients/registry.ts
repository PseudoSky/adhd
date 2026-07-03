import type { ToolDefinition } from "../providers/types.js";
import type { ExecutionContext, McpServerConfig } from "../validation/index.js";
import type { InProcessToolDescriptor, InProcessToolHandler } from "./in-process.js";
import { InProcessMcpClient } from "./in-process.js";
import { HttpMcpClient, SseMcpClient } from "./http-client.js";
import { StdioMcpClient } from "./stdio-client.js";
import type { IMcpClient } from "./types.js";
import { TOOL_NAME_SEPARATOR, normalizeToolName } from "./tool-naming.js";
import type { EngineLogger } from "../interfaces.js";

export class McpClientRegistry {
    private readonly clients = new Map<string, IMcpClient>();
    private readonly connectPromises = new Map<string, Promise<void>>();
    private readonly toolTargets = new Map<string, { server: string; tool: string }>();
    private readonly logger: EngineLogger;

    constructor(
        private readonly mcpServers: Record<string, McpServerConfig>,
        private readonly selfUrl: string | undefined,
        private readonly inProcessDescriptors: InProcessToolDescriptor[],
        private readonly inProcessHandler: InProcessToolHandler,
        private readonly context: ExecutionContext,
        logger?: EngineLogger
    ) {
        this.logger = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
    }

    private isSelfReferential(name: string, config: McpServerConfig): boolean {
        if (name === "agent-mcp") return true;

        if (
            this.selfUrl &&
            (config.transport === "http" || config.transport === "sse") &&
            config.url === this.selfUrl
        ) {
            return true;
        }

        return false;
    }

    private resolveServerName(name: string): string {
        if (this.mcpServers[name]) return name;
        const norm = normalizeToolName(name);
        return Object.keys(this.mcpServers).find((k) => normalizeToolName(k) === norm) ?? name;
    }

    private async getOrCreateClient(rawName: string): Promise<IMcpClient> {
        const name = this.resolveServerName(rawName);
        const existing = this.clients.get(name);
        if (existing) return existing;

        const config = this.mcpServers[name];
        if (!config) {
            throw new Error(`No MCP server config found for server: '${rawName}'`);
        }

        if (this.isSelfReferential(name, config)) {
            const client = new InProcessMcpClient(
                this.inProcessDescriptors,
                this.inProcessHandler,
                this.context
            );
            this.clients.set(name, client);
            return client;
        }

        let connectPromise = this.connectPromises.get(name);
        if (connectPromise) {
            await connectPromise;
            return this.clients.get(name)!;
        }

        let client: StdioMcpClient | HttpMcpClient | SseMcpClient;

        if (config.transport === "stdio") {
            client = new StdioMcpClient(name, config);
        } else if (config.transport === "http") {
            client = new HttpMcpClient(name, config);
        } else if (config.transport === "sse") {
            client = new SseMcpClient(name, config);
        } else {
            const exhaustive: never = config;
            throw new Error(`Unknown MCP transport: ${(exhaustive as { transport: string }).transport}`);
        }

        connectPromise = client.connect().then(() => {
            this.clients.set(name, client);
            this.logger.debug({ server: name }, "MCP client connected");
        });

        this.connectPromises.set(name, connectPromise);
        await connectPromise;
        return this.clients.get(name)!;
    }

    async getClient(name: string): Promise<IMcpClient> {
        return this.getOrCreateClient(name);
    }

    private isToolHidden(serverName: string, toolName: string): boolean {
        const config = this.mcpServers[serverName];
        if (!config) return false;
        if (config.allowedTools && !config.allowedTools.includes(toolName)) return true;
        if (config.disallowedTools?.includes(toolName)) return true;
        return false;
    }

    assertToolAllowed(serverName: string, toolName: string): void {
        if (this.isToolHidden(serverName, toolName)) {
            const quoted = `${serverName}__${toolName}`;
            throw new Error(`Tool "${quoted}" is disallowed by server config and cannot be called`);
        }
    }

    async listAllTools(): Promise<ToolDefinition[]> {
        const allTools: ToolDefinition[] = [];

        for (const serverName of Object.keys(this.mcpServers)) {
            try {
                const client = await this.getOrCreateClient(serverName);
                const tools = await client.listTools();

                for (const tool of tools) {
                    if (this.isToolHidden(serverName, tool.name)) {
                        continue;
                    }
                    const advertised = `${serverName}${TOOL_NAME_SEPARATOR}${tool.name}`;
                    const target = { server: serverName, tool: tool.name };
                    this.toolTargets.set(advertised, target);
                    this.toolTargets.set(normalizeToolName(advertised), target);
                    allTools.push({ ...tool, name: advertised });
                }
            } catch (error) {
                this.logger.warn(
                    { server: serverName, error },
                    "Failed to list tools from MCP server"
                );
            }
        }

        return allTools;
    }

    resolveToolName(advertised: string): { server: string; tool: string } {
        const hit =
            this.toolTargets.get(advertised) ??
            this.toolTargets.get(normalizeToolName(advertised));
        if (hit) return hit;
        const i = advertised.indexOf(TOOL_NAME_SEPARATOR);
        return i === -1
            ? { server: advertised, tool: advertised }
            : {
                  server: advertised.slice(0, i),
                  tool: advertised.slice(i + TOOL_NAME_SEPARATOR.length),
              };
    }

    async closeAll(): Promise<void> {
        const closePromises = Array.from(this.clients.entries()).map(
            async ([name, client]) => {
                try {
                    await client.close();
                    this.logger.debug({ server: name }, "MCP client closed");
                } catch (error) {
                    this.logger.warn({ server: name, error }, "Error closing MCP client");
                }
            }
        );

        await Promise.allSettled(closePromises);
        this.clients.clear();
        this.connectPromises.clear();
    }
}
