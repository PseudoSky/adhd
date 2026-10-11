/**
 * ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC1 / AC2 (bucket B2, G3): the per-task tool limiter shared
 * by the native fan-out (`map`) and the bridge (`run`). Latch proofs, no sleeps. The end-to-end
 * native/bridge behaviour is in tool-call-concurrency.test.ts (unmodified, AC2) and
 * claudecli-bridge-concurrency.test.ts.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_TOOL_CALL_CONCURRENCY } from "../interfaces.js";
import { createToolLimiter, resolveToolCallConcurrency } from "../engine/tool-limiter.js";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r)); };

describe("ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC1: one limiter bounds map() and run() together", () => {
    it("ea8f6f92 AC1: map and run calls share the same N slots", async () => {
        const limiter = createToolLimiter(2);
        let inFlight = 0;
        let peak = 0;
        const gate = deferred();
        const body = async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await gate.promise;
            inFlight--;
        };
        const all = Promise.all([
            limiter.map([1, 2, 3], body),
            limiter.run(body),
            limiter.run(body),
        ]);
        await settle();
        expect(peak).toBe(2);
        gate.resolve();
        await all;
        expect(peak).toBe(2);
    });

    it("ea8f6f92 AC2: map returns results in input order and a failure drops un-started siblings without stranding run()", async () => {
        const limiter = createToolLimiter(1);
        const started: number[] = [];
        const gate = deferred();
        const failing = limiter.map([0, 1, 2], async (i) => {
            started.push(i);
            if (i === 0) { await gate.promise; throw new Error("fatal"); }
            return i;
        });
        const outcome = failing.then(() => "ok", (e: Error) => e.message);
        const bridged = limiter.run(async () => "bridged"); // queued behind the map items
        await settle();
        gate.resolve();
        expect(await outcome).toBe("fatal");
        expect(await bridged).toBe("bridged"); // pool.clear() would have stranded this forever
        expect(started).toEqual([0]);
        expect(await createToolLimiter(3).map([3, 1, 2], async (n) => n * 2)).toEqual([6, 2, 4]);
    });

    it("ea8f6f92 AC1: invalid limits fall back to the default", () => {
        for (const bad of [undefined, 0, -1, 1.5, NaN]) expect(resolveToolCallConcurrency(bad)).toBe(DEFAULT_TOOL_CALL_CONCURRENCY);
        expect(createToolLimiter(3).concurrency).toBe(3);
    });
});
