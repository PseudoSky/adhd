/**
 * claudecli built-in bypass disclosure (e0d71436-943e-4072-b210-a728cff402fe, G4).
 *
 * The `claude` CLI runs its built-in tools (Bash/Read/Edit/Write/...) INSIDE its own process. The engine
 * only supplies a permission verdict per built-in (`claude-builtin.<Tool>`); everything else the engine
 * applies to a tool call it executes itself is skipped for a built-in. Built-ins are default-deny
 * (`--tools ""`), so this only concerns an agent that opted in. This module builds the structured
 * `provider:builtin_bypass` warning that names exactly which built-ins are live and what they skip.
 */

/** Event name of the warning (also the `logger.warn` message prefix). */
export const BUILTIN_BYPASS_EVENT = "provider:builtin_bypass" as const;

/** Engine behaviours that a CLI built-in tool call does NOT receive. */
export const BUILTIN_SKIPPED_BEHAVIOURS: readonly string[] = [
    "hooks (pre/post:tool_call, incl. the EOL/CRLF-preserving fs hook)",
    "argument coercion",
    "tool-result size cap",
    "token estimator",
    "tool-call concurrency pool",
];

/** Where the enabled built-in set came from. */
export type BuiltinBypassSource = "allowedBuiltinTools" | "compiledTools" | "agent-spec";

/** The structured `provider:builtin_bypass` payload. */
export interface IBuiltinBypassEvent {
    event: typeof BUILTIN_BYPASS_EVENT;
    source: BuiltinBypassSource;
    /**
     * Built-ins the CLI will expose. In `agent-spec` mode the spec's own `tools:` header decides: the listed
     * names, or `['*']` when the header is absent (the CLI then inherits its full built-in set).
     */
    builtins: string[];
    /** Engine behaviours these built-ins skip. */
    skipped: string[];
    /** Recommended path. */
    advice: string;
}

/** Parse the `tools:` line out of an agent-spec's YAML front matter. `undefined` when there is no header. */
export function parseSpecToolsHeader(md: string): string[] | undefined {
    const text = md.charCodeAt(0) === 0xfeff ? md.slice(1) : md;
    const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!block) return undefined;
    const line = /^[ \t]*tools:[ \t]*(.*?)[ \t]*$/m.exec(block[1]);
    if (!line) return undefined;
    return line[1]
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter((t) => t !== "");
}

/**
 * Build the bypass warning, or `undefined` when no built-in is live (the default-deny case).
 *
 * `effectiveAllowed` is the post-gate set (`computeClaudeBuiltinArgs().effectiveAllowed`), so a built-in
 * withheld by a non-allow verdict is never listed. For the agent-spec path pass `specMd` instead.
 */
export function buildBuiltinBypassEvent(params: {
    effectiveAllowed: readonly string[];
    fromCompiledTools: boolean;
    specMd?: string;
}): IBuiltinBypassEvent | undefined {
    const advice = "Route file work through the bridged `fs__*` tools, which receive all of the above.";
    if (params.specMd !== undefined) {
        const header = parseSpecToolsHeader(params.specMd);
        if (header?.length === 0) return undefined;
        return {
            event: BUILTIN_BYPASS_EVENT,
            source: "agent-spec",
            builtins: header ?? ["*"],
            skipped: [...BUILTIN_SKIPPED_BEHAVIOURS],
            advice,
        };
    }
    if (params.effectiveAllowed.length === 0) return undefined;
    return {
        event: BUILTIN_BYPASS_EVENT,
        source: params.fromCompiledTools ? "compiledTools" : "allowedBuiltinTools",
        builtins: [...params.effectiveAllowed],
        skipped: [...BUILTIN_SKIPPED_BEHAVIOURS],
        advice,
    };
}
