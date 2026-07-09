import { spawn } from "child_process";
import readline from "readline";
import { writeFile, unlink, mkdtemp, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { resolveToolCallName } from "../clients/tool-naming.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "./types.js";
import type { McpServerConfig, ProviderConfig, Message } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import type { EngineLogger, EngineConfig } from "../interfaces.js";

type ClaudeCliConfig = Extract<ProviderConfig, { type: "claudecli" }>;

// ─── stream-json event shapes ────────────────────────────────────────────────

interface ClaudeStreamResultEvent {
    type: "result";
    subtype: string;
    is_error: boolean;
    result?: string;
}

interface ClaudeToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
}

interface ClaudeStreamAssistantEvent {
    type: "assistant";
    message: {
        role: "assistant";
        content: Array<{ type: string } & Partial<ClaudeToolUseBlock>>;
    };
}

type ClaudeStreamEvent =
    | ClaudeStreamResultEvent
    | ClaudeStreamAssistantEvent
    | { type: string };

// ─── MCP config format ───────────────────────────────────────────────────────

interface ClaudeStdioMcpEntry {
    type: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

interface ClaudeHttpMcpEntry {
    type: "http" | "sse";
    url: string;
    headers?: Record<string, string>;
}

type ClaudeMcpEntry = ClaudeStdioMcpEntry | ClaudeHttpMcpEntry;

// ─── history encoding ────────────────────────────────────────────────────────

function buildUserMessage(messages: Message[]): string {
    const nonSystem = messages.filter(m => m.role !== "system");
    if (nonSystem.length === 0) return "";
    if (nonSystem.length === 1) return nonSystem[0].content ?? "";

    const history = nonSystem.slice(0, -1);
    const last = nonSystem[nonSystem.length - 1];

    const lines: string[] = ["[Conversation history]"];
    for (const msg of history) {
        let label: string;
        if (msg.role === "user") {
            label = "User";
        } else if (msg.role === "assistant") {
            label = "Assistant";
        } else if (msg.role === "tool") {
            label = "Tool result";
        } else {
            label = "System";
        }
        const body =
            msg.content ??
            (msg.toolCalls ? `[called tools: ${msg.toolCalls.map(tc => tc.tool).join(", ")}]` : "");
        lines.push(`${label}: ${body}`);
    }
    lines.push("", "[Current message]", last.content ?? "");
    return lines.join("\n");
}

// ─── built-in tool list ──────────────────────────────────────────────────────

const CLAUDE_CODE_BUILTIN_TOOLS = [
    "Bash",
    "Edit",
    "MultiEdit",
    "Read",
    "Write",
    "Glob",
    "Grep",
    "LS",
    "WebFetch",
    "WebSearch",
    "TodoRead",
    "TodoWrite",
    "NotebookRead",
    "NotebookEdit",
    "Task",
] as const;

/**
 * Compute the effective allowed built-in set and the `--disallowedTools` argv
 * entries that must be passed to the `claude` CLI subprocess.
 */
export function computeClaudeBuiltinArgs(params: {
    compiledTools: string[] | undefined;
    allowedBuiltinTools: string[] | undefined;
}): { effectiveAllowed: string[]; disallowedArgv: string[] } {
    const effectiveAllowed: string[] =
        params.compiledTools !== undefined
            ? params.compiledTools
            : (params.allowedBuiltinTools ?? []);

    const allowed = new Set(effectiveAllowed);
    const disallowed = CLAUDE_CODE_BUILTIN_TOOLS.filter(t => !allowed.has(t));

    const disallowedArgv: string[] = [];
    for (const tool of disallowed) {
        disallowedArgv.push("--disallowedTools", tool);
    }

    return { effectiveAllowed, disallowedArgv };
}

// ─── agent-spec helpers ──────────────────────────────────────────────────────

const FALLBACK_SPEC_AGENT_NAME = "agent-mcp-runner";
const FALLBACK_SPEC_DESCRIPTION = "agent-mcp delegated agent";

export function extractAgentSpecName(md: string): string | undefined {
    const block = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
    if (!block) return undefined;
    const nameLine = /^[ \t]*name:[ \t]*(.+?)[ \t]*$/m.exec(block[1]);
    if (!nameLine) return undefined;
    return nameLine[1].replace(/^["']|["']$/g, "").trim() || undefined;
}

export function normalizeAgentSpec(md: string): { content: string; agentName: string } {
    const existing = extractAgentSpecName(md);
    if (existing) return { content: md, agentName: existing };

    const hasFrontmatter = /^\uFEFF?---[ \t]*\r?\n/.test(md);
    if (hasFrontmatter) {
        const content = md.replace(
            /^(\uFEFF?---[ \t]*\r?\n)/,
            `$1name: ${FALLBACK_SPEC_AGENT_NAME}\n`,
        );
        return { content, agentName: FALLBACK_SPEC_AGENT_NAME };
    }
    const content =
        `---\nname: ${FALLBACK_SPEC_AGENT_NAME}\n` +
        `description: ${FALLBACK_SPEC_DESCRIPTION}\n---\n${md}`;
    return { content, agentName: FALLBACK_SPEC_AGENT_NAME };
}

// ─── provider ────────────────────────────────────────────────────────────────

export class ClaudeCliProvider implements LLMProvider {
    private readonly providerConfig: ClaudeCliConfig;
    private readonly mcpServers: Record<string, McpServerConfig>;
    private readonly compiledTools: string[] | undefined;
    private readonly logger: EngineLogger;
    private readonly config: EngineConfig;

    constructor(
        config: ClaudeCliConfig,
        mcpServers: Record<string, McpServerConfig> = {},
        compiledTools?: string[],
        engineConfig?: EngineConfig,
        engineLogger?: EngineLogger
    ) {
        this.providerConfig = config;
        this.mcpServers = mcpServers;
        this.compiledTools = compiledTools;
        this.config = engineConfig ?? {} as EngineConfig;
        this.logger = engineLogger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
    }

    private buildSubprocessEnv(): Record<string, string> {
        const result: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (v !== undefined) result[k] = v;
        }
        for (const [k, v] of Object.entries(this.config.subprocessEnv())) {
            result[k] = v;
        }
        return result;
    }

    private async writeMcpConfigFile(): Promise<string | undefined> {
        const entries = Object.entries(this.mcpServers);
        if (entries.length === 0) return undefined;

        const mapped: Record<string, ClaudeMcpEntry> = {};

        for (const [name, cfg] of entries) {
            if (cfg.transport === "stdio") {
                const entry: ClaudeStdioMcpEntry = {
                    type: "stdio",
                    command: cfg.command,
                };
                if (cfg.args?.length)  entry.args = cfg.args;
                if (cfg.env && Object.keys(cfg.env).length) entry.env = cfg.env;
                mapped[name] = entry;
            } else if (cfg.transport === "http" || cfg.transport === "sse") {
                const entry: ClaudeHttpMcpEntry = {
                    type: cfg.transport,
                    url: cfg.url,
                };
                if (cfg.headers && Object.keys(cfg.headers).length) entry.headers = cfg.headers;
                mapped[name] = entry;
            }
        }

        const filePath = join(tmpdir(), `agent-mcp-claudecli-${Date.now()}.json`);
        await writeFile(filePath, JSON.stringify({ mcpServers: mapped }), "utf8");
        return filePath;
    }

    private async writeAgentSpecDir(md: string): Promise<{ dir: string; agentName: string }> {
        const { content, agentName } = normalizeAgentSpec(md);
        const dir = await mkdtemp(join(tmpdir(), "agent-mcp-spec-"));
        const agentsDir = join(dir, ".claude", "agents");
        await mkdir(agentsDir, { recursive: true });
        const safeFile = `${agentName.replace(/[^a-zA-Z0-9_-]/g, "_") || "agent"}.md`;
        await writeFile(join(agentsDir, safeFile), content, "utf8");
        return { dir, agentName };
    }

    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        const claudePath = this.providerConfig.claudePath ?? "claude";

        const systemMessages = request.messages.filter(m => m.role === "system");
        const systemPrompt = systemMessages.map(m => m.content ?? "").join("\n") || undefined;
        const userMessage = buildUserMessage(request.messages);

        const mcpConfigPath = await this.writeMcpConfigFile();

        const specMode = this.providerConfig.systemPromptIsAgentSpec === true && !!systemPrompt;
        let agentSpecDir: string | undefined;
        let agentSpecName: string | undefined;
        if (specMode && systemPrompt) {
            const written = await this.writeAgentSpecDir(systemPrompt);
            agentSpecDir = written.dir;
            agentSpecName = written.agentName;
        }

        const { disallowedArgv } = computeClaudeBuiltinArgs({
            compiledTools: this.compiledTools,
            allowedBuiltinTools: this.providerConfig.allowedBuiltinTools,
        });

        const args: string[] = [
            "-p",
            "--dangerously-skip-permissions",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
        ];

        if (specMode && agentSpecDir && agentSpecName) {
            args.push(
                "--add-dir", agentSpecDir,
                "--setting-sources", "project",
                "--agent", agentSpecName,
            );
            if (this.providerConfig.allowedBuiltinTools?.length) {
                this.logger.warn(
                    { agent: agentSpecName },
                    "claudecli: allowedBuiltinTools is ignored when systemPromptIsAgentSpec is set; the agent spec's `tools:` header governs tool access",
                );
            }
        } else {
            args.push(...disallowedArgv);
            if (systemPrompt) args.push("--system-prompt", systemPrompt);
        }

        if (this.providerConfig.model)   args.push("--model", this.providerConfig.model);

        if (mcpConfigPath) {
            args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
        }

        const subEnv = this.buildSubprocessEnv();

        const proc = spawn(claudePath, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: subEnv,
        });

        if (!proc.stdout) throw new Error('stdout not available');
        if (!proc.stdin) throw new Error('stdin not available');

        const rl = readline.createInterface({
            input: proc.stdout,
            crlfDelay: Infinity,
        });

        const onAbort = (): void => { proc.kill("SIGTERM"); };
        request.signal?.addEventListener("abort", onAbort, { once: true });

        try {
            proc.stdin.write(
                JSON.stringify({
                    type: "user",
                    message: { role: "user", content: userMessage },
                }) + "\n"
            );

            let procError: Error | undefined;
            proc.on("error", (err) => { procError = err; });

            let finalResult = "";

            for await (const line of rl) {
                if (request.signal?.aborted) {
                    throw new Error("PROVIDER_ERROR: request aborted");
                }
                if (procError) {
                    throw new Error(`PROVIDER_ERROR: claude CLI error: ${procError.message}`);
                }

                let event: ClaudeStreamEvent;
                try {
                    event = JSON.parse(line) as ClaudeStreamEvent;
                } catch {
                    continue;
                }

                if (event.type === "result") {
                    const r = event as ClaudeStreamResultEvent;
                    if (r.is_error) {
                        throw new Error(`PROVIDER_ERROR: claude CLI returned error: ${r.result ?? "(no message)"}`);
                    }
                    finalResult = r.result ?? "";
                    break;
                }

                if (event.type === "assistant") {
                    const assistantEvent = event as ClaudeStreamAssistantEvent;
                    const toolUseBlocks = (assistantEvent.message?.content ?? []).filter(
                        (b): b is ClaudeToolUseBlock => b.type === "tool_use"
                    );

                    for (const block of toolUseBlocks) {
                        let toolResultText: string;
                        let isError = false;

                        if (request.executeTool) {
                            let qualifiedName = block.name;
                            if (qualifiedName.startsWith("mcp__")) {
                                qualifiedName = qualifiedName.slice(5);
                            }
                            try {
                                const { server, tool } = resolveToolCallName(
                                    qualifiedName,
                                    (request.tools ?? []).map((t) => t.name)
                                );
                                const { result, isError: err } = await request.executeTool(
                                    server, tool, block.input
                                );
                                toolResultText = typeof result === "string"
                                    ? result
                                    : JSON.stringify(result);
                                isError = err;
                            } catch (err) {
                                toolResultText = err instanceof Error ? err.message : String(err);
                                isError = true;
                            }
                        } else {
                            toolResultText = "Tool execution not available (no executeTool callback)";
                            isError = true;
                        }

                        proc.stdin.write(
                            JSON.stringify({
                                type: "user",
                                message: {
                                    role: "user",
                                    content: [{
                                        type: "tool_result",
                                        tool_use_id: block.id,
                                        content: [{ type: "text", text: toolResultText }],
                                        is_error: isError,
                                    }],
                                },
                            }) + "\n"
                        );
                    }
                }
            }

            proc.stdin.end();

            if (!finalResult) {
                throw new ToolError(
                    "PROVIDER_AUTH_ERROR",
                    "Claude CLI returned empty result. " +
                    "Ensure `claude auth status` shows a valid login. " +
                    "To use the Anthropic API instead, set ADHD_AGENT_ANTHROPIC_SECRET in your ~/.adhd/.env."
                );
            }

            const message: Message = {
                id: generateId(),
                sessionId: "",
                role: "assistant",
                content: finalResult,
                createdAt: nowIso(),
            };

            return { message, stopReason: "completed" };
        } finally {
            request.signal?.removeEventListener("abort", onAbort);
            rl.close();
            if (proc.exitCode === null && !proc.killed) {
                proc.kill("SIGTERM");
            }
            if (mcpConfigPath) {
                unlink(mcpConfigPath).catch(() => { /* best-effort */ });
            }
            if (agentSpecDir) {
                rm(agentSpecDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
            }
        }
    }
}
