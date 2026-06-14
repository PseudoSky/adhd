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
}

export function subscribeToTask(
    taskId: string,
    handler: (event: TaskStreamEvent) => void,
): () => void {
    const key = `task:${taskId}`;
    emitter.on(key, handler);
    return () => emitter.off(key, handler);
}
