import PQueue from "p-queue";

import { logger } from "../logger.js";

export type BackgroundTaskFn = () => Promise<void>;

/**
 * BackgroundQueue wraps p-queue to run async tasks with concurrency limiting.
 *
 * TaskStore is NOT a dependency of BackgroundQueue's constructor — it is
 * injected into each enqueue call to avoid circular dependencies. The queue
 * only knows how to run tasks; the caller controls persistence.
 */
export class BackgroundQueue {
    private readonly queue: PQueue;

    constructor(concurrency?: number) {
        const resolvedConcurrency =
            concurrency ??
            parseInt(process.env["QUEUE_CONCURRENCY"] ?? "5", 10);

        this.queue = new PQueue({ concurrency: resolvedConcurrency });
    }

    /**
     * Enqueue a background task.
     *
     * The task function is responsible for calling
     * `taskStore.updateStatus(taskId, ...)` on completion or failure.
     * The orchestrator handles this internally via try/catch/finally.
     */
    enqueue(taskId: string, runFn: BackgroundTaskFn): void {
        this.queue.add(async () => {
            logger.debug({ taskId }, "Background task dequeued");
            try {
                await runFn();
            } catch (error) {
                // The orchestrator's try/catch already updates the task status.
                // Log here for observability, but don't rethrow (would crash the queue).
                logger.error({ taskId, error }, "Background task failed");
            }
        });

        logger.debug({ taskId, pending: this.queue.pending, size: this.queue.size }, "Background task enqueued");
    }

    get pending(): number {
        return this.queue.pending;
    }

    get size(): number {
        return this.queue.size;
    }
}
