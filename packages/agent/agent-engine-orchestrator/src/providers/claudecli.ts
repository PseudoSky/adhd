import type { ChildProcess } from "child_process";
import readline from "readline";
import { writeFile, unlink, mkdtemp, mkdir, rm, stat, chmod } from "fs/promises";
import { join } from "path";

import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "./types.js";
import type { ModelUsageEntry, PermissionAction } from "@adhd/agent-base-types";
import type { McpServerConfig, ProviderConfig, Message } from "../validation/index.js";
import { ToolError } from "../validation/errors.js";
import type { EngineLogger, EngineConfig } from "../interfaces.js";
import { wireSpawn } from "./wire.js";
import { normaliseAnthropicUsage } from "./anthropic.js";
import { startToolBridge, buildBridgeMcpConfig, bridgeableTools, type ToolBridge } from "./claudecli-tool-bridge.js";

type ClaudeCliConfig = Extract<ProviderConfig, { type: "claudecli" }>;

// ─── stream-json event shapes ────────────────────────────────────────────────

/**
 * Same normalised stop-reason mapping `anthropic.ts` uses — duplicated (not
 * imported) since it's a private const there; this is the CLI's raw
 * `stop_reason` on the terminal `result` event, same vocabulary as the SDK's
 * `message.stop_reason` since claudecli ultimately drives the same models.
 */
const CLI_STOP_REASON: Record<string, string> = {
    end_turn: "stop", max_tokens: "length", tool_use: "tool_calls",
};

/**
 * The terminal `result` event on a `claude -p --output-format stream-json`
 * run already carries a fully-aggregated `usage` object — cumulative across
 * every internal turn/tool-call round-trip of that single `-p` invocation,
 * computed by the CLI itself, in the same raw shape `anthropic.ts` already
 * normalises via `normaliseAnthropicUsage`. Verified live against a real
 * `claude -p ... --output-format stream-json` run (2026-07-25): the emitted
 * `result` event included `usage: {input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens, ...}` plus
 * `total_cost_usd` and a per-model `modelUsage` breakdown. Previously this
 * interface only declared `type`/`subtype`/`is_error`/`result`, so `usage`
 * was silently dropped by `JSON.parse(...) as ClaudeStreamEvent` even though
 * it was present on the wire — the root cause of agent-mcp's `usage_query`
 * recording zero tokens for every `claudecli`-provider task (tracked as
 * DEBT-AGENTMCP-ACCOUNTING-001 / see backlog item agent-mcp-001).
 */
interface ClaudeStreamResultEvent {
    type: "result";
    subtype: string;
    is_error: boolean;
    result?: string;
    stop_reason?: string;
    /** Model turns the CLI ran inside this single `-p` invocation. */
    num_turns?: number;
    total_cost_usd?: number;
    /**
     * Per-model breakdown keyed by the CONCRETE model id the CLI resolved (an alias such as
     * `--model haiku` shows up here as `claude-haiku-5-5`). Verified against the recorded
     * `claudecli-alias-haiku.stream.jsonl` fixture (79aebb26 BK8).
     */
    modelUsage?: Record<string, ClaudeModelUsage>;
    usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
    };
}

/** One `modelUsage` entry on the terminal `result` event. */
interface ClaudeModelUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
}

/** The CLI's `system`/`init` event; `model` is the concrete id it resolved the `--model` value to. */
interface ClaudeStreamInitEvent {
    type: "system";
    subtype: "init";
    model?: string;
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
        /** Per-model-call usage of THIS turn (one entry per content block of the same message id, all equal). */
        usage?: {
            input_tokens?: number | null;
            cache_read_input_tokens?: number | null;
            cache_creation_input_tokens?: number | null;
        };
    };
}

/**
 * Context size of ONE model call from an `assistant` event's usage: uncached input + cache read +
 * cache creation. This is what the model actually saw on that turn. The terminal `result.usage`
 * is the SUM over every turn and must never be used as a context size (7ead5eaa BK4). Returns 0
 * when the event carries no usage.
 */
function assistantTurnContextTokens(event: ClaudeStreamAssistantEvent): number {
    const u = event.message?.usage;
    if (!u) return 0;
    return finiteNonNegative(u.input_tokens)
        + finiteNonNegative(u.cache_read_input_tokens)
        + finiteNonNegative(u.cache_creation_input_tokens);
}

type ClaudeStreamEvent =
    | ClaudeStreamResultEvent
    | ClaudeStreamAssistantEvent
    | { type: string };

// ─── model resolution (79aebb26 BK8) ─────────────────────────────────────────

function finiteNonNegative(n: unknown): number {
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Work out which concrete model(s) served a `claude -p` run, from what the CLI itself reports and
 * nothing else (no alias table: aliases such as `haiku` move). Precedence:
 *   1. `result.modelUsage` keys -> one entry per key, tokens exactly as the CLI reports them.
 *   2. otherwise the `init` event's `model`, carrying the run's aggregate `usage`.
 *   3. otherwise nothing (the caller leaves the response unresolved; the configured model is used).
 *
 * `modelUsage` carries no TTL split, so the run-wide 1-hour cache-write count (`usage.cache_creation`)
 * is attributed to each model in proportion to its cache-write tokens (exact for the single-model
 * case, which is every observed run).
 */
export function resolveCliModelUsage(
    result: Pick<ClaudeStreamResultEvent, "modelUsage" | "usage">,
    initModel: string | undefined
): { responseModel: string; entries: ModelUsageEntry[] } | undefined {
    const total1h = finiteNonNegative(result.usage?.cache_creation?.ephemeral_1h_input_tokens);
    const keyed = Object.entries(result.modelUsage ?? {}).filter(
        ([id, u]) => id.length > 0 && typeof u === "object" && u !== null
    );

    let entries: ModelUsageEntry[];
    if (keyed.length > 0) {
        const totalWrite = keyed.reduce((n, [, u]) => n + finiteNonNegative(u.cacheCreationInputTokens), 0);
        entries = keyed.map(([id, u]) => {
            const write = finiteNonNegative(u.cacheCreationInputTokens);
            const share = totalWrite > 0 ? Math.min(write, Math.round((total1h * write) / totalWrite)) : 0;
            return {
                model: id,
                uncachedInputTokens: finiteNonNegative(u.inputTokens),
                cacheReadTokens: finiteNonNegative(u.cacheReadInputTokens),
                cacheCreationTokens: write,
                cacheCreation1hTokens: share,
                outputTokens: finiteNonNegative(u.outputTokens),
                ...(typeof u.costUSD === "number" && Number.isFinite(u.costUSD) ? { reportedCostUsd: u.costUSD } : {}),
            };
        });
    } else if (initModel) {
        const write = finiteNonNegative(result.usage?.cache_creation_input_tokens);
        entries = [{
            model: initModel,
            uncachedInputTokens: finiteNonNegative(result.usage?.input_tokens),
            cacheReadTokens: finiteNonNegative(result.usage?.cache_read_input_tokens),
            cacheCreationTokens: write,
            cacheCreation1hTokens: Math.min(write, total1h),
            outputTokens: finiteNonNegative(result.usage?.output_tokens),
        }];
    } else {
        return undefined;
    }

    const weight = (e: ModelUsageEntry): number =>
        e.uncachedInputTokens + e.cacheReadTokens + e.cacheCreationTokens + e.outputTokens;
    const primary = entries.reduce((best, e) => (weight(e) > weight(best) ? e : best));
    return { responseModel: primary.model, entries };
}

// ─── MCP config format ───────────────────────────────────────────────────────
//
// claude is never handed the agent's real MCP servers: its `--mcp-config` contains only the
// per-chat loopback bridge entries (see claudecli-tool-bridge.ts, 9ed453c1 BRIDGE).

/** Inline `--mcp-config` value for an agent that declares no MCP servers. */
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

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

// ─── built-in tool allowlist ─────────────────────────────────────────────────

/**
 * Compute the effective allowed built-in set and the `--tools` argv entries that
 * must be passed to the `claude` CLI subprocess.
 *
 * `--tools <list>` specifies the list of available tools from the built-in set;
 * `--tools ""` disables all of them. An allowlist is used (not a
 * `--disallowedTools` denylist) because the CLI's built-in surface keeps growing
 * (Workflow, Skill, ScheduleWakeup, SendMessage, Cron*, Task*, Monitor, ...) and
 * a denylist silently leaves every newer tool enabled for the agent.
 */
export function computeClaudeBuiltinArgs(params: {
    compiledTools: string[] | undefined;
    allowedBuiltinTools: string[] | undefined;
    /**
     * GOV (f9dadeaa): the engine's permission verdict per built-in (`claude-builtin.<Tool>`). A built-in
     * whose verdict is not `'allow'` is WITHHELD from `--tools` (an `ask` cannot be answered inside the
     * CLI's own loop, so it fails closed exactly like `deny`). Absent => no governance info.
     */
    builtinToolPolicy?: (tool: string) => PermissionAction;
}): { effectiveAllowed: string[]; toolsArgv: string[]; withheld: Array<{ tool: string; verdict: PermissionAction }> } {
    const requested: string[] =
        params.compiledTools !== undefined
            ? params.compiledTools
            : (params.allowedBuiltinTools ?? []);

    const withheld: Array<{ tool: string; verdict: PermissionAction }> = [];
    const effectiveAllowed = requested.filter((tool) => {
        const verdict = params.builtinToolPolicy?.(tool) ?? "allow";
        if (verdict === "allow") return true;
        withheld.push({ tool, verdict });
        return false;
    });

    return { effectiveAllowed, toolsArgv: ["--tools", effectiveAllowed.join(",")], withheld };
}

/**
 * The CLI built-ins the agent-spec path can grant through the spec's own `tools:` header (which the
 * engine cannot read), plus an unlisted probe name so a wildcard rule (`'*'`, `'claude-builtin.*'`)
 * is noticed even for a built-in newer than this list.
 */
export const KNOWN_CLAUDE_BUILTINS: readonly string[] = [
    "Bash", "Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch",
    "Task", "TodoWrite", "Skill", "Workflow", "SendMessage", "Monitor", "__unlisted_builtin__",
];

/**
 * GOV (f9dadeaa): in agent-spec mode the engine cannot constrain the built-in set (`--tools` is
 * not passed; the spec header governs), so a gate that would deny/ask ANY built-in cannot be honored.
 * Returns the offending built-ins; the provider refuses to spawn rather than silently ignoring the gate.
 */
export function specModeGovernanceViolations(params: {
    requested: readonly string[];
    builtinToolPolicy?: (tool: string) => PermissionAction;
}): Array<{ tool: string; verdict: PermissionAction }> {
    if (!params.builtinToolPolicy) return [];
    const out: Array<{ tool: string; verdict: PermissionAction }> = [];
    for (const tool of new Set([...KNOWN_CLAUDE_BUILTINS, ...params.requested])) {
        const verdict = params.builtinToolPolicy(tool);
        if (verdict !== "allow") out.push({ tool, verdict });
    }
    return out;
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

// ─── subprocess env hygiene ──────────────────────────────────────────────────

/**
 * Env vars that identify an *enclosing* Claude Code session. When the engine
 * spawns its own `claude` child from inside an interactive Claude Code session
 * (or from another agent-mcp task), these leak through `process.env` into the
 * nested `claude -p` invocation. The nested CLI then believes it is already
 * running inside a session — it can refuse to run, mis-attribute its session,
 * or wedge (anthropics/claude-code#25803, #29543). They are stripped
 * unconditionally, regardless of what `config.subprocessEnv()` returns.
 *
 * See DEBT-SOX-009 (nested-claude crash semantics) — this is the same hazard
 * observed as a session-kill incident during agent-mcp diagnosis.
 *
 * Deliberately NOT stripped: `CLAUDE_CONFIG_DIR` (carries the child's auth),
 * `ANTHROPIC_*` (the child may legitimately use an API key or auth token), and
 * `ADHD_AGENT_*` (the harness's own declared pass-through vars, see
 * `EngineConfig.subprocessEnv`).
 */
const CLAUDE_SESSION_ENV_DENYLIST: ReadonlySet<string> = new Set([
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_SESSION_ID",
]);

/**
 * Strip every `CLAUDE_SESSION_ENV_DENYLIST` key from an env map, returning a new
 * map. Exported for direct unit-testing and reuse by hosts that build the
 * subprocess env themselves.
 */
export function stripClaudeSessionEnv(
    env: Record<string, string | undefined>
): Record<string, string> {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) continue;
        if (CLAUDE_SESSION_ENV_DENYLIST.has(k)) continue;
        cleaned[k] = v;
    }
    return cleaned;
}

/**
 * Terminate a spawned `claude` process **and its whole process tree**.
 *
 * A bare `child.kill('SIGTERM')` signals only the direct child; the CLI's own
 * MCP servers / tool subprocesses (which share its process group) are orphaned
 * and keep running, which is one of the ways a fan-out of provider calls leaks
 * processes. On POSIX we spawn detached, so the child leads its own process
 * group and `process.kill(-pid, …)` tears the group down atomically. On
 * Windows there is no negative-pid group signal, so we fall back to the direct
 * child kill. Never throws.
 */
function terminateProcessTree(
    proc: ChildProcess,
    signal: NodeJS.Signals = "SIGTERM",
    opts: { force?: boolean } = {}
): void {
    // `signalCode` covers a child that already died from a signal (exitCode stays
    // null for those), so we never signal a reaped pid. `force` is used only by
    // the SIGKILL escalation, where the leader may already be gone but a
    // SIGTERM-ignoring grandchild in its process group is not (322a1efb AC2).
    if (!opts.force && (proc.exitCode !== null || proc.signalCode !== null)) return;
    const pid = proc.pid;
    if (process.platform !== "win32" && typeof pid === "number" && pid > 0) {
        try {
            process.kill(-pid, signal);
            return;
        } catch {
            // Group already gone, or not a group leader — fall through.
        }
    }
    if (opts.force) return;
    try {
        proc.kill(signal);
    } catch {
        // Already dead — nothing to do.
    }
}

/**
 * Bounded waits used when reaping a `claude` child after a SUCCESSFUL turn
 * (backlog 322a1efb).
 *
 * After the stream's `result` line the CLI is still flushing/cleaning its
 * session and exits on its own once stdin is closed. Signalling it at that
 * moment kills it mid-exit (and, under CPU load, beats a well-behaved child's own
 * `process.exit(0)`), so the success path waits for the child's own `exit` and
 * only falls back to the group SIGTERM -> SIGKILL ladder if it never comes.
 */
export interface ClaudeCliReapTimings {
    /** Ms to wait for the child's own exit after `result` before group SIGTERM. Default 5000. */
    exitGraceMs: number;
    /** Ms to wait after group SIGTERM before group SIGKILL. Default 2000. */
    killEscalationMs: number;
}

/** Documented defaults for {@link ClaudeCliReapTimings}. */
export const DEFAULT_CLAUDECLI_REAP_TIMINGS: ClaudeCliReapTimings = {
    exitGraceMs: 5000,
    killEscalationMs: 2000,
};

/**
 * Reap a child after a successful turn WITHOUT delaying the caller and WITHOUT
 * signalling a child that is exiting on its own: chat() has already produced its
 * result, so the wait is detached (timers are unref'd and cancelled on `exit`).
 * Ladder: own exit (grace) -> group SIGTERM -> (escalation) group SIGKILL, which
 * retains the grandchild-leak protection of {@link terminateProcessTree}.
 * Never throws.
 */
function reapAfterSuccess(proc: ChildProcess, timings: ClaudeCliReapTimings): void {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    // Keep draining so a child writing after `result` cannot block on a full pipe.
    proc.stdout?.resume();
    proc.stderr?.resume();
    let escalation: NodeJS.Timeout | undefined;
    const grace = setTimeout(() => {
        terminateProcessTree(proc, "SIGTERM");
        escalation = setTimeout(() => {
            terminateProcessTree(proc, "SIGKILL", { force: true });
        }, timings.killEscalationMs);
        escalation.unref();
    }, timings.exitGraceMs);
    grace.unref();
    proc.once("exit", () => {
        // Exited on its own inside the grace window: nothing to signal. Once the
        // SIGTERM has been sent the escalation stays armed so a SIGTERM-ignoring
        // grandchild in the group is still SIGKILLed.
        if (!escalation) clearTimeout(grace);
    });
}

// ─── provider ────────────────────────────────────────────────────────────────

/**
 * The operator-facing message for a `claude` child that failed to start (b8372f5a). Names the
 * binary and the PATH searched so a missing install is distinguishable from a logged-out CLI.
 */
export function spawnFailureMessage(err: Error, binary: string, searchPath: string | undefined): string {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
        return (
            `Claude CLI could not be started: ${err.message}. The \`${binary}\` binary was not found ` +
            `(PATH=${searchPath ?? "(unset)"}). Install Claude Code, put it on PATH, or set the provider's \`claudePath\`.`
        );
    }
    return `Claude CLI could not be started: ${err.message}${code ? ` (${code})` : ""}. Binary: \`${binary}\`.`;
}

export class ClaudeCliProvider implements LLMProvider {
    private readonly providerConfig: ClaudeCliConfig;
    private readonly compiledTools: string[] | undefined;
    private readonly logger: EngineLogger;
    private readonly config: EngineConfig;
    private readonly reapTimings: ClaudeCliReapTimings;
    private readonly startBridge: typeof startToolBridge;

    constructor(
        config: ClaudeCliConfig,
        _mcpServers: Record<string, McpServerConfig> = {},
        compiledTools?: string[],
        engineConfig?: EngineConfig,
        engineLogger?: EngineLogger,
        reapTimings?: Partial<ClaudeCliReapTimings>,
        /** Test seam: replaces the loopback bridge starter so unit tests bind no port. */
        deps?: { startToolBridge?: typeof startToolBridge }
    ) {
        this.startBridge = deps?.startToolBridge ?? startToolBridge;
        this.reapTimings = { ...DEFAULT_CLAUDECLI_REAP_TIMINGS, ...reapTimings };
        this.providerConfig = config;
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
        // Worker agents get a lean prompt: do not inject the operator's
        // CLAUDE.md files or auto-memory into every task (measured -8k input
        // tokens per `-p` run, ~53%). An explicit value (process env or host
        // subprocessEnv) wins so an agent that needs them can opt back in.
        for (const k of ["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"]) {
            if (result[k] === undefined) result[k] = "1";
        }
        // Strip the enclosing Claude Code session's identity vars LAST, so a
        // host that (incorrectly) re-exports one via subprocessEnv() cannot
        // re-introduce it. See CLAUDE_SESSION_ENV_DENYLIST.
        return stripClaudeSessionEnv(result);
    }

    /**
     * Writes the bridge's http entries (one per advertised server) to a 0600 temp file. Returns
     * `undefined` when no bridge was started; `chat` then passes `EMPTY_MCP_CONFIG` inline so that,
     * paired with `--strict-mcp-config`, the spawned CLI never inherits the operator's own MCP set
     * (which includes agent-mcp itself, a ~30 s CONNECT_TIMEOUT recursion).
     *
     * The real servers' command/env/headers are NOT written: the engine's registry client is the
     * single owner of server launch (cwd, env, srt), so the only credential on disk is the
     * per-chat loopback bearer token (c536ce29 FIX-M3: owner-only).
     */
    private async writeMcpConfigFile(bridge: ToolBridge | undefined): Promise<string | undefined> {
        if (!bridge || bridge.serverNames.length === 0) return undefined;
        const mapped = buildBridgeMcpConfig(bridge).mcpServers;
        const filePath = join(await this.ensureTempRoot(), `agent-mcp-claudecli-${Date.now()}-${generateId()}.json`);
        await writeFile(filePath, JSON.stringify({ mcpServers: mapped }), { encoding: "utf8", mode: 0o600 });
        return filePath;
    }

    /**
     * The `--setting-sources` value for a non-spec worker, or `undefined` to leave the CLI default
     * (user + project + local). Default `project`: the operator's USER settings carry their plugins,
     * skills, agents and hooks, which the CLI lists into the first request of EVERY task (measured
     * -953 input tokens per turn, 2329 -> 1376 for a shell-only agent; 9ed453c1 CTX) and which a
     * worker with its own `--system-prompt` never asked for. Opt back in with the provider option
     * `settingSources` (`"inherit"` restores the CLI default; otherwise a comma list of
     * user|project|local, or an array) or `ADHD_AGENT_CLAUDECLI_SETTING_SOURCES`.
     */
    private settingSources(): string | undefined {
        const opt = (this.providerConfig as { settingSources?: unknown }).settingSources;
        let fromOpt: string | undefined;
        if (Array.isArray(opt)) fromOpt = opt.join(",");
        else if (typeof opt === "string") fromOpt = opt;
        const raw = fromOpt
            ?? process.env["ADHD_AGENT_CLAUDECLI_SETTING_SOURCES"]
            ?? this.config.subprocessEnv?.()["ADHD_AGENT_CLAUDECLI_SETTING_SOURCES"]
            ?? "project";
        return raw.trim() === "inherit" ? undefined : raw.trim();
    }

    /** Whether to retain the spawned CLI's session transcript (default: no). */
    private keepSessionTranscript(): boolean {
        const opt = (this.providerConfig as { keepSessionTranscript?: unknown }).keepSessionTranscript;
        if (typeof opt === "boolean") return opt;
        const env = process.env["ADHD_AGENT_CLAUDECLI_KEEP_SESSION_TRANSCRIPT"]
            ?? this.config.subprocessEnv?.()["ADHD_AGENT_CLAUDECLI_KEEP_SESSION_TRANSCRIPT"];
        return env === "1" || env === "true";
    }

    /**
     * The directory for credential-bearing scratch (mcp-config, agent-spec). The host injects its
     * `@adhd/environment`-resolved namespaced temp root as `config.wire.tempDir` (c536ce29 / 03be90c3,
     * S8B). There is NO OS-tmpdir fallback: an `EngineConfig` without `wire.tempDir` makes this throw,
     * so every host must build its config through the wire seams (c536ce29 FIX-M2). Created on demand
     * because the resolver is pure and creates nothing; the directory is owner-only (0o700) because it
     * holds credential-bearing files, and a pre-existing looser directory is tightened (FIX-M3).
     */
    private async ensureTempRoot(): Promise<string> {
        const root = this.config.wire?.tempDir;
        if (!root) {
            throw new Error(
                "claudecli provider requires EngineConfig.wire.tempDir (the host's namespaced temp root); there is no OS-tmpdir fallback"
            );
        }
        await mkdir(root, { recursive: true, mode: 0o700 });
        // `mkdir` applies `mode` only to directories it creates (and the umask can narrow it): tighten
        // a pre-existing root that is group/world accessible.
        if (((await stat(root)).mode & 0o077) !== 0) await chmod(root, 0o700);
        return root;
    }

    private async writeAgentSpecDir(md: string): Promise<{ dir: string; agentName: string }> {
        const { content, agentName } = normalizeAgentSpec(md);
        const dir = await mkdtemp(join(await this.ensureTempRoot(), "agent-mcp-spec-"));
        const agentsDir = join(dir, ".claude", "agents");
        await mkdir(agentsDir, { recursive: true, mode: 0o700 });
        const safeFile = `${agentName.replace(/[^a-zA-Z0-9_-]/g, "_") || "agent"}.md`;
        await writeFile(join(agentsDir, safeFile), content, { encoding: "utf8", mode: 0o600 });
        return { dir, agentName };
    }

    /** Agent-spec mode cannot honor a gate that denies/asks any built-in: refuse to spawn (GOV f9dadeaa). */
    private assertSpecModeGovernable(request: ProviderChatRequest): void {
        const hasSystem = request.messages.some((m) => m.role === "system" && (m.content ?? "") !== "");
        if (!(this.providerConfig.systemPromptIsAgentSpec === true && hasSystem)) return;
        const violations = specModeGovernanceViolations({
            requested: this.providerConfig.allowedBuiltinTools ?? [],
            builtinToolPolicy: request.builtinToolPolicy,
        });
        if (violations.length === 0) return;
        throw new Error(
            "PROVIDER_ERROR: claudecli refuses to spawn in agent-spec mode (systemPromptIsAgentSpec): the permission gate " +
            `does not allow the CLI built-in(s) ${violations.map((v) => `${v.tool}=${v.verdict}`).join(", ")}, ` +
            "but the spec's `tools:` header (not the engine) decides which built-ins the CLI exposes, so the gate cannot be enforced. " +
            "Use a non-spec claudecli agent with allowedBuiltinTools, or relax the claude-builtin.* permission rules."
        );
    }

    async chat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
        // Exactly-once tool execution (9ed453c1 BRIDGE): claude reaches the agent's MCP tools ONLY
        // through a per-chat loopback bridge whose tools/call is `request.executeTool` (the engine's
        // registry client). Advertised tools with nothing to execute them is a wiring defect: fail
        // loud rather than hand the model tools that can only error.
        // Engine-internal pseudo-tools (`builtin__*`, e.g. request_human_input) are not MCP tools and
        // were never visible to claude; only real MCP-server tools go through the bridge.
        const advertised = bridgeableTools(request.tools ?? []);
        // GOV (f9dadeaa): fail closed BEFORE any bridge/credential file exists.
        this.assertSpecModeGovernable(request);
        if (advertised.length > 0 && !request.executeTool) {
            throw new Error(
                "PROVIDER_ERROR: claudecli was given MCP tools but no executeTool callback; refusing to expose tools it cannot execute"
            );
        }
        const bridge = advertised.length > 0 && request.executeTool
            ? await this.startBridge({
                tools: advertised,
                executeTool: request.executeTool,
                signal: request.signal,
                logger: this.logger,
                callTimeoutMs: this.providerConfig.timeoutMs,
            })
            : undefined;
        try {
            return await this.chatWithBridge(request, bridge);
        } finally {
            await bridge?.close();
        }
    }

    private async chatWithBridge(request: ProviderChatRequest, bridge: ToolBridge | undefined): Promise<ProviderChatResponse> {
        const claudePath = this.providerConfig.claudePath ?? "claude";

        const systemMessages = request.messages.filter(m => m.role === "system");
        const systemPrompt = systemMessages.map(m => m.content ?? "").join("\n") || undefined;
        const userMessage = buildUserMessage(request.messages);

        const mcpConfigPath = await this.writeMcpConfigFile(bridge);

        const specMode = this.providerConfig.systemPromptIsAgentSpec === true && !!systemPrompt;
        let agentSpecDir: string | undefined;
        let agentSpecName: string | undefined;
        if (specMode && systemPrompt) {
            const written = await this.writeAgentSpecDir(systemPrompt);
            agentSpecDir = written.dir;
            agentSpecName = written.agentName;
        }

        const { toolsArgv, withheld } = computeClaudeBuiltinArgs({
            compiledTools: this.compiledTools,
            allowedBuiltinTools: this.providerConfig.allowedBuiltinTools,
            builtinToolPolicy: request.builtinToolPolicy,
        });
        if (withheld.length > 0) {
            this.logger.warn(
                { withheld },
                "claudecli: built-in tool(s) withheld from --tools by the permission gate (deny/ask both fail closed)",
            );
        }

        // `--dangerously-skip-permissions` stays: headless `-p` has no one to answer a CLI permission
        // prompt, and the bridged MCP tools would be refused without it. What bounds the CLI is NOT its
        // permission mode but (a) `--tools <allowlist>` (only gate-allowed built-ins exist at all),
        // (b) `--strict-mcp-config` + the loopback bridge (the ONLY MCP route, governed per call by the
        // engine's governToolCall), and (c) the agent-spec refusal above. See README "Governance".
        const args: string[] = [
            "-p",
            "--dangerously-skip-permissions",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            "--strict-mcp-config",
            "--mcp-config", mcpConfigPath ?? EMPTY_MCP_CONFIG,
        ];

        // Task transcripts are throwaway by default (each is a 200 KB+ JSONL in
        // ~/.claude/projects). Opt in to keep them for diagnosis via the
        // `keepSessionTranscript` provider option or
        // ADHD_AGENT_CLAUDECLI_KEEP_SESSION_TRANSCRIPT=1.
        if (!this.keepSessionTranscript()) args.push("--no-session-persistence");

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
            args.push(...toolsArgv);
            const settingSources = this.settingSources();
            if (settingSources !== undefined) args.push("--setting-sources", settingSources);
            if (systemPrompt) args.push("--system-prompt", systemPrompt);
        }

        if (this.providerConfig.model)   args.push("--model", this.providerConfig.model);

        const subEnv = this.buildSubprocessEnv();

        const proc = wireSpawn(this.config)(claudePath, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: subEnv,
            // ADR-0008 D9 / NAT-TOOL-3: run `claude` in the task-time dispatching
            // cwd (its built-in tools need it). MCP tools no longer inherit this cwd: claude
            // launches no MCP children (9ed453c1 BRIDGE) — per-server cwd/env/srt come solely
            // from the engine registry client that `executeTool` drives. `undefined` -> claude
            // inherits the parent process cwd.
            cwd: this.config.cwd,
            // Own process group (POSIX) so terminateProcessTree can signal the
            // CLI *and* every subprocess it spawned (MCP servers, tools).
            detached: process.platform !== "win32",
        });

        if (!proc.stdout) throw new Error('stdout not available');
        if (!proc.stdin) throw new Error('stdin not available');

        const rl = readline.createInterface({
            input: proc.stdout,
            crlfDelay: Infinity,
        });

        const onAbort = (): void => { terminateProcessTree(proc); };
        // True only once a `result` was received and validated; error/abort paths
        // leave it false and keep the immediate group SIGTERM (322a1efb AC3).
        let cleanTurn = false;
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
            let finalUsage: ClaudeStreamResultEvent["usage"];
            let finalStopReason: string | undefined;
            let finalNumTurns: number | undefined;
            let finalResultEvent: ClaudeStreamResultEvent | undefined;
            let initModel: string | undefined;
            // tool_use blocks the CLI emitted (built-ins run by the CLI; mcp__ tools run once by the
            // engine via the loopback bridge). Usage-accounting only: NEVER surfaced as message.toolCalls,
            // which the orchestrator would re-execute.
            let toolUseCount = 0;
            // Largest single-turn context seen on the stream (7ead5eaa BK4): result.usage is a SUM over turns.
            let peakTurnContext = 0;

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
                    finalUsage = r.usage;
                    finalStopReason = r.stop_reason;
                    finalNumTurns = typeof r.num_turns === "number" && r.num_turns >= 1 ? r.num_turns : undefined;
                    finalResultEvent = r;
                    break;
                }

                if (event.type === "system" && (event as ClaudeStreamInitEvent).subtype === "init") {
                    const m = (event as ClaudeStreamInitEvent).model;
                    if (typeof m === "string" && m.length > 0) initModel = m;
                    continue;
                }

                if (event.type === "assistant") {
                    const assistantEvent = event as ClaudeStreamAssistantEvent;
                    const toolUseBlocks = (assistantEvent.message?.content ?? []).filter(
                        (b): b is ClaudeToolUseBlock => b.type === "tool_use"
                    );

                    toolUseCount += toolUseBlocks.length;
                    peakTurnContext = Math.max(peakTurnContext, assistantTurnContextTokens(assistantEvent));

                    // claude runs these through the loopback bridge (engine executeTool); the loop
                    // only counts them. It never writes a tool_result back to claude's stdin.
                }
            }

            proc.stdin.end();

            // A spawn failure (binary missing from PATH -> ENOENT, not executable -> EACCES) emits
            // `error` and closes stdout without a single line, so the in-loop check above never runs.
            // Report it as what it is rather than as the empty-result auth error below (b8372f5a).
            if (!finalResult && procError) {
                throw new ToolError(
                    "PROVIDER_ERROR",
                    spawnFailureMessage(procError, claudePath, subEnv["PATH"] ?? process.env["PATH"]),
                    { spawnErrorCode: (procError as NodeJS.ErrnoException).code }
                );
            }

            if (!finalResult) {
                throw new ToolError(
                    "PROVIDER_AUTH_ERROR",
                    "Claude CLI returned empty result. " +
                    "Ensure `claude auth status` shows a valid login. " +
                    "To use the Anthropic API instead, set ADHD_AGENT_ANTHROPIC_SECRET in your ~/.adhd/.env."
                );
            }

            // Success path reached: the child is exiting on its own (stdin closed).
            cleanTurn = true;

            const message: Message = {
                id: generateId(),
                sessionId: "",
                role: "assistant",
                content: finalResult,
                createdAt: nowIso(),
            };

            const normalisedStopReason = CLI_STOP_REASON[finalStopReason ?? ""] ?? "unknown";

            // Resolve the concrete model from what the CLI reports (79aebb26 BK8): `--model haiku`
            // is an alias that moves (claude-haiku-5-5 in the recorded fixture), so cost must be
            // priced against the RESOLVED id, per `modelUsage` key. Unresolvable -> left unset and
            // the configured model is used downstream.
            const resolved = finalResultEvent ? resolveCliModelUsage(finalResultEvent, initModel) : undefined;
            const cliCost = finalResultEvent?.total_cost_usd;
            const baseUsage = finalUsage
                ? normaliseAnthropicUsage(
                    finalUsage,
                    normalisedStopReason,
                    this.config.server?.defaultMaxTokens ?? 0
                )
                : undefined;
            const usage = baseUsage && (resolved || typeof cliCost === "number" || peakTurnContext > 0)
                ? {
                    ...baseUsage,
                    ...(resolved ? { modelBreakdown: resolved.entries } : {}),
                    ...(peakTurnContext > 0 ? { peakContextTokens: peakTurnContext } : {}),
                    ...(typeof cliCost === "number" && Number.isFinite(cliCost) ? { cliReportedCostUsd: cliCost } : {}),
                }
                : baseUsage;

            return {
                message,
                stopReason: "completed",
                rawUsage: finalUsage,
                reportedToolUses: toolUseCount,
                reportedModelCalls: finalNumTurns,
                ...(resolved ? { responseModel: resolved.responseModel } : {}),
                usage,
            };
        } finally {
            request.signal?.removeEventListener("abort", onAbort);
            rl.close();
            // Group-aware teardown: a bare proc.kill() would orphan the CLI's
            // own MCP-server/tool subprocesses. See terminateProcessTree.
            // Success: let the child exit on its own (bounded grace, detached --
            // chat() is not delayed); error/abort: terminate immediately.
            if (cleanTurn) reapAfterSuccess(proc, this.reapTimings);
            else terminateProcessTree(proc);
            if (mcpConfigPath) {
                unlink(mcpConfigPath).catch(() => { /* best-effort */ });
            }
            if (agentSpecDir) {
                rm(agentSpecDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
            }
        }
    }
}
