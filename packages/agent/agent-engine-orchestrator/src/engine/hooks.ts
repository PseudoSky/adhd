import type {
  HookEvent,
  HookEventMap,
  HookHandler,
  IHookRegistry,
  EnforcementEvent,
  EnforcementHandler,
} from '@adhd/agent-base-types';

export class HookRegistry implements IHookRegistry {
  private readonly handlers = new Map<HookEvent, HookHandler<HookEvent>[]>();
  private readonly enforcementHandlers = new Map<
    EnforcementEvent,
    EnforcementHandler<EnforcementEvent>[]
  >();

  register<E extends HookEvent>(event: E, handler: HookHandler<E>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as HookHandler<HookEvent>);
    this.handlers.set(event, list);
  }

  async emit<E extends HookEvent>(
    event: E,
    payload: HookEventMap[E]
  ): Promise<void> {
    const list = this.handlers.get(event);
    if (!list?.length) return;
    for (const handler of list) {
      try {
        await (handler as HookHandler<E>)(payload);
      } catch (err) {
        console.warn('[HookRegistry] hook handler error (swallowed)', {
          event,
          err,
        });
      }
    }
  }

  registerEnforcement<E extends EnforcementEvent>(
    event: E,
    handler: EnforcementHandler<E>
  ): void {
    const list = this.enforcementHandlers.get(event) ?? [];
    list.push(handler as EnforcementHandler<EnforcementEvent>);
    this.enforcementHandlers.set(event, list);
  }

  async enforce<E extends EnforcementEvent>(
    event: E,
    payload: HookEventMap[E]
  ): Promise<void> {
    const list = this.enforcementHandlers.get(event);
    if (!list?.length) return;
    for (const handler of list) {
      await (handler as EnforcementHandler<E>)(payload);
    }
  }
}
