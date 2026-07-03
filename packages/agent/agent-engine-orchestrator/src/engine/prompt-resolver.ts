import { createHash } from "node:crypto";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type { CompileInput, CompiledAgent } from "@adhd/agent-engine-compiler";
import { ComposedPromptStore, type ComposedPrompt } from "@adhd/agent-store-prompts";
import type { EngineLogger } from "../interfaces.js";

export interface ResolveInput {
    agentSlug: string;
    platform: string;
    context?: Record<string, string>;
}

export interface ResolveResult {
    content: string;
    /** The composed_prompts row id (number), stringified for the session column. */
    id: string;
}

export type CompileAgentFn = (input: CompileInput) => CompiledAgent;

export interface PromptResolverDeps {
    composedPromptStore: ComposedPromptStore;
    compileAgentFn: CompileAgentFn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registryDb: BetterSQLite3Database<any>;
    logger?: EngineLogger;
}

export function computeContextHash(
    agentSlug: string,
    platform: string,
    context: Record<string, string>
): string {
    const sortedContext = Object.fromEntries(
        Object.keys(context).sort().map(k => [k, context[k]] as const)
    );
    const payload = `${agentSlug}|${platform}|${JSON.stringify(sortedContext)}`;
    return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Convert a ComposedPrompt (with numeric id) to a ResolveResult (with string id).
 */
function toResolveResult(p: ComposedPrompt): ResolveResult {
    return { content: p.content, id: String(p.id) };
}

export function resolveComposedPrompt(
    input: ResolveInput,
    deps: PromptResolverDeps
): ResolveResult | null {
    const { agentSlug, platform, context = {} } = input;
    const { composedPromptStore, compileAgentFn, registryDb, logger } = deps;

    const log = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;

    const contextHash = computeContextHash(agentSlug, platform, context);

    // Cache HIT — use store-prompts lookup(agentSlug, contextHash)
    const cached = composedPromptStore.lookup(agentSlug, contextHash);
    if (cached) {
        log.debug(
            { agentSlug, composedPromptId: cached.id },
            "Composed prompt cache hit — skipping compileAgent"
        );
        return toResolveResult(cached);
    }

    log.debug({ agentSlug, platform }, "Composed prompt cache miss — calling compileAgent");

    // Cache MISS — compile and write
    let compiled;
    try {
        compiled = compileAgentFn({
            agentSlug,
            platform,
            context,
            db: registryDb,
        });
    } catch (err) {
        log.debug(
            { agentSlug, err },
            "compileAgent threw — no registry composition; falling back to flat systemPrompt"
        );
        return null;
    }

    // store-prompts expects componentVersions as Record<string, number>
    // The compiler returns a record that may be string-valued; coerce to numbers
    const cv = compiled.componentVersions ?? {};
    const numericVersions: Record<string, number> = {};
    for (const [k, v] of Object.entries(cv)) {
        numericVersions[k] = typeof v === 'number' ? v : Number(v) || 1;
    }

    const row = composedPromptStore.write({
        agentSlug,
        contextHash,
        content: compiled.content,
        componentVersions: numericVersions,
    });

    log.info(
        { agentSlug, composedPromptId: row.id },
        "Composed prompt compiled and cached"
    );

    return toResolveResult(row);
}
