import type { ExecutionContext, IHookRegistry, ProviderSelection } from "@adhd/agent-base-types";
import type { ProviderRegistry } from "@adhd/agent-core-provider";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { McpServerConfig } from "../validation/index.js";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCliProvider } from "./claudecli.js";
import type { IBuiltinBypassEvent } from "./claudecli-bypass.js";
import { withProviderHooks } from "./hooked-provider.js";
import { OpenAIProvider } from "./openai.js";
import {
    resolveWireModel,
    selectionToProviderConfig,
    type ClaudecliExtras,
} from "./resolve-selection.js";
import type { LLMProvider } from "./types.js";

const BYPASS_SEEN_MAX = 4096;
const bypassSeen = new WeakMap<IHookRegistry, Set<string>>();

/** True the first time this (registry, task, live built-in set) is seen; bounded so a long-lived host cannot grow it. */
function markBypassEmitted(hooks: IHookRegistry, taskId: string, event: IBuiltinBypassEvent): boolean {
    let seen = bypassSeen.get(hooks);
    if (!seen) {
        seen = new Set();
        bypassSeen.set(hooks, seen);
    }
    const key = `${taskId}|${event.source}|${event.builtins.join(",")}`;
    if (seen.has(key)) return false;
    if (seen.size >= BYPASS_SEEN_MAX) seen.delete(seen.values().next().value as string);
    seen.add(key);
    return true;
}

/**
 * Construct the LLM provider for a resolved {@link ProviderSelection}.
 *
 * `selection.modelRef` is resolved to the provider-native wire string through
 * `registry` here, at construction (a canonical slug becomes e.g.
 * `claude-sonnet-4-6`; a legacy wire string passes through). There is no
 * default branch that invents a provider: an unknown `providerType` throws.
 *
 * When `options.hooks` AND `options.executionContext` are both supplied the provider is wrapped so a
 * failed call emits `provider:failed` (c536ce29 TRC-AC25); otherwise the bare provider is returned
 * and behaviour is unchanged.
 */
export function createProvider(
    selection: ProviderSelection,
    mcpServers?: Record<string, McpServerConfig>,
    engineConfig?: EngineConfig,
    engineLogger?: EngineLogger,
    options?: {
        registry?: ProviderRegistry;
        claudecli?: ClaudecliExtras;
        hooks?: IHookRegistry;
        executionContext?: ExecutionContext;
        /**
         * claudecli only: false when this engine session can never get a second task (a one-shot dispatch), so no
         * CLI transcript is retained for it (95ee2a24 AC4). Default true.
         */
        sessionResumable?: boolean;
    }
): LLMProvider {
    const wireModel = resolveWireModel(selection, options?.registry);
    const providerConfig = selectionToProviderConfig(selection, wireModel, options?.claudecli);
    const { hooks, executionContext } = options ?? {};
    const provider = bareProvider();
    return hooks !== undefined && executionContext !== undefined
        ? withProviderHooks(provider, {
              hooks,
              executionContext,
              providerType: providerConfig.type,
              modelRef: selection.modelRef,
              wireModel: wireModel ?? selection.modelRef,
          })
        : provider;

    function bareProvider(): LLMProvider {
        switch (providerConfig.type) {
            case "anthropic":
                return new AnthropicProvider(providerConfig, engineConfig ?? {} as EngineConfig, engineLogger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger);
            case "claudecli":
                return new ClaudeCliProvider(providerConfig, mcpServers ?? {}, undefined, engineConfig, engineLogger, undefined, {
                    // b31e1fe5: tasks on one engine session share a retained CLI session (resumed, not replayed).
                    sessionKey: options?.executionContext?.sessionId || undefined,
                    sessionResumable: options?.sessionResumable,
                    // 20772a0b AC3: surface the built-in bypass as a typed `provider:builtin_bypass` hook event, which
                    // `registerTaskEventHooks` persists as a task event. Needs both a registry and a task context.
                    ...(hooks !== undefined && executionContext !== undefined && {
                        onBuiltinBypass: (event) => {
                            // Once per task (and live built-in set) even across provider instances for the same
                            // task (resume / retry rebuild the provider) - 20772a0b review-L4, e0d71436 review-M2.
                            if (!markBypassEmitted(hooks, executionContext.taskId, event)) return;
                            const { source, builtins, skipped, advice } = event;
                            hooks
                                .emit("provider:builtin_bypass", { executionContext, source, builtins, skipped, advice })
                                .catch((err: unknown) => engineLogger?.debug({ err }, "provider:builtin_bypass emit failed"));
                        },
                    }),
                });
            case "openai":
                return new OpenAIProvider(providerConfig, engineConfig ?? {} as EngineConfig);
            default: {
                const exhaustive: never = providerConfig;
                throw new Error(`Unknown provider type: ${(exhaustive as { type: string }).type}`);
            }
        }
    }
}
