/**
 * R10 S2 (P1): `IToolLimiter.mapOrdered` — deterministic same-turn ordering.
 *
 * Pure limiter tests with hand-resolved latches (no sleeps, no wall clock). The engine-level
 * proof through the real `Orchestrator.run` is `tool-order-engine.test.ts`.
 *
 *  - R10 S2 AC1: [read A, write W, read B]: W starts only after A settles, B only after W settles;
 *    two reads before a barrier overlap.
 *  - R10 S2 AC2: three reads and a delegation call overlap; a delegation call is never gated and
 *    never gates.
 *  - R10 S2 AC3: results come back in input order; a failure (fatal code) stops later unstarted
 *    calls and never strands a waiter.
 *  - R10 S2 AC7: `concurrency: 1` does not deadlock; queuedMs/groupIndex meta; the measured cost
 *    of serialising two shell commands.
 *
 * guards: mapOrdered lets a barrier overlap an earlier or later call, gates a delegation call, returns results out of input order, strands a waiter after a failure, deadlocks at concurrency 1, or reports wrong queuedMs or groupIndex.
 * tier: S
 * cites: R10 S2 AC1, AC2, AC3, AC7 (every test title carries its AC).
 */
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assignGroups, type ToolSchedulingClass } from "../engine/tool-class.js";
import { createToolLimiter } from "../engine/tool-limiter.js";

/** A promise the test resolves by hand. */
function latch<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Lets every already-resolvable promise run (microtasks and a few macrotask turns). */
const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

interface ICall {
    name: string;
    cls: ToolSchedulingClass;
}
const read = (name: string): ICall => ({ name, cls: "safe" });
const write = (name: string): ICall => ({ name, cls: "barrier" });
const delegate = (name: string): ICall => ({ name, cls: "unordered" });

/** Runs `calls` through `mapOrdered`; each call starts, then waits for its latch. */
function drive(calls: ICall[], concurrency = 8) {
    const limiter = createToolLimiter(concurrency);
    const gates = new Map(calls.map((c) => [c.name, latch()]));
    const started: string[] = [];
    const settled: string[] = [];
    const metas = new Map<string, { groupIndex: number; queuedMs: number }>();
    const done = limiter.mapOrdered(
        calls,
        async (call, meta) => {
            started.push(call.name);
            metas.set(call.name, meta);
            await gates.get(call.name)!.promise;
            settled.push(call.name);
            return `result:${call.name}`;
        },
        (call) => call.cls
    );
    const finish = (name: string) => gates.get(name)!.resolve();
    return { done, started, settled, metas, finish, gates };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("R10 S2 AC1: a barrier is ordered against every other call", () => {
    it("R10 S2 AC1: [read A, write W, read B] — W starts only after A settles, B only after W settles", async () => {
        const run = drive([read("A"), write("W"), read("B")]);
        await flush();
        expect(run.started).toEqual(["A"]); // W and B are waiting, outside the pool
        run.finish("A");
        await flush();
        expect(run.started).toEqual(["A", "W"]);
        run.finish("W");
        await flush();
        expect(run.started).toEqual(["A", "W", "B"]);
        run.finish("B");
        expect(await run.done).toEqual(["result:A", "result:W", "result:B"]);
        expect(run.settled).toEqual(["A", "W", "B"]);
    });

    it("R10 S2 AC1: two reads before a barrier run concurrently; the barrier waits for BOTH", async () => {
        const run = drive([read("A1"), read("A2"), write("W"), read("B1"), read("B2")]);
        await flush();
        expect(run.started).toEqual(["A1", "A2"]); // both in flight before either settles
        run.finish("A2");
        await flush();
        expect(run.started).toEqual(["A1", "A2"]); // W still waits for A1
        run.finish("A1");
        await flush();
        expect(run.started).toEqual(["A1", "A2", "W"]);
        run.finish("W");
        await flush();
        expect(run.started).toEqual(["A1", "A2", "W", "B1", "B2"]); // reads after the barrier overlap again
        run.finish("B1");
        run.finish("B2");
        expect(await run.done).toHaveLength(5);
    });

    it("R10 S2 AC1: consecutive barriers run strictly in submission order", async () => {
        const run = drive([write("W1"), write("W2"), write("W3")]);
        await flush();
        expect(run.started).toEqual(["W1"]);
        run.finish("W1");
        await flush();
        expect(run.started).toEqual(["W1", "W2"]);
        run.finish("W2");
        await flush();
        expect(run.started).toEqual(["W1", "W2", "W3"]);
        run.finish("W3");
        await run.done;
    });

    it("R10 S2 AC1: a read before a barrier does not run past it even when the read is slow", async () => {
        const run = drive([read("slow"), write("W")]);
        await flush();
        expect(run.started).toEqual(["slow"]);
        expect(run.settled).toEqual([]);
        run.finish("slow");
        run.finish("W");
        await run.done;
        expect(run.settled).toEqual(["slow", "W"]);
    });
});

describe("R10 S2 AC2: delegation calls are never ordered", () => {
    it("R10 S2 AC2: two reads and a delegation call run concurrently (all started before any settles)", async () => {
        const run = drive([read("r1"), delegate("task"), read("r2")]);
        await flush();
        expect(run.started).toEqual(["r1", "task", "r2"]);
        expect(run.settled).toEqual([]);
        for (const n of ["r1", "task", "r2"]) run.finish(n);
        await run.done;
    });

    it("R10 S2 AC2: a delegation call between two barriers never waits and never blocks", async () => {
        const run = drive([write("W1"), delegate("task"), write("W2")]);
        await flush();
        // The delegation call started with W1 still running (it is never gated)...
        expect(run.started).toEqual(["W1", "task"]);
        run.finish("W1");
        await flush();
        // ...and W2 started once W1 settled although the delegation call is still running (it does not gate).
        expect(run.started).toEqual(["W1", "task", "W2"]);
        expect(run.settled).toEqual(["W1"]);
        run.finish("W2");
        run.finish("task");
        await run.done;
    });

    it("R10 S2 AC2: a barrier after a long delegation call waits for the earlier reads only", async () => {
        const run = drive([read("r"), delegate("task"), write("make-test")]);
        await flush();
        expect(run.started).toEqual(["r", "task"]);
        run.finish("r");
        await flush();
        expect(run.started).toEqual(["r", "task", "make-test"]); // not held for `task`
        run.finish("make-test");
        run.finish("task");
        await run.done;
    });
});

describe("R10 S2 AC3: results in input order; failure never strands a call", () => {
    it("R10 S2 AC3: results are in input order whatever order the calls settle in", async () => {
        const run = drive([read("a"), read("b"), read("c"), delegate("d")]);
        await flush();
        run.finish("d");
        run.finish("c");
        run.finish("b");
        run.finish("a");
        expect(await run.done).toEqual(["result:a", "result:b", "result:c", "result:d"]);
        expect(run.settled).toEqual(["d", "c", "b", "a"]);
    });

    it("R10 S2 AC3: a barrier that throws rejects the map and no later ordered call starts", async () => {
        const limiter = createToolLimiter(8);
        const started: string[] = [];
        const calls = [read("a"), write("W"), read("b"), write("W2")];
        const gateA = latch();
        const outcome = limiter
            .mapOrdered(
                calls,
                async (call) => {
                    started.push(call.name);
                    if (call.name === "a") await gateA.promise;
                    if (call.name === "W") throw new Error("fatal");
                    return call.name;
                },
                (c) => c.cls
            )
            .then(
                () => "resolved",
                (e: Error) => `rejected:${e.message}`
            );
        await flush();
        gateA.resolve();
        // Settles (no hang: the waiters behind the failed barrier were released) and nothing after W ran.
        expect(await outcome).toBe("rejected:fatal");
        expect(started).toEqual(["a", "W"]);
    });

    it("R10 S2 AC3: a failure in an unordered call stops ordered calls that have not started, in-flight calls finish", async () => {
        const limiter = createToolLimiter(8);
        const started: string[] = [];
        const finished: string[] = [];
        const gateRead = latch();
        const calls = [read("r"), delegate("d"), write("W")];
        const outcome = limiter
            .mapOrdered(
                calls,
                async (call) => {
                    started.push(call.name);
                    if (call.name === "d") throw new Error("delegate-fatal");
                    if (call.name === "r") {
                        await gateRead.promise;
                        finished.push("r");
                    }
                    return call.name;
                },
                (c) => c.cls
            )
            .then(
                () => "resolved",
                (e: Error) => `rejected:${e.message}`
            );
        await flush();
        gateRead.resolve(); // the in-flight read runs to completion
        expect(await outcome).toBe("rejected:delegate-fatal");
        expect(finished).toEqual(["r"]);
        expect(started).toEqual(["r", "d"]); // W saw the failure flag and never started
    });

    it("R10 S2 AC3: no unhandled rejection escapes when several calls fail", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (e: unknown) => unhandled.push(e);
        process.on("unhandledRejection", onUnhandled);
        try {
            const limiter = createToolLimiter(2);
            const result = limiter.mapOrdered(
                [write("W1"), write("W2"), read("r"), write("W3")],
                async (call) => {
                    throw new Error(`boom ${call.name}`);
                },
                (c) => c.cls
            );
            await expect(result).rejects.toThrow("boom W1");
            await flush();
            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});

describe("R10 S2 AC7: bound, meta and the cost of ordering", () => {
    it("R10 S2 AC7: concurrency 1 does not deadlock on its own ordering and never exceeds one in flight", async () => {
        const limiter = createToolLimiter(1);
        let inFlight = 0;
        let peak = 0;
        const order: string[] = [];
        const calls = [read("r1"), read("r2"), write("W"), read("r3"), delegate("d")];
        const out = await limiter.mapOrdered(
            calls,
            async (call) => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                order.push(call.name);
                await Promise.resolve();
                inFlight--;
                return call.name;
            },
            (c) => c.cls
        );
        expect(out).toEqual(["r1", "r2", "W", "r3", "d"]);
        expect(peak).toBe(1);
        // Ordering is still honoured: W after both earlier reads, r3 after W.
        expect(order.indexOf("W")).toBeGreaterThan(order.indexOf("r2"));
        expect(order.indexOf("r3")).toBeGreaterThan(order.indexOf("W"));
    });

    it("R10 S2 AC7: a waiting call never holds a pool slot (concurrency 2, a barrier waits while a bridge run proceeds)", async () => {
        const limiter = createToolLimiter(2);
        const gateRead = latch();
        const started: string[] = [];
        const done = limiter.mapOrdered(
            [read("r"), write("W")],
            async (call) => {
                started.push(call.name);
                if (call.name === "r") await gateRead.promise;
                return call.name;
            },
            (c) => c.cls
        );
        await flush();
        expect(started).toEqual(["r"]); // W is waiting on `r` but holds no slot...
        // ...so an unrelated call through the shared pool (the claudecli bridge `run`) still gets the free slot.
        await expect(limiter.run(async () => "bridge")).resolves.toBe("bridge");
        gateRead.resolve();
        await done;
    });

    it("R10 S2 AC7: the meta carries the groupIndex of assignGroups and a whole-number queuedMs", async () => {
        let clock = 1_000;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const calls = [read("a"), read("b"), write("W"), read("c"), delegate("d")];
        const run = drive(calls);
        await flush();
        clock = 1_250; // `a` and `b` have been running; W waited the whole time
        run.finish("a");
        run.finish("b");
        await flush();
        clock = 1_700;
        run.finish("W");
        await flush();
        run.finish("c");
        run.finish("d");
        await run.done;
        expect(Object.fromEntries([...run.metas].map(([k, v]) => [k, v.groupIndex]))).toEqual({
            a: 0,
            b: 0,
            W: 1,
            c: 2,
            d: 2, // takes the group of the nearest ordered call before it (read c)
        });
        expect(assignGroups(calls.map((c) => c.cls))).toEqual([0, 0, 1, 2, 2]);
        expect(run.metas.get("a")!.queuedMs).toBe(0);
        expect(run.metas.get("b")!.queuedMs).toBe(0);
        expect(run.metas.get("d")!.queuedMs).toBe(0); // unordered: starts at once
        expect(run.metas.get("W")!.queuedMs).toBe(250); // waited for a and b
        expect(run.metas.get("c")!.queuedMs).toBe(700); // waited for a, b and W
    });

    it("R10 S2 AC7 (documented tradeoff): two shell commands in one turn cost the SUM of their durations ordered, the MAX unordered", async () => {
        // Virtual time: each "command" occupies [start, start + ms). 2000 ms and 1500 ms stand for
        // `make test` and a lint run emitted in the same turn.
        const COMMANDS = [
            { name: "make test", ms: 2000 },
            { name: "lint", ms: 1500 },
        ];
        const measure = async (ordered: boolean): Promise<number> => {
            let clock = 0;
            vi.spyOn(performance, "now").mockImplementation(() => clock);
            const limiter = createToolLimiter(8);
            const pending = new Map<string, { end: number; release: () => void }>();
            const fn = async (c: { name: string; ms: number }): Promise<string> => {
                const gate = latch();
                pending.set(c.name, { end: clock + c.ms, release: gate.resolve });
                await gate.promise;
                return c.name;
            };
            const done = ordered
                ? limiter.mapOrdered(COMMANDS, fn, () => "barrier")
                : limiter.map(COMMANDS, fn);
            let finished = false;
            void done.then(() => (finished = true));
            // Advance virtual time to each command's end in turn until everything has completed.
            while (!finished) {
                await flush();
                if (finished) break;
                const [name, next] = [...pending].sort((a, b) => a[1].end - b[1].end)[0];
                clock = next.end;
                pending.delete(name);
                next.release();
            }
            await done;
            vi.restoreAllMocks();
            return clock;
        };
        const unordered = await measure(false);
        const ordered = await measure(true);
        expect(unordered).toBe(2000); // today: the two commands overlap, the turn costs the longer one
        expect(ordered).toBe(3500); // R10 P1: shell is a barrier, the turn costs the sum
    });
});
