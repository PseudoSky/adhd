/**
 * The tool call a dispatching tool is running under (R10 S5b).
 *
 * `client.callTool(tool, args, signal)` carries no call id, and the in-process handler receives the
 * registry's constructor-captured `ExecutionContext`, which every concurrent call on the same parent
 * shares - so the id of the model's tool call cannot ride on the context. The engine therefore runs each
 * tool call inside this scope, and `dispatch:completed` reads the id back so concurrent dispatch calls on
 * one parent are told apart exactly (never by a "only one is open" guess).
 *
 * A leaf module on purpose: both `engine/orchestrator.ts` (writer) and `tools/task.ts` (reader) import it,
 * and neither may import the other.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** The scope payload: the task making the call and the id its `pre:tool_call` / `post:tool_call` carry as `callId`. */
export interface IDispatchCallScope {
  readonly taskId: string;
  readonly callId: string;
}

const scope = new AsyncLocalStorage<IDispatchCallScope>();

/**
 * Run `fn` (and everything it awaits) inside the scope of tool call `callId` of task `taskId`.
 *
 * @param taskId - the task whose model requested the call.
 * @param callId - the tool call id the engine reports as `callId` on `pre:tool_call`.
 * @param fn - the tool invocation.
 */
export function runInToolCallScope<T>(taskId: string, callId: string, fn: () => T): T {
  return scope.run({ taskId, callId }, fn);
}

/**
 * The id of the tool call task `taskId` is executing in the current async chain, or `undefined` when the
 * chain is not inside an engine tool call of that task (a direct REST call, or a different task's call).
 *
 * @param taskId - the dispatching (parent) task.
 */
export function currentToolCallId(taskId: string): string | undefined {
  const store = scope.getStore();
  return store?.taskId === taskId ? store.callId : undefined;
}
