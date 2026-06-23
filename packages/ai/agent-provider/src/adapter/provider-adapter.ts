import type {
    Message,
    ToolDefinition,
    StreamChunk,
    ProviderAdapter as IProviderAdapter,
} from "@adhd/agent-mcp-types";

import { ModelStore } from "../store/model-store.js";

// ──────────────────────────────────────────────────────────────────────────────
// ProviderAdapter — thin implementation
//
// The class IMPLEMENTS `ProviderAdapter` (from @adhd/agent-mcp-types) — it
// does NOT re-declare the interface here.  Dependency direction:
//   agent-mcp-types ← agent-provider ← agent-mcp
//
// The stream() body is intentionally a minimal stub: the contract this state
// tests is MODEL RESOLUTION through the binding table, not live LLM streaming.
// Concrete streaming is delivered by a later plan state.
// ──────────────────────────────────────────────────────────────────────────────

export class ProviderAdapterImpl implements IProviderAdapter {
    private readonly store: ModelStore;
    private readonly platform: string;

    constructor(store: ModelStore, platform: string) {
        this.store = store;
        this.platform = platform;
    }

    /**
     * Resolve the canonical model id to a per-platform string via the binding
     * table, then yield a single informational chunk.
     *
     * The resolved id is surfaced in the first (and only) text chunk so that
     * tests can assert the correct resolution without live API calls.
     */
    async *stream(
        _messages: Message[],
        _tools: ToolDefinition[] | undefined,
        model: string
    ): AsyncIterable<StreamChunk> {
        const resolvedModelId = this.store.resolveModelId(model, this.platform);
        yield { type: "text", text: resolvedModelId };
    }

    /**
     * Expose the resolved model id without consuming the stream.
     * Convenience method for tests to assert resolution directly.
     */
    resolveModelId(canonicalId: string): string {
        return this.store.resolveModelId(canonicalId, this.platform);
    }
}
