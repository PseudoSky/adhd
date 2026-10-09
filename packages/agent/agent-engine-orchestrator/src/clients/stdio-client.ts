import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";

import type { ToolDefinition } from "../providers/types.js";
import type { McpStdioConfig } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import type { IMcpClient } from "./types.js";
import type { EngineLogger, EngineConfig } from "../interfaces.js";
import { wrapMcpTransport } from "../providers/wire.js";

/**
 * Default budget for the stdio spawn + `initialize` handshake and for the first
 * `tools/list` (each phase). Replaces the MCP SDK's unconfigured 60s default
 * (c9f0a791): a pinned direct-node server initializes in well under a second,
 * so 30s is generous headroom for a loaded machine yet fails ~4x sooner than
 * the old connect-then-reconnect path (60s + 60s).
 */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000;

export type McpStartupPhase = "connect" | "list";

/**
 * A stdio MCP server did not become usable within its startup budget (or died
 * while starting). The message names the server, the phase, the elapsed ms, the
 * budget and the command, so a `-32001` is never anonymous again.
 */
export class McpStartupError extends ToolError {
    constructor(
        readonly server: string,
        readonly phase: McpStartupPhase,
        readonly elapsedMs: number,
        readonly timeoutMs: number,
        readonly commandLine: string,
        readonly timedOut: boolean,
        cause: unknown
    ) {
        super(
            "MCP_CLIENT_ERROR",
            `MCP server '${server}' ${timedOut ? "timed out" : "failed"} during ${phase} ` +
                `after ${Math.round(elapsedMs)}ms (connectTimeoutMs=${timeoutMs}, command: ${commandLine}): ` +
                `${cause instanceof Error ? cause.message : String(cause)}`,
            { server, phase, elapsedMs, timeoutMs, command: commandLine, timedOut }
        );
        this.name = "McpStartupError";
        (this as { cause?: unknown }).cause = cause;
    }
}

/** MCP JSON-RPC `RequestTimeout` code, raised by the SDK when a request budget elapses. */
const MCP_REQUEST_TIMEOUT_CODE = -32001;

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

    private connectTimeoutMs(): number {
        return this.serverConfig.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    }

    private startupError(
        phase: McpStartupPhase,
        startedAt: number,
        timeoutMs: number,
        cause: unknown
    ): McpStartupError {
        const elapsedMs = performance.now() - startedAt;
        const code = (cause as { code?: unknown } | null)?.code;
        const timedOut = code === MCP_REQUEST_TIMEOUT_CODE;
        const commandLine = [this.serverConfig.command, ...(this.serverConfig.args ?? [])].join(" ");
        return new McpStartupError(this.serverName, phase, elapsedMs, timeoutMs, commandLine, timedOut, cause);
    }

    async connect(): Promise<void> {
        const transport = new StdioClientTransport({
            command: this.serverConfig.command,
            args: this.serverConfig.args ?? [],
            // ADR-0008 D9 / NAT-TOOL-3: scope the spawned child to its configured
            // working directory. Absent -> `undefined`, and the SDK passes that
            // straight to spawn, so the child inherits the parent process cwd
            // (unchanged behavior, AC4). `subprocessEnv()` supplies the child's
            // curated env on top of the SDK's default safe-inherit set.
            cwd: this.serverConfig.cwd,
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
        const timeoutMs = this.connectTimeoutMs();
        const startedAt = performance.now();
        try {
            // `transport` stays the inner StdioClientTransport (its `.process` is read below); only the
            // wrapped view is handed to the client so JSON-RPC traffic is logged.
            await client.connect(
                wrapMcpTransport(this.config, transport, { server: this.serverName, transport: "stdio" }),
                { timeout: timeoutMs }
            );
        } catch (error) {
            // Reap the half-started child so a timed-out spawn never lingers.
            await this.close();
            throw this.startupError("connect", startedAt, timeoutMs, error);
        }

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

        const timeoutMs = this.connectTimeoutMs();
        const startedAt = performance.now();
        let response: Awaited<ReturnType<Client["listTools"]>>;
        try {
            response = await this.client.listTools(undefined, { timeout: timeoutMs });
        } catch (error) {
            throw this.startupError("list", startedAt, timeoutMs, error);
        }
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
