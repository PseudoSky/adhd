import PQueue from "p-queue";
import type { EngineLogger } from "../interfaces.js";

export type BackgroundTaskFn = () => Promise<void>;

export class BackgroundQueue {
    private readonly queue: PQueue;
    private readonly logger: EngineLogger;

    constructor(concurrency: number, logger?: EngineLogger) {
        this.queue = new PQueue({ concurrency });
        this.logger = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as EngineLogger;
    }

    enqueue(taskId: string, runFn: BackgroundTaskFn): void {
        this.queue.add(async () => {
            this.logger.debug({ taskId }, "Background task dequeued");
            try {
                await runFn();
            } catch (error) {
                this.logger.error({ taskId, error }, "Background task failed");
            }
        });

        this.logger.debug({ taskId, pending: this.queue.pending, size: this.queue.size }, "Background task enqueued");
    }

    get pending(): number {
        return this.queue.pending;
    }

    get size(): number {
        return this.queue.size;
    }

    onIdle(): Promise<void> {
        return this.queue.onIdle();
    }
}
