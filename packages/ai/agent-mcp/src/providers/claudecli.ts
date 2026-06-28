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
 * Agent-spec mode (config.systemPromptIsAgentSpec === true):
 *   The agent's systemPrompt is treated as a complete Claude Code agent markdown
 *   file (YAML frontmatter + body). Instead of --system-prompt + --disallowedTools,
 *   the provider writes it to an isolated temp project dir and passes
 *     --add-dir <tmpdir> --setting-sources project --agent <frontmatterName>
 *   so Claude *internally parses the frontmatter header* — including the `tools:`
 *   field — which then governs tool access and TAKES PRECEDENCE over the built-in
 *   disallow enumeration. `--agent` matches the frontmatter `name:`, not the
 *   filename; cwd is preserved so file/Bash tools keep their working root. Omit
 *   `tools:` in the header to inherit all tools; list `mcp__<server>__<tool>`
 *   entries to expose specific MCP tools. allowedBuiltinTools is ignored in this mode.
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
import { logger } from "../logger.js";
import { config } from "../config.js";

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

// ─── built-in tool list ───────────────────────────────────────────────────────

/**
 * Complete list of Claude Code built-in tool names (as of Claude Code 1.x).
 *
 * All of these are disallowed by default for claudecli agents. The permitted
 * set is resolved from one of two sources in priority order:
 *
 *   1. compiledTools (AGENT_TOOL model) — the platform-alias array produced by
 *      `compileAgent({ platform: "claude_code" }).tools` via @adhd/agent-compiler.
 *      This is the strategic source of truth: each string is a `TOOL_PLATFORM_BINDING`
 *      alias for the `claude_code` platform, derived from AGENT_TOOL grants in the
 *      registry. When compiledTools is supplied to the constructor, it is used as
 *      the allowed set and config.allowedBuiltinTools is ignored.
 *
 *   2. config.allowedBuiltinTools — the per-agent legacy allowlist (still honoured
 *      when no compiled tool set is available, e.g. during the transition window
 *      before compiler-integration lands).
 *
 * [inv:no-third-tool-model] — claudecli must NOT maintain an independent third
 * tool-permission list separate from AGENT_TOOL / compiled.tools.
 *
 * MCP tools (loaded via --mcp-config) are unaffected by this list.
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

// ─── built-in arg computation (pure, testable seam) ──────────────────────────

/**
 * Compute the effective allowed built-in set and the `--disallowedTools` argv
 * entries that must be passed to the `claude` CLI subprocess.
 *
 * This is the single source of truth for [inv:no-third-tool-model]: the
 * allowed set is resolved in priority order:
 *   1. `compiledTools` (AGENT_TOOL / compile.tools model) — wins when present.
 *   2. `config.allowedBuiltinTools`  — legacy / transition-window fallback.
 *
 * Extracted here so tests can assert the REAL produced argv without spawning
 * a subprocess.  `chat()` must call this function; no divergence allowed.
 *
 * @param compiledTools - Platform-alias array from `compileAgent().tools`, or
 *   `undefined` when the compiler integration is not available yet.
 * @param allowedBuiltinTools - Per-agent legacy allowlist from config.
 * @returns `{ effectiveAllowed, disallowedArgv }` where `disallowedArgv` is the
 *   flat `["--disallowedTools", "<name>", ...]` fragment ready to push into args.
 */
export function computeClaudeBuiltinArgs(params: {
    compiledTools: string[] | undefined;
    allowedBuiltinTools: string[] | undefined;
}): { effectiveAllowed: string[]; disallowedArgv: string[] } {
    const effectiveAllowed: string[] =
        params.compiledTools !== undefined
            ? params.compiledTools              // AGENT_TOOL / compiled.tools model wins
            : (params.allowedBuiltinTools ?? []);

    const allowed = new Set(effectiveAllowed);
    const disallowed = CLAUDE_CODE_BUILTIN_TOOLS.filter(t => !allowed.has(t));

    const disallowedArgv: string[] = [];
    for (const tool of disallowed) {
        disallowedArgv.push("--disallowedTools", tool);
    }

    return { effectiveAllowed, disallowedArgv };
}

// ─── agent-spec (markdown frontmatter) helpers ───────────────────────────────

/** Fallback identity used when an agent-spec prompt has no frontmatter `name:`. */
const FALLBACK_SPEC_AGENT_NAME = "agent-mcp-runner";
const FALLBACK_SPEC_DESCRIPTION = "agent-mcp delegated agent";

/**
 * Extracts the `name:` field from the leading YAML frontmatter block of a Claude
 * Code agent markdown system prompt. Only the first `---`-delimited block at the
 * very top of the string is considered. Returns undefined when there is no leading
 * frontmatter block or no `name:` key.
 *
 * Claude Code selects an agent (`--agent <name>`) by this frontmatter name — not
 * the on-disk filename — so the provider must read it to build the correct flag.
 */
export function extractAgentSpecName(md: string): string | undefined {
    const block = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
    if (!block) return undefined;
    const nameLine = /^[ \t]*name:[ \t]*(.+?)[ \t]*$/m.exec(block[1]);
    if (!nameLine) return undefined;
    return nameLine[1].replace(/^["']|["']$/g, "").trim() || undefined;
}

/**
 * Ensures an agent-spec markdown carries a frontmatter `name:` so the subprocess
 * can select it with `--agent`. Returns the markdown to write and the agent name
 * to pass to `--agent`.
 *
 * - If the prompt already names the agent, it is used verbatim and the markdown is
 *   returned unchanged (the spec author's `tools:` header is the source of truth).
 * - If a frontmatter block exists but lacks `name:`, a generated name is injected
 *   into it.
 * - If there is no frontmatter at all, the prompt is wrapped in a minimal block
 *   (no `tools:` → Claude inherits all tools, matching pre-spec-mode behavior).
 */
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
    private readonly config: ClaudeCliConfig;
    private readonly mcpServers: Record<string, McpServerConfig>;
    /**
     * Platform-alias tool list derived from the AGENT_TOOL / compiled.tools model.
     *
     * When supplied (via `compileAgent({ platform: "claude_code" }).tools`), this
     * array is the single source of truth for which Claude Code built-ins are
     * permitted — config.allowedBuiltinTools is ignored. When absent, the provider
     * falls back to config.allowedBuiltinTools (legacy / transition-window path).
     *
     * [inv:no-third-tool-model] — one tool-permission source, not two.
     */
    private readonly compiledTools: string[] | undefined;

    constructor(
        config: ClaudeCliConfig,
        mcpServers: Record<string, McpServerConfig> = {},
        compiledTools?: string[]
    ) {
        this.config = config;
        this.mcpServers = mcpServers;
        this.compiledTools = compiledTools;
    }

    /**
     * Build the subprocess environment for the claude CLI subprocess.
     *
     * Merges the live process.env (PATH, HOME, call-time vars) with the
     * config snapshot (ADHD_AGENT_* vars loaded from the .env hierarchy at
     * startup), with the config snapshot winning on conflicts. This ensures
     * the subprocess inherits both the user's shell context and any overrides
     * loaded via the .env hierarchy — and allows test-injected env vars (e.g.
     * CAPTURE_FILE) to flow through to the subprocess without a module reload.
     */
    private buildSubprocessEnv(): Record<string, string> {
        const result: Record<string, string> = {};
        // Start with the live env for full context (PATH, HOME, etc.)
        for (const [k, v] of Object.entries(process.env)) {
            if (v !== undefined) result[k] = v;
        }
        // Overlay the config snapshot so ADHD_AGENT_* values from .env files win
        for (const [k, v] of Object.entries(config.subprocessEnv())) {
            result[k] = v;
        }
        return result;
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

    /**
     * Writes an agent-spec markdown system prompt to an isolated temp project dir
     * as `<dir>/.claude/agents/<name>.md`, so the subprocess can discover and
     * parse it via `--add-dir <dir> --setting-sources project --agent <name>`.
     *
     * Returns the temp dir (for `--add-dir`) and the frontmatter agent name (for
     * `--agent`). The caller MUST delete the dir in its finally block.
     */
    private async writeAgentSpecDir(md: string): Promise<{ dir: string; agentName: string }> {
        const { content, agentName } = normalizeAgentSpec(md);
        const dir = await mkdtemp(join(tmpdir(), "agent-mcp-spec-"));
        const agentsDir = join(dir, ".claude", "agents");
        await mkdir(agentsDir, { recursive: true });
        // The filename does not affect selection (Claude matches the frontmatter
        // name), but sanitize it so an exotic agent name can't escape the dir.
        const safeFile = `${agentName.replace(/[^a-zA-Z0-9_-]/g, "_") || "agent"}.md`;
        await writeFile(join(agentsDir, safeFile), content, "utf8");
        return { dir, agentName };
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

        // Agent-spec mode: the system prompt IS a Claude Code agent markdown file
        // (frontmatter + body). We write it to a temp project dir and let Claude
        // internally parse its `tools:` header, which then governs tool access and
        // takes precedence over --disallowedTools. Requires a system prompt to wrap.
        const specMode = this.config.systemPromptIsAgentSpec === true && !!systemPrompt;
        let agentSpecDir: string | undefined;
        let agentSpecName: string | undefined;
        if (specMode && systemPrompt) {
            const written = await this.writeAgentSpecDir(systemPrompt);
            agentSpecDir = written.dir;
            agentSpecName = written.agentName;
        }

        // Compute the disallowed built-in list via the extracted pure seam.
        // Source of truth priority ([inv:no-third-tool-model]) is enforced inside
        // computeClaudeBuiltinArgs — compiledTools wins over allowedBuiltinTools.
        // Used only in the legacy (non-spec) path below; in spec mode the agent
        // md `tools:` header is the single source of truth.
        const { disallowedArgv } = computeClaudeBuiltinArgs({
            compiledTools: this.compiledTools,
            allowedBuiltinTools: this.config.allowedBuiltinTools,
        });

        const args: string[] = [
            "-p",
            "--dangerously-skip-permissions", // no interactive permission prompts
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
        ];

        if (specMode && agentSpecDir && agentSpecName) {
            // Header-driven tools: Claude parses the agent md's frontmatter `tools:`
            // and applies it as the authoritative allowlist. We must NOT pass
            // --disallowedTools or --system-prompt here — the spec header is the
            // single source of truth. --add-dir makes the temp `.claude/agents/<name>.md`
            // discoverable; --setting-sources project loads it; --agent selects it by
            // its frontmatter name (cwd is preserved, so file/Bash tools keep their root).
            args.push(
                "--add-dir", agentSpecDir,
                "--setting-sources", "project",
                "--agent", agentSpecName,
            );
            if (this.config.allowedBuiltinTools?.length) {
                logger.warn(
                    { agent: agentSpecName },
                    "claudecli: allowedBuiltinTools is ignored when systemPromptIsAgentSpec is set; the agent spec's `tools:` header governs tool access",
                );
            }
        } else {
            // Legacy denylist behavior: block every built-in the agent definition
            // doesn't explicitly allow, via the compiledTools-aware seam
            // ([inv:no-third-tool-model] — compiledTools wins over allowedBuiltinTools).
            // MCP tools are unaffected — loaded via --mcp-config separately.
            args.push(...disallowedArgv);
            if (systemPrompt) args.push("--system-prompt", systemPrompt);
        }


        if (this.config.model)   args.push("--model", this.config.model);

        if (mcpConfigPath) {
            // --strict-mcp-config prevents auto-discovered .mcp.json from loading
            // alongside our explicit config (avoids double-spawning agent-mcp)
            args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
        }

        const subEnv = this.buildSubprocessEnv();

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
            // Clean up the temp MCP config file
            if (mcpConfigPath) {
                unlink(mcpConfigPath).catch(() => { /* best-effort */ });
            }
            // Clean up the temp agent-spec project dir
            if (agentSpecDir) {
                rm(agentSpecDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
            }
        }
    }
}
