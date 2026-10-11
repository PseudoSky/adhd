/**
 * claudecli built-in bypass disclosure (e0d71436-943e-4072-b210-a728cff402fe, G4).
 *
 * The `claude` CLI runs its built-in tools (Bash/Read/Edit/Write/...) INSIDE its own process. The engine
 * only supplies a permission verdict per built-in (`claude-builtin.<Tool>`); everything else the engine
 * applies to a tool call it executes itself is skipped for a built-in. Built-ins are default-deny
 * (`--tools ""`), so this only concerns an agent that opted in. This module builds the structured
 * `provider:builtin_bypass` warning that names exactly which built-ins are live and what they skip.
 */

import type { ProviderBuiltinBypassSource } from "@adhd/agent-base-types";

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

/** Where the enabled built-in set came from. One definition, shared with the `provider:builtin_bypass` hook payload. */
export type BuiltinBypassSource = ProviderBuiltinBypassSource;

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

const unquote = (t: string): string => t.trim().replace(/^["']|["']$/g, "");

/**
 * Parse the top-level `tools:` key out of an agent-spec's YAML front matter. `undefined` when there is no
 * header (the CLI then inherits its full built-in set). Understands the inline forms (`tools: A, B`,
 * `tools: [A, "B"]`) and the block form (`tools:` followed by `- A` lines). `[]` means the header is
 * explicitly empty (`tools: []` / `tools: ""`), i.e. no built-ins.
 *
 * The key must start in column 0, so an indented `tools:` inside a block scalar or a nested map is never
 * mistaken for the header (e0d71436 review-L6).
 */
export function parseSpecToolsHeader(md: string): string[] | undefined {
    const text = md.charCodeAt(0) === 0xfeff ? md.slice(1) : md;
    const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!block) return undefined;
    const lines = block[1].split(/\r?\n/);
    const at = lines.findIndex((l) => /^tools:(?:[ \t]|$)/.test(l));
    if (at === -1) return undefined;
    const inline = lines[at].replace(/^tools:[ \t]*/, "").replace(/[ \t]+#.*$/, "").trim();
    if (inline !== "") {
        return inline
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map(unquote)
            .filter((t) => t !== "");
    }
    // Block form: indented `- item` lines (blank/comment lines allowed between) until the next key.
    const items: string[] = [];
    for (const l of lines.slice(at + 1)) {
        if (/^[ \t]*(?:#.*)?$/.test(l)) continue;
        const item = /^[ \t]*-[ \t]+(.*?)[ \t]*$/.exec(l);
        if (!item) break;
        const name = unquote(item[1].replace(/[ \t]+#.*$/, ""));
        if (name !== "") items.push(name);
    }
    // A bare `tools:` with no items is YAML null, not an explicit empty list: treat it as an absent header
    // (inherit everything) so the disclosure errs on the side of warning.
    return items.length > 0 ? items : undefined;
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
