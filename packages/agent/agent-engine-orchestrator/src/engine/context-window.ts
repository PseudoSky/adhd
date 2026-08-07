import type { Message } from '../validation/index.js';
import { generateId } from '../utils/ids.js';
import { nowIso } from '../utils/timestamps.js';

/**
 * Context-window management for the tool-calling loop.
 *
 * Chat APIs are stateless: the whole history is re-sent every call, and providers make
 * that affordable with PREFIX caching (an unchanged leading prefix bills at a ~50x
 * discount). The old enforcement — drop the oldest message every call — mutated that
 * prefix and forced the entire context to be re-billed at full price on every trim
 * (BUG-ORCH-008), which on one measured run was ~70% of total spend.
 *
 * The cache-preserving strategy here (mirroring Anthropic's server-side compaction and
 * OpenAI Realtime's retention_ratio) is:
 *   1. keep tool defs + system prompt as a permanently stable head,
 *   2. let history grow append-only (so the prefix is stable and caches between calls),
 *   3. only when the REAL context (provider-reported prompt_tokens) approaches the model's
 *      TRUE window, compact a large contiguous middle chunk into one summary message —
 *      ONCE, rarely, not a little every turn.
 */

/** Fraction of the true context window at which we compact. */
export const DEFAULT_COMPACTION_TRIGGER_FRACTION = 0.75;

/**
 * True input context window (tokens) per model family. Used to decide WHEN to compact.
 * Deliberately conservative — an unknown model falls back to a safe small window rather
 * than never compacting. Longest-prefix match wins.
 */
const CONTEXT_WINDOWS: [prefix: string, window: number][] = [
    ['deepseek-v4', 1_000_000],
    ['deepseek', 128_000],
    ['claude-opus-4', 200_000],
    ['claude-sonnet-4', 200_000],
    ['claude-haiku-4', 200_000],
    ['claude-fable', 200_000],
    ['claude-3', 200_000],
    ['gpt-4o', 128_000],
    ['gpt-4.1', 1_000_000],
    ['gpt-5', 400_000],
    ['o1', 200_000],
    ['o3', 200_000],
];

const FALLBACK_CONTEXT_WINDOW = 128_000;

/** Resolve a model's true input context window (tokens). */
export function contextWindowFor(model: string | undefined): number {
    if (!model) return FALLBACK_CONTEXT_WINDOW;
    let best: number | undefined;
    let bestLen = -1;
    for (const [prefix, window] of CONTEXT_WINDOWS) {
        if (model.startsWith(prefix) && prefix.length > bestLen) {
            best = window;
            bestLen = prefix.length;
        }
    }
    return best ?? FALLBACK_CONTEXT_WINDOW;
}

/**
 * Estimate a message's cost at ~4 chars/token, over its full serialized wire form —
 * content + toolCalls arguments + toolResults payload. Counting only `content` scores
 * every tool result as zero, which is the payload that actually blows up context.
 */
export function estimateMessageTokens(message: Message): number {
    let chars = message.content?.length ?? 0;
    for (const toolCall of message.toolCalls ?? []) {
        chars += JSON.stringify(toolCall.arguments ?? {}).length;
    }
    for (const toolResult of message.toolResults ?? []) {
        chars += JSON.stringify(toolResult.result ?? null).length;
    }
    return chars / 4;
}

/**
 * Group messages into atomic units that must be kept or dropped together.
 *
 * An `assistant` message bearing `toolCalls` and the `tool` messages answering it form
 * one indivisible unit: the wire format requires every `tool` message to be preceded by
 * the `assistant` message carrying the matching `tool_calls`, so splitting the pair
 * produces a provider 400 (BUG-ORCH-003).
 */
export function groupIntoAtomicUnits(messages: Message[]): Message[][] {
    const units: Message[][] = [];
    for (const message of messages) {
        const current = units[units.length - 1];
        const isToolReplyToOpenUnit =
            message.role === 'tool' &&
            current !== undefined &&
            current[0].role === 'assistant' &&
            (current[0].toolCalls?.length ?? 0) > 0;

        if (isToolReplyToOpenUnit) {
            current.push(message);
        } else {
            units.push([message]);
        }
    }
    return units;
}

export interface CompactionDecision {
    /** Should we compact before the next model call? */
    shouldCompact: boolean;
    /** The window used for the decision (tokens). */
    window: number;
    /** The trigger threshold (tokens). */
    threshold: number;
}

/**
 * Decide whether to compact, driven by the PROVIDER-REPORTED context size — the exact,
 * free ground truth in every response's `prompt_tokens` — rather than the local estimator
 * (which historically undercounted by ignoring the tools array; BUG-ORCH-006).
 *
 * `reportedContextTokens` is the last call's true input size, or undefined before the
 * first call (in which case we fall back to a local estimate of the pending messages).
 */
export function decideCompaction(
    reportedContextTokens: number | undefined,
    pendingMessages: Message[],
    model: string | undefined,
    triggerFraction: number = DEFAULT_COMPACTION_TRIGGER_FRACTION,
): CompactionDecision {
    const window = contextWindowFor(model);
    const threshold = Math.floor(window * triggerFraction);
    const realContext =
        reportedContextTokens ??
        Math.ceil(pendingMessages.reduce((n, m) => n + estimateMessageTokens(m), 0));
    return { shouldCompact: realContext > threshold, window, threshold };
}

export interface CompactMessagesOptions {
    /** Atomic units to keep verbatim at the tail (most recent turns). Default 4. */
    keepRecentUnits?: number;
    /** Don't compact if fewer than this many middle units would be folded. Default 2. */
    minUnitsToCompact?: number;
}

/**
 * Summarise a contiguous middle chunk of history into ONE synthetic message, preserving
 * the stable system-prompt head and the most-recent turns verbatim.
 *
 * `summarise` is injected so this is unit-testable without a live model, and so the
 * orchestrator can route the summary call through the same provider. If it throws, we
 * return the messages UNCHANGED (compaction is best-effort — a failed summary must never
 * drop history or crash the task; the provider's own context error is the backstop).
 *
 * Cache note: compaction changes the prefix from the summary point onward, so it MUST be
 * rare. Between compactions the head stays byte-identical and the cache survives.
 */
export async function compactMessages(
    messages: Message[],
    summarise: (toSummarise: Message[]) => Promise<string>,
    opts: CompactMessagesOptions = {},
): Promise<Message[]> {
    const keepRecentUnits = opts.keepRecentUnits ?? 4;
    const minUnitsToCompact = opts.minUnitsToCompact ?? 2;

    // Preserve all leading system messages as the stable head.
    let headEnd = 0;
    while (headEnd < messages.length && messages[headEnd].role === 'system') headEnd++;
    const head = messages.slice(0, headEnd);

    const units = groupIntoAtomicUnits(messages.slice(headEnd));
    const middleCount = units.length - keepRecentUnits;
    if (middleCount < minUnitsToCompact) {
        // Not enough to fold — leave history untouched.
        return messages;
    }

    const middle = units.slice(0, middleCount).flat();
    const tail = units.slice(middleCount).flat();

    let summaryText: string;
    try {
        summaryText = await summarise(middle);
    } catch {
        return messages; // best-effort: never lose history on a failed summary
    }

    const summaryMessage: Message = {
        id: generateId(),
        sessionId: messages[0]?.sessionId ?? '',
        role: 'user',
        content:
            `[Earlier conversation compacted to fit the context window. ` +
            `Summary of ${middle.length} prior message(s):]\n\n${summaryText}`,
        createdAt: nowIso(),
    };

    return [...head, summaryMessage, ...tail];
}
