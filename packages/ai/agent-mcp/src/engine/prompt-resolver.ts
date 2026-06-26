/**
 * prompt-resolver — resolves a compiled system-prompt for a session start.
 *
 * Flow:
 *  1. Compute context_hash from (agentSlug, platform, context).
 *  2. Look up agent-mcp's own composed_prompts cache via ComposedPromptStore.
 *  3. HIT  → return {content, id} WITHOUT calling compileAgent.
 *  4. MISS → call compileAgent(…), upsert the row, return {content, id}.
 *
 * compileAgent is injected as a parameter (compileAgentFn) so tests can stub it
 * without modifying production code.  Production callers pass the real
 * `compileAgent` from @adhd/agent-compiler.
 *
 * [compiler-integration.1] — imports compileAgent from @adhd/agent-compiler
 * [compiler-integration.2] — caches/looks up the composed prompt and writes composed_prompt_id
 */

import { createHash } from "node:crypto";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type { CompileInput, CompiledAgent } from "@adhd/agent-compiler";
import type { ComposedPromptStore } from "../store/composed-prompt-store.js";
import { logger } from "../logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResolveInput {
    /** Slug (name) of the agent to resolve. */
    agentSlug: string;
    /** Target platform id (e.g. "claude_code", "claude_api"). */
    platform: string;
    /** Runtime context key/value map (e.g. `{ ticket_type: "security" }`). */
    context?: Record<string, string>;
}

export interface ResolveResult {
    /** Flat system-prompt string produced by compileAgent() or served from cache. */
    content: string;
    /** Row id in agent-mcp's composed_prompts table — written to sessions.composed_prompt_id. */
    id: string;
}

/**
 * Injectable compile function — matches the signature of
 * `compileAgent` from @adhd/agent-compiler so tests can stub it.
 */
export type CompileAgentFn = (input: CompileInput) => CompiledAgent;

export interface PromptResolverDeps {
    /** Agent-mcp's own composed_prompts cache store. */
    composedPromptStore: ComposedPromptStore;
    /**
     * The compileAgent function from @adhd/agent-compiler.
     * Injectable so tests can stub without touching production code.
     */
    compileAgentFn: CompileAgentFn;
    /**
     * Registry DB handle passed through to compileAgent on cache MISS.
     * Must point at the agent-registry SQLite file (all four table prefixes).
     * Unused on a cache HIT.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registryDb: BetterSQLite3Database<any>;
}

// ── Context hash ─────────────────────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 cache key from (agentSlug, platform, context).
 *
 * The key encodes every runtime dimension that could produce a different compiled
 * artifact: the agent identity, the target platform, and any runtime context
 * key/value pairs.  Keys in `context` are sorted before serialisation so that
 * insertion order cannot produce different hashes for identical logical inputs.
 *
 * @returns 64-character lowercase hex SHA-256 string.
 */
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

// ── Public resolver ──────────────────────────────────────────────────────────

/**
 * Resolve the compiled system-prompt for a session start.
 *
 * On a cache HIT (agent-mcp's `composed_prompts` already has a row for this
 * agent + context hash) the cached `{content, id}` is returned WITHOUT calling
 * compileAgent — the registry round-trip is skipped entirely.
 *
 * On a cache MISS, compileAgent is called with the supplied `registryDb` handle.
 * The result is upserted into agent-mcp's `composed_prompts` table and the
 * returned `id` is suitable for writing to `sessions.composed_prompt_id`.
 *
 * **Flat-prompt fallback (backward compatibility):** when `compileAgentFn`
 * throws (e.g. the agent has no registry composition — `AgentError` with code
 * `AGENT_NOT_FOUND`, or a `CompositionError`) this function returns `null`
 * instead of propagating.  The caller (`agentTool`) then falls back to the
 * stored `agentDefinition.systemPrompt`, so a legacy flat-`systemPrompt` agent
 * continues to work even when a live registry DB is wired.
 *
 * @param input - Agent slug, target platform, and optional runtime context.
 * @param deps  - Injected ComposedPromptStore, compileAgentFn, and registry DB.
 * @returns {content, id} on success, or `null` when no registry composition
 *   exists for the agent (caller must fall back to the flat systemPrompt).
 */
export function resolveComposedPrompt(
    input: ResolveInput,
    deps: PromptResolverDeps
): ResolveResult | null {
    const { agentSlug, platform, context = {} } = input;
    const { composedPromptStore, compileAgentFn, registryDb } = deps;

    const contextHash = computeContextHash(agentSlug, platform, context);

    // ── Cache HIT ────────────────────────────────────────────────────────────
    const cached = composedPromptStore.findByAgentContext(agentSlug, contextHash);
    if (cached) {
        logger.debug(
            { agentSlug, composedPromptId: cached.id },
            "Composed prompt cache hit — skipping compileAgent"
        );
        return { content: cached.content, id: cached.id };
    }

    // ── Cache MISS — compile and upsert ──────────────────────────────────────
    logger.debug({ agentSlug, platform }, "Composed prompt cache miss — calling compileAgent");

    let compiled;
    try {
        compiled = compileAgentFn({
            agentSlug,
            platform,
            context,
            db: registryDb,
        });
    } catch (err) {
        // No registry composition for this agent — fall back to the stored
        // flat systemPrompt.  Log at debug level: this is expected for agents
        // that were created via agent_create without registry backing.
        logger.debug(
            { agentSlug, err },
            "compileAgent threw — no registry composition; falling back to flat systemPrompt"
        );
        return null;
    }

    const row = composedPromptStore.upsert({
        agentSlug,
        contextHash,
        content: compiled.content,
        componentVersions: JSON.stringify(compiled.componentVersions ?? {}),
    });

    logger.info(
        { agentSlug, composedPromptId: row.id },
        "Composed prompt compiled and cached"
    );

    return { content: row.content, id: row.id };
}
