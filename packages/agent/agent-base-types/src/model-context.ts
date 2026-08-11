/**
 * Model context-window registry (tokens) — the single source of truth for the
 * budget plugin's `contextWindowFraction` math (PLAN-run-control-v2 §5.4).
 *
 * Moved VERBATIM from `agent-engine-orchestrator/src/engine/context-window.ts`
 * (Packet B) so `@adhd/agent-plugin-budget` — whose peer dep is this package —
 * can resolve a model's true input window without dragging
 * `@adhd/agent-core-provider`/drizzle-orm into consumer trees. The engine
 * re-exports this module (zero public API change for engine consumers).
 */

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
