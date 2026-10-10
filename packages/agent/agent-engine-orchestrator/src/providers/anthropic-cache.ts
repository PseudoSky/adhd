/**
 * Prompt-cache breakpoint placement for the Anthropic provider (backlog ae62e6b0 / BK3, plan
 * 9ed453c1-b113-473d-8c35-fc6dc2541306).
 *
 * Before this module the provider sent NO `cache_control`, so every turn of every agent task was
 * billed as fully uncached input. The placement rules are the binding architect verdict (Q2):
 *
 *  - AT MOST THREE explicit breakpoints (of the API's four): the last `tools` entry, the last
 *    `system` block, and the last cacheable content block of the FINAL `messages` entry (a moving
 *    breakpoint: it is re-placed on every request, so turn N+1 reads the prefix turn N wrote).
 *  - 5-minute TTL only: `{ type: "ephemeral" }` with NO `ttl` field. TTLs are never mixed. A reply
 *    that nevertheless carries `ephemeral_1h` tokens is priced by the already-shipped
 *    `cacheCreation1hTokens` path (see `normaliseAnthropicUsage`).
 *  - PER-BREAKPOINT minimum-prefix guard: a breakpoint is added only when the cumulative prefix
 *    token estimate through that point is at least {@link CACHE_GUARD_SAFETY_RATIO} (0.75) of the
 *    model's minimum cacheable size (see {@link cacheGuardThreshold}). Anthropic's prompt-caching
 *    docs state that a prompt shorter than the model minimum is simply not cached (no cache write,
 *    no write premium), so the guard's job is to avoid paying nothing for nothing, not to dodge a
 *    penalty; the cost of a MISSED breakpoint (a cacheable prefix billed fully uncached on every
 *    turn) is far larger than the cost of an unneeded one. The ratio absorbs the estimator's
 *    undercount (ebfe7421 CG, below).
 *  - Thinking / redacted-thinking blocks and empty text blocks never carry a breakpoint.
 *  - The OAuth-mandated identity system block stays FIRST and byte-for-byte unchanged: it never
 *    receives a breakpoint and is never reordered.
 *
 * Token estimation uses the repo's existing encoder (`gpt-tokenizer`, the same one the
 * orchestrator uses for tool-result telemetry). It tokenises text into FEWER tokens than Claude's
 * own tokenizer, so the estimate is a LOWER BOUND. An undercount never places a breakpoint the API
 * would refuse, but it is not free: it skips breakpoints the API would have honored.
 * That cost is large for server tools (ebfe7421): a server-tool entry (`web_search_20250305`,
 * `web_fetch_20250910`) is a ~30-token `{type,name}` stub on the wire, yet the API expands it
 * server-side into a full tool definition that counts toward the cacheable prefix. Measured on
 * claude-haiku-4-5 (agent-mcp `task`, identical agent with and without the two web tools): turn-1
 * input 6,441-6,464 tokens with them vs 4,205-4,251 without, i.e. the pair adds at least 2,190
 * real tokens while the stub JSON estimates at ~60. {@link SERVER_TOOL_TOKEN_WEIGHTS} adds that
 * measured weight back (rounded DOWN, so the estimate stays a lower bound). Prefixes that carry
 * no server tool are estimated exactly as before.
 *
 * The estimate is still a lower bound after the server-tool weights (ebfe7421 CG follow-up).
 * Three real turns of one claude-haiku-4-5 task (shell_execute + web_search_20250305 +
 * web_fetch_20250910, OAuth two-block system, 1/3/5 messages) were logged by agent-mcp with the
 * API's own `input_tokens`: 3130 / 4404 / 4714 against estimates of 2532 / 3566 / 3770, i.e. the
 * estimate is 598 / 838 / 944 tokens (19.1% / 19.0% / 20.0% of the real count; worst 20%)
 * short. The omitted weight is the fixed per-request tool overhead (~346 tokens per
 * the docs), per-message framing (~30-36 tokens per message) and gpt-tokenizer's ~1.15-1.2 ratio
 * against Claude's tokenizer on text. With the exact `>= min` gate turns 2 and 3 (real 4404 and
 * 4714, both above the 4096 minimum) were never cached. A 0.75 ratio clears the worst observed
 * undercount with margin: any prefix whose real size is at least the minimum has an estimate of at
 * least ~80% of it.
 */
import { encode } from "gpt-tokenizer";
import type {
    CacheControlEphemeral,
    ContentBlockParam,
    MessageParam,
    RedactedThinkingBlockParam,
    TextBlockParam,
    ThinkingBlockParam,
    Tool,
} from "@anthropic-ai/sdk/resources/messages";

/** Minimum cacheable prefix assumed for a model absent from {@link MIN_CACHEABLE_TOKENS}. */
export const UNKNOWN_MODEL_MIN_CACHEABLE_TOKENS = 4096;

/**
 * Minimum cacheable prefix (tokens) per model, keyed by model-id prefix (Anthropic prompt-caching
 * docs, verified 2026-10-09). Longest matching prefix wins. Shorter prompts are silently not cached.
 */
export const MIN_CACHEABLE_TOKENS: ReadonlyArray<readonly [prefix: string, minTokens: number]> = [
    ["claude-haiku-5-5", 512],
    ["claude-haiku-4-5", 4096],
    ["claude-sonnet-5", 1024],
    ["claude-sonnet-4-6", 1024],
    ["claude-opus-4-6", 4096],
    ["claude-opus-4-5", 4096],
];

/**
 * The cacheable-prefix minimum for `model`. An unknown model gets the conservative 4096 (the
 * largest minimum in any current model family), so the guard threshold for an unrecognised model
 * is never lower than for a known one.
 */
export function minCacheableTokens(model: string): number {
    let best: { len: number; min: number } | undefined;
    for (const [prefix, min] of MIN_CACHEABLE_TOKENS) {
        if (model.startsWith(prefix) && (!best || prefix.length > best.len)) {
            best = { len: prefix.length, min };
        }
    }
    return best?.min ?? UNKNOWN_MODEL_MIN_CACHEABLE_TOKENS;
}

/**
 * Fraction of the model minimum that the (lower-bound) token estimate must reach before a
 * breakpoint is placed. Calibrated from the measured worst undercount of 20% (ebfe7421 CG): a
 * prefix the API counts at >= the minimum estimates at >= ~80% of it, which clears 0.75.
 */
export const CACHE_GUARD_SAFETY_RATIO = 0.75;

/** The estimated-token threshold the guard compares against: `ceil(minCacheableTokens * 0.75)`. */
export function cacheGuardThreshold(model: string): number {
    return Math.ceil(minCacheableTokens(model) * CACHE_GUARD_SAFETY_RATIO);
}

/** The single breakpoint shape this provider ever emits: 5-minute TTL, no `ttl` field. */
function breakpoint(): CacheControlEphemeral {
    return { type: "ephemeral" };
}

type CacheableBlock = Exclude<ContentBlockParam, ThinkingBlockParam | RedactedThinkingBlockParam>;

/** A block that may carry `cache_control`: not thinking, not redacted thinking, not empty text. */
function isCacheable(block: ContentBlockParam): block is CacheableBlock {
    if (block.type === "thinking" || block.type === "redacted_thinking") return false;
    if (block.type === "text" && block.text.length === 0) return false;
    return true;
}

/**
 * Real prefix weight (tokens) the API adds for a server-executed tool, keyed by the tool's `type`
 * prefix (the version suffix changes, the definition weight does not). Measured, not guessed: the
 * web_search + web_fetch pair adds >= 2,190 tokens (see the module header), split evenly and
 * rounded down because the per-tool split was not measured separately. A server-tool type absent
 * from this table contributes 0 (the conservative lower bound: at worst a skipped breakpoint).
 */
export const SERVER_TOOL_TOKEN_WEIGHTS: ReadonlyArray<readonly [typePrefix: string, tokens: number]> = [
    ["web_search_", 1090],
    ["web_fetch_", 1090],
];

/** True for a type-tagged server-executed tool entry (anything that is not a custom `input_schema` tool). */
function serverToolType(tool: Tool): string | undefined {
    const type = (tool as { type?: unknown }).type;
    return typeof type === "string" && type !== "custom" ? type : undefined;
}

/**
 * Tokens the API adds to the prefix for the server tools in `tools`, beyond the stub JSON that
 * `JSON.stringify(tools)` already accounts for. 0 when there are none.
 */
export function serverToolTokens(tools: readonly Tool[] | undefined): number {
    let total = 0;
    for (const tool of tools ?? []) {
        const type = serverToolType(tool);
        if (type === undefined) continue;
        for (const [prefix, tokens] of SERVER_TOOL_TOKEN_WEIGHTS) {
            if (type.startsWith(prefix)) {
                total += tokens;
                break;
            }
        }
    }
    return total;
}

function countTokens(text: string): number {
    return text.length === 0 ? 0 : encode(text).length;
}

/** Model-visible text of one content block, for token estimation. */
function blockText(block: ContentBlockParam): string {
    switch (block.type) {
        case "text":
            return block.text;
        case "thinking":
            return block.thinking;
        case "tool_use":
            return `${block.name} ${JSON.stringify(block.input)}`;
        case "tool_result": {
            const c = block.content;
            if (c === undefined) return "";
            return typeof c === "string" ? c : JSON.stringify(c);
        }
        default:
            return JSON.stringify(block);
    }
}

function messageText(message: MessageParam): string {
    return typeof message.content === "string"
        ? message.content
        : message.content.map(blockText).join("\n");
}

function systemText(system: string | TextBlockParam[] | undefined): string {
    if (system === undefined) return "";
    return typeof system === "string" ? system : system.map(b => b.text).join("\n");
}

export interface CacheBreakpointInput {
    model: string;
    tools: Tool[] | undefined;
    system: string | TextBlockParam[] | undefined;
    messages: MessageParam[];
    /**
     * Number of LEADING system blocks that are protocol-mandated (the OAuth identity block) and
     * must never receive a breakpoint. Default 0.
     */
    protectedLeadingSystemBlocks?: number;
}

export interface CacheBreakpointOutput {
    tools: Tool[] | undefined;
    system: string | TextBlockParam[] | undefined;
    messages: MessageParam[];
    /** Where breakpoints were placed, in request order (tools, system, messages). */
    placed: Array<"tools" | "system" | "messages">;
}

/**
 * Returns the request pieces with `cache_control` breakpoints placed per the Q2 verdict. Pure:
 * the inputs are never mutated; unchanged pieces are returned by identity.
 */
export function applyCacheBreakpoints(input: CacheBreakpointInput): CacheBreakpointOutput {
    const { model, messages } = input;
    const min = cacheGuardThreshold(model);
    const placed: CacheBreakpointOutput["placed"] = [];
    let tools = input.tools;
    let system = input.system;
    let outMessages = messages;

    // Cumulative prefix, in the order the API renders it: tools -> system -> messages.
    const toolsTokens =
        tools && tools.length > 0 ? countTokens(JSON.stringify(tools)) + serverToolTokens(tools) : 0;
    const systemTokens = toolsTokens + countTokens(systemText(system));
    const protectedBlocks = input.protectedLeadingSystemBlocks ?? 0;

    // 1. Last tools entry.
    if (tools && tools.length > 0 && toolsTokens >= min) {
        const last = tools[tools.length - 1];
        tools = [...tools.slice(0, -1), { ...last, cache_control: breakpoint() }];
        placed.push("tools");
    }

    // 2. Last system block (never the protocol-mandated leading block).
    if (system !== undefined && systemTokens >= min) {
        if (typeof system === "string") {
            if (system.length > 0) {
                system = [{ type: "text", text: system, cache_control: breakpoint() }];
                placed.push("system");
            }
        } else if (system.length > protectedBlocks) {
            const last = system[system.length - 1];
            if (last.text.length > 0) {
                system = [...system.slice(0, -1), { ...last, cache_control: breakpoint() }];
                placed.push("system");
            }
        }
    }

    // 3. Last cacheable content block of the final messages entry (moving breakpoint).
    if (messages.length > 0) {
        const total = systemTokens + messages.reduce((n, m) => n + countTokens(messageText(m)), 0);
        if (total >= min) {
            const marked = markLastCacheableBlock(messages[messages.length - 1]);
            if (marked) {
                outMessages = [...messages.slice(0, -1), marked];
                placed.push("messages");
            }
        }
    }

    return { tools, system, messages: outMessages, placed };
}

/** A copy of `message` whose last cacheable content block carries a breakpoint; undefined if none can. */
function markLastCacheableBlock(message: MessageParam): MessageParam | undefined {
    if (typeof message.content === "string") {
        if (message.content.length === 0) return undefined;
        return {
            role: message.role,
            content: [{ type: "text", text: message.content, cache_control: breakpoint() }],
        };
    }
    for (let i = message.content.length - 1; i >= 0; i--) {
        const block = message.content[i];
        if (!isCacheable(block)) continue;
        const content = message.content.slice();
        content[i] = { ...block, cache_control: breakpoint() };
        return { role: message.role, content };
    }
    return undefined;
}
