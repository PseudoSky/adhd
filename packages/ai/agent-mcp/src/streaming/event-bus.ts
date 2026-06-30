import { EventEmitter } from "node:events";

export type TaskStreamEvent =
    | { type: "token";         taskId: string; chunk: string }
    | { type: "tool_call";     taskId: string; toolName: string; toolCallId: string; input: unknown }
    | { type: "tool_result";   taskId: string; toolCallId: string; content: unknown }
    | { type: "status_change"; taskId: string; status: string }
    | { type: "done";          taskId: string; result: string | null; error: string | null };

const emitter = new EventEmitter();
emitter.setMaxListeners(500); // many concurrent SSE connections

export function emitTaskEvent(event: TaskStreamEvent): void {
    emitter.emit(`task:${event.taskId}`, event);
    // Global event for task lifecycle — used by MCP notification dispatcher
    // and any other subscriber that needs to react to all task completions.
    emitter.emit("task-event", event);
}

export function subscribeToTask(
    taskId: string,
    handler: (event: TaskStreamEvent) => void,
): () => void {
    const key = `task:${taskId}`;
    emitter.on(key, handler);
    return () => emitter.off(key, handler);
}

/**
 * Subscribe to ALL task lifecycle events (across all tasks).
 * The handler receives every TaskStreamEvent for every task.
 * Returns an unsubscribe function.
 */
export function subscribeToAllTasks(
    handler: (event: TaskStreamEvent) => void,
): () => void {
    emitter.on("task-event", handler);
    return () => emitter.off("task-event", handler);
}

/**
 * Subscribe only to `done` events across all tasks.
 * Convenience wrapper around subscribeToAllTasks.
 */
export function subscribeToTaskDone(
    handler: (event: TaskStreamEvent & { type: "done" }) => void,
): () => void {
    const wrapped = (event: TaskStreamEvent) => {
        if (event.type === "done") handler(event as TaskStreamEvent & { type: "done" });
    };
    emitter.on("task-event", wrapped);
    return () => emitter.off("task-event", wrapped);
}
