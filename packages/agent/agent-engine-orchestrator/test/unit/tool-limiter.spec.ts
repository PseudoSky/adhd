/**
 * ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC1 / AC2 (bucket B2, G3): the per-task tool limiter shared
 * by the native fan-out (`map`) and the bridge (`run`). Latch proofs, no sleeps. The end-to-end
 * native/bridge behaviour is in tool-call-concurrency.test.ts (unmodified, AC2) and
 * claudecli-bridge-concurrency.test.ts.
 *
 * guards: the tool-call limiter exceeds its bound, shares slots unevenly between map() and run(), strands run() after a map failure, or releases a slot while an aborted call is still in flight.
 * tier: S
 * cites: ea8f6f92 AC1, AC2; cf7e0e5c review-4; variance hardening cites qa-variance (dispatch-1014).
 * red: pending (qa-variance edit made without running tests, per user). qa-variance: the fixed 30-turn
 * `setImmediate` loop is replaced by `settleUntilStable` (state-probe quiescence, no clock).
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_TOOL_CALL_CONCURRENCY } from "../../src/interfaces.js";
import { createToolLimiter, resolveToolCallConcurrency } from "../../src/engine/tool-limiter.js";
import { settleUntilStable } from "../fixtures/settle.js";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

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
        await settleUntilStable(() => [peak, inFlight]);
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
        await settleUntilStable(() => started);
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

describe("cf7e0e5c review-4: abort never releases a slot while the call is still in flight", () => {
    it("cf7e0e5c review-4: limit 1, A running + unsettled, abort, enqueue B -> B does not start until A settles", async () => {
        const limiter = createToolLimiter(1);
        const ac = new AbortController();
        const gateA = deferred();
        const started: string[] = [];
        const a = limiter.run(async () => { started.push("A"); await gateA.promise; }, ac.signal);
        a.catch(() => undefined);
        await settleUntilStable(() => started);
        expect(started).toEqual(["A"]);
        ac.abort(new Error("cancelled"));
        const b = limiter.run(async () => { started.push("B"); });
        await settleUntilStable(() => started);
        // A's fn has not settled: the bound of 1 must still hold.
        expect(started).toEqual(["A"]);
        gateA.resolve();
        await b;
        expect(started).toEqual(["A", "B"]);
    });

    it("cf7e0e5c review-4: a call aborted while still queued never runs and rejects with the signal reason", async () => {
        const limiter = createToolLimiter(1);
        const ac = new AbortController();
        const gate = deferred();
        const ran: string[] = [];
        const holder = limiter.run(async () => { await gate.promise; });
        const queued = limiter.run(async () => { ran.push("queued"); }, ac.signal);
        const reason = new Error("dropped");
        ac.abort(reason);
        await expect(queued).rejects.toBe(reason);
        gate.resolve();
        await holder;
        await settleUntilStable(() => ran);
        expect(ran).toEqual([]);
    });

    it("cf7e0e5c review-4: an already-aborted signal rejects without invoking fn", async () => {
        const limiter = createToolLimiter(1);
        const ac = new AbortController();
        const reason = new Error("pre-aborted");
        ac.abort(reason);
        let ran = false;
        await expect(limiter.run(async () => { ran = true; }, ac.signal)).rejects.toBe(reason);
        expect(ran).toBe(false);
    });
});
