import { performance } from "node:perf_hooks";

import type { ToolDefinition } from "../providers/types.js";
import type { ExecutionContext, McpServerConfig } from "../validation/index.js";
import type { InProcessToolDescriptor, InProcessToolHandler } from "./in-process.js";
import { InProcessMcpClient } from "./in-process.js";
import { HttpMcpClient, SseMcpClient } from "./http-client.js";
import { StdioMcpClient } from "./stdio-client.js";
import type { IMcpClient } from "./types.js";
import { TOOL_NAME_SEPARATOR, normalizeToolName } from "./tool-naming.js";
import { classifyTool, type ToolConcurrencyClass } from "../engine/tool-class.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { selectionOf } from "../providers/resolve-selection.js";
import { serverSideToolsForProvider } from "../providers/server-side-tools.js";
import { WEB_FETCH_SERVER, WebFetchClient, webFetchAdvertised } from "../tools/web-fetch.js";

/**
 * How many MCP servers `listAllTools` connects at once when the caller does not say (R10 S3).
 * A task configures a handful of servers (fs, shell, agent-mcp, a few user servers); 4 starts them
 * all at once in the common case while keeping a large user config (many cold `npx` spawns that
 * contend on the npm cache and on CPU under the sandbox) from launching dozens of processes in the
 * same instant.
 */
export const DEFAULT_MCP_CONNECT_CONCURRENCY = 4;

/** Hard ceiling for the connect concurrency: a larger request is clamped to this. */
export const MAX_MCP_CONNECT_CONCURRENCY = 8;

/** Resolves a requested connect concurrency: a positive integer, clamped to the ceiling; else the default. */
export function resolveMcpConnectConcurrency(requested: number | undefined): number {
    return typeof requested === "number" && Number.isInteger(requested) && requested >= 1
        ? Math.min(requested, MAX_MCP_CONNECT_CONCURRENCY)
        : DEFAULT_MCP_CONNECT_CONCURRENCY;
}

/** The builtin file-system server key (agent-core-native-tooling `FS_SERVER.key`). */
const FS_SERVER_KEY = "fs";

/** Per-server startup timings of the latest `listAllTools` (R10 S3). */
export interface IRegistryStartupTimings {
    /** Per configured server key: milliseconds to connect AND list tools (failed servers included). */
    connectMs: Record<string, number>;
    /** Milliseconds `listAllTools` took in total: until every server's tools were ready (or had failed). */
    toolsReadyMs: number;
}

export class McpClientRegistry {
    private readonly clients = new Map<string, IMcpClient>();
    private readonly connectPromises = new Map<string, Promise<void>>();
    /**
     * Startup failures `listAllTools` observed, keyed by resolved server name.
     * `listAllTools` deliberately survives a dead server (the other servers' tools
     * are still advertised), but it used to DROP the failure — so the model's first
     * call to that server paid a SECOND full connect budget (60s + 60s = a -32001 at
     * 120s; c9f0a791). The next `getOrCreateClient` for the server rethrows this
     * recorded, named error immediately and clears it, so the budget is spent once
     * and a later call still gets a fresh attempt (a server that recovers is not
     * poisoned forever — see BUG-ORCH-002).
     */
    private readonly startupFailures = new Map<string, unknown>();
    private readonly toolTargets = new Map<string, { server: string; tool: string }>();
    /** Advertised definitions of the latest `listAllTools`, by `server` then `tool` (for {@link toolClass}). */
    private readonly toolDefs = new Map<string, ToolDefinition>();
    private timings: IRegistryStartupTimings = { connectMs: {}, toolsReadyMs: 0 };
    private readonly connectConcurrency: number;
    private readonly logger: EngineLogger;
    /**
     * Engine-native `web_fetch` (R6B-web AC2): present only when the agent's provider cannot take
     * Anthropic's server-side web tools (claudecli, OpenAI-compatible) and `nativeWebTools` is not
     * `false`. A provider that DOES get the server tools never sees this one, so its tool list is
     * unchanged.
     */
    private readonly webFetch?: WebFetchClient;

    constructor(
        private readonly mcpServers: Record<string, McpServerConfig>,
        private readonly selfUrl: string | undefined,
        private readonly inProcessDescriptors: InProcessToolDescriptor[],
        private readonly inProcessHandler: InProcessToolHandler,
        private readonly context: ExecutionContext,
        /**
         * Engine config forwarded into every stdio client this registry builds so
         * `subprocessEnv()` (and, via ADR-0008 D9, the per-server `cwd` handling
         * in `StdioMcpClient`) reaches the spawned child. Optional: a caller that
         * omits it gets the pre-existing behavior (no injected child env).
         */
        private readonly engineConfig?: EngineConfig,
        logger?: EngineLogger,
        options?: {
            /**
             * Servers connected at once by `listAllTools`. Positive integer, clamped to
             * {@link MAX_MCP_CONNECT_CONCURRENCY}; default {@link DEFAULT_MCP_CONNECT_CONCURRENCY}.
             */
            connectConcurrency?: number;
        }
    ) {
        this.connectConcurrency = resolveMcpConnectConcurrency(options?.connectConcurrency);
        this.logger = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
        if (!this.mcpServers[WEB_FETCH_SERVER] && this.needsClientSideWebFetch()) {
            this.webFetch = new WebFetchClient({
                allowedDomains: engineConfig?.webFetch?.allowedDomains,
                fetchImpl: engineConfig?.wire?.fetch,
            });
        }
    }

    private needsClientSideWebFetch(): boolean {
        if (this.context?.agentDefinition?.nativeWebTools === false) return false;
        try {
            return serverSideToolsForProvider(selectionOf(this.context).providerType, true).length === 0;
        } catch {
            return false; // no provider selected: the engine fails closed elsewhere
        }
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
        if (this.webFetch && name === WEB_FETCH_SERVER) return this.webFetch;

        if (this.startupFailures.has(name)) {
            const failure = this.startupFailures.get(name);
            this.startupFailures.delete(name);
            throw failure;
        }

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
            const client = this.clients.get(name);
            if (!client) throw new Error(`MCP client not found after connect: ${name}`);
            return client;
        }

        let client: StdioMcpClient | HttpMcpClient | SseMcpClient;

        if (config.transport === "stdio") {
            client = new StdioMcpClient(name, config, this.engineConfig, this.logger);
        } else if (config.transport === "http") {
            client = new HttpMcpClient(name, config, this.engineConfig);
        } else if (config.transport === "sse") {
            client = new SseMcpClient(name, config, this.engineConfig);
        } else {
            const exhaustive: never = config;
            throw new Error(`Unknown MCP transport: ${(exhaustive as { transport: string }).transport}`);
        }

        // A REJECTED connect promise must not stay cached. `connectPromises` was only
        // ever cleared wholesale in close(), so a single failed connect (server not up
        // yet, transient spawn failure) poisoned the entry forever: every later
        // getOrCreateClient(name) re-awaited the same rejected promise and rethrew the
        // original error, and that server could never reconnect for the process's life.
        // Evict on failure so the next call makes a fresh attempt.
        const attempt = client.connect().then(() => {
            this.clients.set(name, client);
            this.logger.debug({ server: name }, "MCP client connected");
        });

        connectPromise = attempt.catch((err: unknown) => {
            // Only evict OUR entry — a newer attempt may already have replaced it.
            if (this.connectPromises.get(name) === connectPromise) {
                this.connectPromises.delete(name);
            }
            throw err;
        });

        this.connectPromises.set(name, connectPromise);
        await connectPromise;
        // NB: distinct binding — `client` is already declared in this block scope
        // (the `let client: Stdio|Http|Sse` above). Re-fetch from the map rather
        // than returning `client` directly so a concurrent connect that replaced
        // the entry wins, matching the pre-existing `this.clients.get(name)!`.
        const connected = this.clients.get(name);
        if (!connected) throw new Error(`MCP client not found after connect: ${name}`);
        return connected;
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

    /**
     * Connects every configured server and lists its tools.
     *
     * Servers are connected CONCURRENTLY (at most `connectConcurrency` at a time; R10 S3): they used
     * to be connected one after another for every task, so worker start-up paid the sum of every
     * server's spawn time. Concurrency changes only WHEN work happens; the result is assembled in
     * configured server-key order after all outcomes are in, so the tool list, the routing table and
     * the failure warnings are identical to the serial walk whatever order the servers finish in. A
     * server that fails is isolated exactly as before: its error is recorded for the model's first
     * call (see `startupFailures`), a warning is logged, and the other servers' tools are advertised.
     */
    async listAllTools(): Promise<ToolDefinition[]> {
        const startedAt = performance.now();
        const serverNames = Object.keys(this.mcpServers);
        const connectMs: Record<string, number> = {};

        type Outcome = { ok: true; tools: ToolDefinition[] } | { ok: false; error: unknown };
        const connectOne = async (serverName: string): Promise<Outcome> => {
            const serverStartedAt = performance.now();
            try {
                const client = await this.getOrCreateClient(serverName);
                const tools = await client.listTools();
                return { ok: true, tools };
            } catch (error) {
                return { ok: false, error };
            } finally {
                connectMs[serverName] = Math.max(0, Math.round(performance.now() - serverStartedAt));
            }
        };

        const outcomes = new Array<Outcome>(serverNames.length);
        let next = 0;
        const worker = async (): Promise<void> => {
            while (next < serverNames.length) {
                const i = next++;
                outcomes[i] = await connectOne(serverNames[i]);
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(this.connectConcurrency, serverNames.length) }, worker)
        );

        const allTools: ToolDefinition[] = [];
        this.toolDefs.clear();
        serverNames.forEach((serverName, i) => {
            const outcome = outcomes[i];
            if (!outcome.ok) {
                this.startupFailures.set(serverName, outcome.error);
                this.logger.warn(
                    { server: serverName, error: outcome.error },
                    "Failed to list tools from MCP server"
                );
                return;
            }
            for (const tool of outcome.tools) {
                if (this.isToolHidden(serverName, tool.name)) {
                    continue;
                }
                const advertised = `${serverName}${TOOL_NAME_SEPARATOR}${tool.name}`;
                const target = { server: serverName, tool: tool.name };
                this.toolTargets.set(advertised, target);
                this.toolTargets.set(normalizeToolName(advertised), target);
                const definition = { ...tool, name: advertised };
                this.toolDefs.set(advertised, definition);
                allTools.push(definition);
            }
            if (serverName === FS_SERVER_KEY) this.warnIfFsUnannotated(outcome.tools);
        });

        if (this.webFetch) {
            const advertised = webFetchAdvertised();
            const target = { server: WEB_FETCH_SERVER, tool: advertised.name.slice(WEB_FETCH_SERVER.length + TOOL_NAME_SEPARATOR.length) };
            this.toolTargets.set(advertised.name, target);
            this.toolTargets.set(normalizeToolName(advertised.name), target);
            this.toolDefs.set(advertised.name, advertised);
            allTools.push(advertised);
        }

        this.timings = {
            connectMs,
            toolsReadyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        };
        return allTools;
    }

    /**
     * R10 P1-A4: the same-turn ordering of file writes relies on the adopted fs server advertising
     * `readOnlyHint` on EVERY tool. A server version that drops it would silently demote ordering
     * (an unannotated `fs` tool is classified as a barrier, so correctness holds and only parallel
     * reads are lost). Warn, never fail: start-up must not depend on the server's metadata.
     */
    private warnIfFsUnannotated(tools: readonly ToolDefinition[]): void {
        const unannotated = tools
            .filter((t) => typeof t.annotations?.readOnlyHint !== "boolean")
            .map((t) => t.name);
        if (unannotated.length > 0) {
            this.logger.warn(
                { server: FS_SERVER_KEY, tools: unannotated },
                "The fs MCP server did not annotate every tool with readOnlyHint; unannotated fs tools are ordered as barriers (same-turn reads of them no longer run in parallel)"
            );
        }
    }

    /**
     * Per-server connect timings and the total tools-ready time of the latest {@link listAllTools}
     * (R10 S3). Before the first call: no servers, 0 ms. A copy: callers may keep it.
     */
    startupTimings(): IRegistryStartupTimings {
        return { connectMs: { ...this.timings.connectMs }, toolsReadyMs: this.timings.toolsReadyMs };
    }

    /**
     * The concurrency class of one advertised tool (R10 P1), from its server-advertised annotations
     * and the engine's name rules (see `classifyTool`). A tool the latest `listAllTools` did not
     * advertise is classified by name alone.
     */
    toolClass(server: string, tool: string): ToolConcurrencyClass {
        const qualified = `${server}${TOOL_NAME_SEPARATOR}${tool}`;
        return classifyTool(qualified, this.toolDefs.get(qualified));
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
        this.startupFailures.clear();
    }
}
