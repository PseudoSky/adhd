import type {
    HookEvent,
    HookEventMap,
    HookHandler,
    IHookRegistry,
    EnforcementEvent,
    EnforcementHandler,
} from "./hooks.js";

/**
 * Concrete implementation of IHookRegistry.
 *
 * Lives in @adhd/agent-mcp-types (not @adhd/agent-mcp) so plugin packages
 * can instantiate it in their own tests without creating a circular Nx
 * dependency on the full agent-mcp server package.
 *
 * Observational handlers registered via register() have their throws swallowed
 * and logged to console.warn — a buggy plugin never kills a task.
 *
 * Enforcement handlers registered via registerEnforcement() propagate throws
 * to the caller so the orchestrator can fail the task with BUDGET_EXCEEDED.
 */
export class HookRegistry implements IHookRegistry {
    private readonly handlers            = new Map<HookEvent, HookHandler<HookEvent>[]>();
    private readonly enforcementHandlers = new Map<EnforcementEvent, EnforcementHandler<EnforcementEvent>[]>();

    register<E extends HookEvent>(event: E, handler: HookHandler<E>): void {
        const list = this.handlers.get(event) ?? [];
        list.push(handler as HookHandler<HookEvent>);
        this.handlers.set(event, list);
    }

    async emit<E extends HookEvent>(event: E, payload: HookEventMap[E]): Promise<void> {
        const list = this.handlers.get(event);
        if (!list?.length) return;
        for (const handler of list) {
            try {
                await (handler as HookHandler<E>)(payload);
            } catch (err) {
                // Observational hooks: errors are logged and swallowed so a
                // buggy plugin never kills a task.
                console.warn("[HookRegistry] hook handler error (swallowed)", { event, err });
            }
        }
    }

    registerEnforcement<E extends EnforcementEvent>(event: E, handler: EnforcementHandler<E>): void {
        const list = this.enforcementHandlers.get(event) ?? [];
        list.push(handler as EnforcementHandler<EnforcementEvent>);
        this.enforcementHandlers.set(event, list);
    }

    /**
     * Run all enforcement handlers for the event serially.
     * Throws are NOT caught — they propagate to the orchestrator.
     * Call after emit() so observational handlers always fire first.
     */
    async enforce<E extends EnforcementEvent>(event: E, payload: HookEventMap[E]): Promise<void> {
        const list = this.enforcementHandlers.get(event);
        if (!list?.length) return;
        for (const handler of list) {
            await (handler as EnforcementHandler<E>)(payload);
        }
    }
}
