import type { HookEvent, HookEventMap, HookHandler, IHookRegistry } from "@adhd/agent-mcp-types";
import { logger } from "../logger.js";

export class HookRegistry implements IHookRegistry {
  private readonly handlers = new Map<HookEvent, HookHandler<HookEvent>[]>();

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
        // Phase 1: all hooks are observational. Errors are logged and swallowed so a
        // buggy plugin never kills a task. Intercepting semantics (pre:tool_call blocking,
        // pre:model_request mutation) are Phase 2.
        logger.warn({ event, err }, "hook handler error (swallowed)");
      }
    }
  }
}
