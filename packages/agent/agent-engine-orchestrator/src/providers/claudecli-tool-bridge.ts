import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { resolveToolCallName } from "../clients/tool-naming.js";
import { DEFAULT_PROVIDER_TIMEOUT_MS, type EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest, ToolDefinition } from "./types.js";

/**
 * Per-`chat()` loopback MCP bridge for the claudecli provider (9ed453c1 BRIDGE).
 *
 * The `claude` child used to be handed the agent's real MCP servers via `--mcp-config` while the
 * engine loop ALSO executed every `mcp__*` tool_use itself, so each declared tool ran twice. The
 * bridge makes the engine the single executor: claude's `--mcp-config` points ONLY at this
 * 127.0.0.1 Streamable-HTTP endpoint, and every `tools/call` it receives is routed through the
 * engine's `executeTool` seam. There is no other route from claude to the real servers.
 *
 * One route per declared server (`/mcp/<server>`) keeps the model-visible names
 * `mcp__<server>__<tool>` unchanged. Stateless JSON-response mode (no sessions, no SSE).
 */

type ExecuteTool = NonNullable<ProviderChatRequest["executeTool"]>;

export interface ToolBridge {
    /** `http://127.0.0.1:<port>` */
    baseUrl: string;
    /** Per-chat random bearer token; dies with {@link ToolBridge.close}. */
    token: string;
    /** Servers that have at least one advertised tool (one route each). */
    serverNames: string[];
    /** Number of `tools/call` requests that reached `executeTool`. */
    calls(): number;
    /** Stop listening and drop every open socket. Idempotent. */
    close(): Promise<void>;
}

export interface StartToolBridgeOptions {
    /** `request.tools`: the advertised set is exactly what is exposed. */
    tools: readonly ToolDefinition[];
    executeTool: ExecuteTool;
    signal?: AbortSignal;
    logger: EngineLogger;
    /**
     * Upper bound for ONE `tools/call` (9ed453c1 BLIND F6a). Defaults to the engine's provider
     * timeout ({@link DEFAULT_PROVIDER_TIMEOUT_MS}); claudecli passes the agent's
     * `provider.timeoutMs`. When it elapses the model gets a clear `isError` MCP result and the
     * chat carries on, instead of the whole turn hanging until the outer signal fires.
     */
    callTimeoutMs?: number;
    /**
     * Optional per-tool MCP `annotations` to advertise in `tools/list`. Unset (the default) advertises
     * none, so behaviour is unchanged. Exists so the fdb35d6f spike can measure whether the claude CLI
     * runs same-message calls concurrently when a tool carries `readOnlyHint`; see
     * claudecli-parallel-dispatch.e2e.test.ts for the recorded finding before supplying one.
     */
    toolAnnotations?: (tool: string, def: ToolDefinition) => Record<string, unknown> | undefined;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Server name the orchestrator gives its engine-internal pseudo-tools (`builtin__request_human_input`).
 * They are handled by the orchestrator's own tool path (suspend/resume), never by `executeTool`, and
 * claude has never been shown them, so the bridge must not expose them.
 */
export const ENGINE_BUILTIN_TOOL_SERVER = "builtin";

/** The advertised tools the bridge can actually execute through `executeTool` (MCP-server tools only). */
export function bridgeableTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
    return tools.filter((t) => resolveToolCallName(t.name, []).server !== ENGINE_BUILTIN_TOOL_SERVER);
}

/** Group the advertised tools by owning server (`server__tool` naming), original tool names kept. */
export function groupToolsByServer(tools: readonly ToolDefinition[]): Map<string, Map<string, ToolDefinition>> {
    const byServer = new Map<string, Map<string, ToolDefinition>>();
    for (const t of tools) {
        const { server, tool } = resolveToolCallName(t.name, []);
        let m = byServer.get(server);
        if (!m) { m = new Map(); byServer.set(server, m); }
        m.set(tool, t);
    }
    return byServer;
}

/**
 * The `--mcp-config` body for claude: only bridge http entries, one per advertised server, each
 * carrying the bearer token. No stdio command or real-server env/headers ever reaches claude.
 */
export function buildBridgeMcpConfig(
    bridge: Pick<ToolBridge, "baseUrl" | "token" | "serverNames">
): { mcpServers: Record<string, { type: "http"; url: string; headers: Record<string, string> }> } {
    const mcpServers: Record<string, { type: "http"; url: string; headers: Record<string, string> }> = {};
    for (const name of bridge.serverNames) {
        mcpServers[name] = {
            type: "http",
            url: `${bridge.baseUrl}/mcp/${encodeURIComponent(name)}`,
            headers: { Authorization: `Bearer ${bridge.token}` },
        };
    }
    return { mcpServers };
}

type ContentBlock = CallToolResult["content"][number];

const CONTENT_TYPES: ReadonlySet<string> = new Set(["text", "image", "audio", "resource", "resource_link"]);

/** Structural guard for an MCP content-block array (the registry client returns `result.content`). */
function isContentBlockArray(v: unknown): v is ContentBlock[] {
    return Array.isArray(v) && v.length > 0 && v.every(
        (b) => typeof b === "object" && b !== null && CONTENT_TYPES.has((b as { type?: unknown }).type as string)
    );
}

/**
 * Render an `executeTool` result as MCP content. The engine's registry client returns the real
 * server's MCP content-block array; passing it through is exactly what the model saw when claude
 * ran the server itself. A string passes through as text; anything else is JSON-stringified.
 */
function toContent(result: unknown): ContentBlock[] {
    if (isContentBlockArray(result)) return result;
    if (typeof result === "string") return [{ type: "text", text: result }];
    const json = JSON.stringify(result);
    return [{ type: "text", text: json === undefined ? "" : json }];
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
    if (!presented) return false;
    const m = /^Bearer (.+)$/.exec(presented);
    if (!m) return false;
    const a = Buffer.from(m[1]!);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) { reject(new Error("request body too large")); req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
            catch (e) { reject(e); }
        });
        req.on("error", reject);
    });
}

function reply(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
    res.end(body);
}

/**
 * Start the bridge. Resolves once the loopback listener is bound. The caller MUST `close()` it
 * (claudecli does so in `finally`); it also closes itself if `signal` aborts.
 */
export async function startToolBridge(opts: StartToolBridgeOptions): Promise<ToolBridge> {
    const { executeTool, logger } = opts;
    const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    const byServer = groupToolsByServer(opts.tools);
    const token = randomBytes(32).toString("hex");
    let callCount = 0;
    let port = 0;

    const buildServer = (serverName: string, advertised: Map<string, ToolDefinition>): Server => {
        const server = new Server(
            { name: `agent-mcp-claudecli-bridge:${serverName}`, version: "1.0.0" },
            { capabilities: { tools: {} } }
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [...advertised.entries()].map(([tool, def]) => {
                const annotations = opts.toolAnnotations?.(tool, def);
                return {
                    name: tool,
                    description: def.description,
                    inputSchema: def.inputSchema as { type: "object"; [k: string]: unknown },
                    ...(annotations ? { annotations } : {}),
                };
            }),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const tool = request.params.name;
            if (!advertised.has(tool)) {
                throw new McpError(ErrorCode.InvalidParams, `Unknown tool '${tool}' on server '${serverName}'`);
            }
            callCount += 1;
            let timer: NodeJS.Timeout | undefined;
            try {
                const timedOut = new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(
                            `Tool '${tool}' on server '${serverName}' timed out after ${callTimeoutMs}ms ` +
                            `(claudecli bridge per-call limit; raise provider.timeoutMs to allow longer tool calls)`
                        )),
                        callTimeoutMs
                    );
                });
                const { result, isError } = await Promise.race([
                    executeTool(serverName, tool, request.params.arguments ?? {}),
                    timedOut,
                ]);
                return { content: toContent(result), isError };
            } catch (err) {
                return {
                    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
                    isError: true,
                };
            } finally {
                if (timer) clearTimeout(timer);
            }
        });
        return server;
    };

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        if (!tokenMatches(req.headers.authorization, token)) {
            reply(res, 401, "unauthorized", { "www-authenticate": "Bearer" });
            return;
        }
        const host = req.headers.host;
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
            reply(res, 403, "forbidden host");
            return;
        }
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        const m = /^\/mcp\/([^/]+)$/.exec(url.pathname);
        let serverName: string | undefined;
        try { serverName = m ? decodeURIComponent(m[1]!) : undefined; } catch { serverName = undefined; }
        const advertised = serverName === undefined ? undefined : byServer.get(serverName);
        if (serverName === undefined || !advertised) {
            reply(res, 404, "unknown route");
            return;
        }
        if (req.method !== "POST") {
            // Stateless: no standalone SSE stream, no session to DELETE (MCP spec allows 405).
            reply(res, 405, "method not allowed", { allow: "POST" });
            return;
        }
        let body: unknown;
        try { body = await readBody(req); }
        catch { reply(res, 400, "invalid JSON body"); return; }

        const server = buildServer(serverName, advertised);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        res.on("close", () => { void transport.close(); void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
    };

    const http: HttpServer = createServer((req, res) => {
        handle(req, res).catch((err: unknown) => {
            logger.warn({ err: err instanceof Error ? err.message : String(err) }, "claudecli bridge: request failed");
            if (!res.headersSent) reply(res, 500, "bridge error");
            else res.end();
        });
    });

    await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(0, "127.0.0.1", () => { http.off("error", reject); resolve(); });
    });
    port = (http.address() as AddressInfo).port;

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
        closing ??= new Promise<void>((resolve) => {
            http.close(() => resolve());
            http.closeAllConnections();
        });
        return closing;
    };
    const onAbort = (): void => { void close(); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        token,
        serverNames: [...byServer.keys()],
        calls: () => callCount,
        close: async () => {
            opts.signal?.removeEventListener("abort", onAbort);
            await close();
        },
    };
}
