import PQueue from "p-queue";

import { logger } from "../logger.js";
import { config } from "../config.js";

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
        const resolvedConcurrency = concurrency ?? config.queue.concurrency;

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
                // DEBT-001 error boundary: the orchestrator's try/catch/finally already
                // updates the task status and emits TASK_FAILED before re-throwing.
                // Swallowing here is intentional — rethrowing would surface as an
                // unhandled rejection in p-queue and reach our process.on("unhandledRejection")
                // handler, killing the server for a per-task failure. Log for observability.
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

    /**
     * Returns a Promise that resolves when the queue has drained to idle
     * (all currently enqueued and running tasks have finished).
     * Delegates to p-queue's own `onIdle()`.
     */
    onIdle(): Promise<void> {
        return this.queue.onIdle();
    }
}
