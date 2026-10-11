import type { HookEventMap, IHookRegistry } from '@adhd/agent-base-types';

/** The slice of the task store the bridge needs (structurally satisfied by `TaskStore`). */
export interface ITaskEventSink {
  appendEvent(evt: {
    taskId: string;
    type: 'budget:unpriced_model' | 'provider:builtin_bypass';
    payload?: unknown;
  }): void;
}

/**
 * Persist the operator-visible warning hook events as task events (20772a0b AC2/AC3), so a caller reading
 * `task_events` can see that a model is unpriced or that CLI built-ins bypass the engine pipeline.
 *
 * The task event `type` is the hook event name; the payload is the hook payload minus its
 * `executionContext` (which is the whole task and not event data). Register once per hook registry.
 * Observational: a failing sink is logged by `HookRegistry.emit` and never fails the task.
 */
export function registerTaskEventHooks(hooks: IHookRegistry, taskStore: ITaskEventSink): void {
  const persist =
    <E extends 'budget:unpriced_model' | 'provider:builtin_bypass'>(type: E) =>
    (p: HookEventMap[E]): void => {
      const { executionContext, ...payload } = p;
      taskStore.appendEvent({ taskId: executionContext.taskId, type, payload });
    };
  hooks.register('budget:unpriced_model', persist('budget:unpriced_model'));
  hooks.register('provider:builtin_bypass', persist('provider:builtin_bypass'));
}
