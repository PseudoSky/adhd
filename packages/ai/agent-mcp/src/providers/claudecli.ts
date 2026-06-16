/**
 * ClaudeCliProvider — drives the local `claude` CLI (Claude Code) as an LLM
 * backend using a persistent subprocess with bidirectional stream-json I/O.
 *
 * Auth: uses whatever credentials Claude Code already has configured
 * (subscription, API key, OAuth — whatever `claude auth status` shows).
 *
 * Flags applied on every invocation:
 *   --system-prompt           Replace Claude Code's default prompt with the agent's prompt
 *   --mcp-config <tempfile>   Writes the agent's mcpServers to a temp JSON file; path passed here
 *   --strict-mcp-config       Ignore all other MCP configs; only load what we pass
 *   --input-format stream-json   Accept NDJSON messages on stdin
 *   --output-format stream-json  Emit NDJSON events on stdout
 *   --verbose                 Emit full event stream including tool calls and results
 *
 *   --disallowedTools <name> (×N) — one pair per built-in not in allowedBuiltinTools.
 *       All Claude Code built-ins are blocked by default; only tools explicitly listed
 *       in the agent definition's allowedBuiltinTools field are permitted. MCP tools
 *       (from --mcp-config) are unaffected.
 *
 * ⚠️  --tools "" is NOT used — it disables MCP tools as well as built-ins.
 * ⚠️  --bare is NOT used — it blocks --mcp-config from loading entirely.
 *
 * Tool loop: when Claude Code emits a tool_use block, we execute it via the
 * request.executeTool callback (wired by the orchestrator to the McpClientRegistry)
 * and write a tool_result message back to stdin. This continues until Claude
 * emits a "result" event, at which point chat() resolves with stopReason "completed".
 *
 * ⚠️  KNOWN ISSUE: Claude Code may crash with
 *     "Z is not an Object. (evaluating '"tool_use_id"in Z')"
 *     when a tool_result is written to stdin. This is a suspected Claude Code bug
 *     (github.com/anthropics/claude-code/issues/24594). If you hit this, the
 *     provider will throw PROVIDER_ERROR and the task will fail. Fall back to the
 *     anthropic provider with useClaudeOauth: true for a fully supported path.
 */

import { spawn, execFile } from "child_process";
import readline from "readline";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { resolveToolCallName } from "../clients/tool-naming.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "./types.js";
import type { McpServerConfig, ProviderConfig, Message } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import { logger } from "../logger.js";

type ClaudeCliConfig = Extract<ProviderConfig, { type: "claudecli" }>;

// ─── stream-json event shapes (stdout from claude -p) ────────────────────────

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

// ─── MCP config format (Claude Code .mcp.json shape) ─────────────────────────

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

// ─── history encoding (for multi-task sessions) ───────────────────────────────

/**
 * Encodes prior session messages as a text block prepended to the current prompt.
 * Only needed when the session has history from prior tasks — within a single task,
 * Claude Code handles its own context via the stream-json tool loop.
 *
 * If there is only one non-system message, it is returned verbatim.
 */
function buildUserMessage(messages: Message[]): string {
    const nonSystem = messages.filter(m => m.role !== "system");
    if (nonSystem.length === 0) return "";
    if (nonSystem.length === 1) return nonSystem[0].content ?? "";

    const history = nonSystem.slice(0, -1);
    const last = nonSystem[nonSystem.length - 1];

    const lines: string[] = ["[Conversation history]"];
    for (const msg of history) {
        const label =
            msg.role === "user"      ? "User" :
            msg.role === "assistant" ? "Assistant" :
            msg.role === "tool"      ? "Tool result" : "System";
        const body =
            msg.content ??
            (msg.toolCalls ? `[called tools: ${msg.toolCalls.map(tc => tc.tool).join(", ")}]` : "");
        lines.push(`${label}: ${body}`);
    }
    lines.push("", "[Current message]", last.content ?? "");
    return lines.join("\n");
}

// ─── built-in tool list ───────────────────────────────────────────────────────

/**
 * Complete list of Claude Code built-in tool names (as of Claude Code 1.x).
 * All of these are disallowed by default for claudecli agents; only tools
 * listed in the agent's `allowedBuiltinTools` are permitted. MCP tools
 * (loaded via --mcp-config) are unaffected by this list.
 */
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

// ─── provider ────────────────────────────────────────────────────────────────

export class ClaudeCliProvider implements LLMProvider {
    private readonly config: ClaudeCliConfig;
    private readonly mcpServers: Record<string, McpServerConfig>;

    constructor(config: ClaudeCliConfig, mcpServers: Record<string, McpServerConfig> = {}) {
        this.config = config;
        this.mcpServers = mcpServers;
    }

    /**
     * Build the subprocess environment. Inherits the parent process env and,
     * on macOS, tries to inject ANTHROPIC_AUTH_TOKEN from the Claude Code keychain.
     * This is required when --bare is set, because --bare skips the settings
     * discovery that normally loads Claude Code's auth configuration.
     */
    private async buildSubprocessEnv(): Promise<{ env: NodeJS.ProcessEnv; keychainError?: string }> {
        const env: NodeJS.ProcessEnv = { ...process.env };

        // If an explicit auth token env var is already present, nothing to do
        if (env["ANTHROPIC_AUTH_TOKEN"] || env["ANTHROPIC_API_KEY"]) {
            return { env };
        }

        let keychainError: string | undefined;

        // Try macOS keychain — same store as useClaudeOauth in AnthropicProvider
        try {
            const { stdout } = await execFileAsync(
                "security",
                ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
                { encoding: "utf8" }
            );
            const parsed = JSON.parse(stdout.trim()) as {
                claudeAiOauth?: { accessToken?: string };
            };
            const token = parsed.claudeAiOauth?.accessToken;
            if (token) env["ANTHROPIC_AUTH_TOKEN"] = token;
        } catch (err) {
            keychainError = err instanceof Error ? err.message : String(err);
            logger.warn({ keychainError }, "claudecli: keychain read failed; subprocess will use inherited env");
        }

        return { env, keychainError };
    }

    /**
     * Write the agent's McpServerConfig map to a temp JSON file in the format
     * Claude Code's --mcp-config flag expects. Inline JSON strings are not parsed
     * by the CLI — a file path is required.
     *
     * Maps our `transport` field to Claude Code's `type`. The caller is responsible
     * for deleting the file (use the finally block in chat()).
     *
     * Returns undefined if there are no servers to configure.
     */
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

    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        const claudePath = this.config.claudePath ?? "claude";

        const systemMessages = request.messages.filter(m => m.role === "system");
        const systemPrompt = systemMessages.map(m => m.content ?? "").join("\n") || undefined;
        const userMessage = buildUserMessage(request.messages);

        // Write MCP config to a temp file.
        // Note: --bare blocks ALL MCP loading including explicit --mcp-config, so
        // we do NOT use --bare. CLAUDE.md will be injected but --system-prompt
        // replaces the full default system prompt, keeping the agent's identity.
        const mcpConfigPath = await this.writeMcpConfigFile();

        // Compute the disallowed built-in list: everything in CLAUDE_CODE_BUILTIN_TOOLS
        // that is NOT listed in the agent's allowedBuiltinTools allowlist.
        const allowed = new Set(this.config.allowedBuiltinTools ?? []);
        const disallowed = CLAUDE_CODE_BUILTIN_TOOLS.filter(t => !allowed.has(t));

        const args: string[] = [
            "-p",
            "--dangerously-skip-permissions", // no interactive permission prompts
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
        ];

        // Block every built-in that the agent definition doesn't explicitly allow.
        // --disallowedTools accepts individual tool names as separate flag pairs.
        // MCP tools are not affected — they're loaded via --mcp-config separately.
        for (const tool of disallowed) {
            args.push("--disallowedTools", tool);
        }

        if (systemPrompt)        args.push("--system-prompt", systemPrompt);
        if (this.config.model)   args.push("--model", this.config.model);

        if (mcpConfigPath) {
            // --strict-mcp-config prevents auto-discovered .mcp.json from loading
            // alongside our explicit config (avoids double-spawning agent-mcp)
            args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
        }

        const { env: subEnv, keychainError } = await this.buildSubprocessEnv();

        const proc = spawn(claudePath, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: subEnv,
        });

        const rl = readline.createInterface({
            input: proc.stdout!,
            crlfDelay: Infinity,
        });

        // Kill subprocess on abort/timeout
        const onAbort = (): void => { proc.kill("SIGTERM"); };
        request.signal?.addEventListener("abort", onAbort, { once: true });

        try {
            // Write initial user message as first stream-json line
            proc.stdin!.write(
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
                    continue; // skip non-JSON lines (e.g. blank lines, debug output)
                }

                // ── Final result ─────────────────────────────────────────────
                if (event.type === "result") {
                    const r = event as ClaudeStreamResultEvent;
                    if (r.is_error) {
                        throw new Error(`PROVIDER_ERROR: claude CLI returned error: ${r.result ?? "(no message)"}`);
                    }
                    finalResult = r.result ?? "";
                    break;
                }

                // ── Tool calls ───────────────────────────────────────────────
                if (event.type === "assistant") {
                    const assistantEvent = event as ClaudeStreamAssistantEvent;
                    const toolUseBlocks = (assistantEvent.message?.content ?? []).filter(
                        (b): b is ClaudeToolUseBlock => b.type === "tool_use"
                    );

                    for (const block of toolUseBlocks) {
                        let toolResultText: string;
                        let isError = false;

                        if (request.executeTool) {
                            // Claude Code prefixes MCP tool names with "mcp__":
                            //   mcp__agent-mcp__task → agent-mcp__task → server=agent-mcp, tool=task
                            let qualifiedName = block.name;
                            if (qualifiedName.startsWith("mcp__")) {
                                qualifiedName = qualifiedName.slice(5);
                            }
                            try {
                                // Resolve qualified or bare names against the advertised set
                                // (a bare `task` → `agent-mcp__task` when unambiguous; DEBT-004).
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

                        // ⚠️  tool_result injection — see module-level warning about
                        //     the suspected Claude Code crash on this path.
                        proc.stdin!.write(
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

            proc.stdin!.end();

            if (!finalResult) {
                throw new ToolError(
                    "PROVIDER_AUTH_ERROR",
                    `Claude CLI returned empty result${keychainError ? `. Keychain error: ${keychainError}` : ""}. ` +
                    `Set ANTHROPIC_AUTH_TOKEN (run \`claude setup-token\` to obtain an OAuth access token) or use authTokenEnv in the provider config`
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
            // Clean up the temp MCP config file
            if (mcpConfigPath) {
                unlink(mcpConfigPath).catch(() => { /* best-effort */ });
            }
        }
    }
}
