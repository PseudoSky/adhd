/**
 * R10 S3 (P10): concurrent MCP connect, startup timings, annotation plumbing.
 *
 * The remote (http) client is replaced by a latch-controlled fake (no subprocess, no socket,
 * ADR-0009): the registry, its routing table and its failure bookkeeping are the REAL ones, and the
 * connect scheduling is transport-independent. Determinism by latches, never sleeps. The real stdio
 * client's `tools/list` mapping is covered in `registry-connect.e2e.ts` (unit-lane files may not
 * reference the stdio transport classes, check-agent-lane-spawn.mjs).
 *
 *  - R10 S3 AC1: servers connect concurrently (the second connect starts before the first
 *    resolves), bounded by the stated default and ceiling.
 *  - R10 S3 AC2: one failing server keeps today's behaviour (same warning, same recorded error,
 *    other servers' tools advertised).
 *  - R10 S3 AC3: `startupTimings()` is present; the advertised tool order is the configured
 *    server-key order whatever order the servers finish in.
 *  - R10 S3 AC5: annotations flow from `tools/list` into `ToolDefinition.annotations` (stdio, http,
 *    in-process) as the three typed hints only; absent stays absent.
 *  - R10 S3 AC6: `toolClass` and the pinned-fs annotation warning.
 *
 * guards: MCP servers connect one after another or without the stated bound, a failing server loses its warning, recorded error or its neighbours' tools, advertised tools follow finish order instead of configured server-key order, or annotations and toolClass are mapped wrongly.
 * tier: S
 * cites: R10 S3 AC1-AC3, AC5, AC6 (every test title carries its AC); variance hardening cites qa-variance (dispatch-1014).
 * red: pending (qa-variance edit made without running tests, per user). qa-variance: the fixed 20-turn
 * `setImmediate` loop is replaced by `settleUntilStable` over the started/resolved connect log.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolDefinition } from "../../src/providers/types.js";
import type { EngineLogger } from "../../src/interfaces.js";
import type { ExecutionContext } from "../../src/validation/index.js";
import { settleUntilStable } from "../fixtures/settle.js";

interface IFakeServer {
    tools: ToolDefinition[];
    /** Resolves when the test lets `connect()` return. */
    gate: Promise<void>;
    release: () => void;
    /** Set to make `connect()` reject once released. */
    failWith?: Error;
}

const h = vi.hoisted(() => ({
    servers: new Map<string, unknown>(),
    started: [] as string[],
    resolved: [] as string[],
}));

vi.mock("../../src/clients/http-client.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../src/clients/http-client.js")>();
    class FakeHttpMcpClient {
        constructor(private readonly name: string) {}
        async connect(): Promise<void> {
            const server = h.servers.get(this.name) as IFakeServer;
            h.started.push(this.name);
            await server.gate;
            if (server.failWith) throw server.failWith;
            h.resolved.push(this.name);
        }
        async listTools(): Promise<ToolDefinition[]> {
            return (h.servers.get(this.name) as IFakeServer).tools;
        }
        async callTool(): Promise<unknown> {
            return "ok";
        }
        async close(): Promise<void> {}
    }
    return { ...original, HttpMcpClient: FakeHttpMcpClient };
});

import {
    DEFAULT_MCP_CONNECT_CONCURRENCY,
    MAX_MCP_CONNECT_CONCURRENCY,
    McpClientRegistry,
    resolveMcpConnectConcurrency,
} from "../../src/clients/registry.js";
import { InProcessMcpClient } from "../../src/clients/in-process.js";
import { annotationsOf, pickToolAnnotations } from "../../src/clients/types.js";

const schema = { type: "object", properties: {} };
const tool = (name: string, annotations?: ToolDefinition["annotations"]): ToolDefinition => ({
    name,
    description: name,
    inputSchema: schema,
    ...(annotations ? { annotations } : {}),
});

function addServer(name: string, tools: ToolDefinition[], opts: { open?: boolean; failWith?: Error } = {}): IFakeServer {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server: IFakeServer = { tools, gate, release, failWith: opts.failWith };
    if (opts.open) release();
    h.servers.set(name, server);
    return server;
}

/** Yields until the connect log (started/resolved) stops changing, so already-resolvable promises have run. */
const flush = (): Promise<number> => settleUntilStable(() => [h.started, h.resolved]);

interface IWarn {
    obj: unknown;
    msg: string;
}
function recordingLogger(): { logger: EngineLogger; warns: IWarn[] } {
    const warns: IWarn[] = [];
    const logger = {
        info() {},
        debug() {},
        error() {},
        warn(obj: unknown, msg: string) {
            warns.push({ obj, msg });
        },
    } as unknown as EngineLogger;
    return { logger, warns };
}

function makeRegistry(names: string[], logger?: EngineLogger, connectConcurrency?: number): McpClientRegistry {
    const servers = Object.fromEntries(names.map((n) => [n, { transport: "http", url: `http://127.0.0.1:1/${n}` }]));
    return new McpClientRegistry(
        servers as never,
        undefined,
        [],
        async () => "ok",
        {} as ExecutionContext,
        undefined,
        logger,
        connectConcurrency === undefined ? undefined : { connectConcurrency }
    );
}

beforeEach(() => {
    h.servers.clear();
    h.started.length = 0;
    h.resolved.length = 0;
});

describe("R10 S3 AC1: concurrent connect", () => {
    it("R10 S3 AC1: the second connect starts before the first resolves", async () => {
        const first = addServer("one", [tool("a")]);
        const second = addServer("two", [tool("b")]);
        const registry = makeRegistry(["one", "two"]);
        const listing = registry.listAllTools();
        await flush();
        // Neither gate is open: both connects are in flight at once. A serial walk would show ["one"].
        expect(h.started).toEqual(["one", "two"]);
        expect(h.resolved).toEqual([]);
        second.release();
        first.release();
        expect((await listing).map((t) => t.name)).toEqual(["one__a", "two__b"]);
    });

    it("R10 S3 AC1: the default bound is stated and enforced (a fifth server waits for a free slot)", async () => {
        expect(DEFAULT_MCP_CONNECT_CONCURRENCY).toBe(4);
        expect(MAX_MCP_CONNECT_CONCURRENCY).toBe(8);
        const names = ["s0", "s1", "s2", "s3", "s4", "s5"];
        const gates = names.map((n) => addServer(n, [tool("t")]));
        const listing = makeRegistry(names).listAllTools();
        await flush();
        expect(h.started).toEqual(["s0", "s1", "s2", "s3"]);
        gates[1].release();
        await flush();
        expect(h.started).toEqual(["s0", "s1", "s2", "s3", "s4"]);
        for (const g of gates) g.release();
        expect((await listing).map((t) => t.name)).toEqual(names.map((n) => `${n}__t`));
    });

    it("R10 S3 AC1: an explicit bound is honoured, and a request above the ceiling is clamped to it", async () => {
        const names = Array.from({ length: 10 }, (_, i) => `n${i}`);
        const gates = names.map((n) => addServer(n, [tool("t")]));
        const two = makeRegistry(names, undefined, 2).listAllTools();
        await flush();
        expect(h.started).toEqual(["n0", "n1"]);
        for (const g of gates) g.release();
        await two;

        h.started.length = 0;
        h.servers.clear();
        const gates2 = names.map((n) => addServer(n, [tool("t")]));
        const clamped = makeRegistry(names, undefined, 1000).listAllTools();
        await flush();
        expect(h.started).toHaveLength(MAX_MCP_CONNECT_CONCURRENCY);
        for (const g of gates2) g.release();
        await clamped;
    });

    it("R10 S3 AC1: resolveMcpConnectConcurrency falls back to the default for anything but a positive integer", () => {
        for (const bad of [undefined, 0, -1, 1.5, Number.NaN]) {
            expect(resolveMcpConnectConcurrency(bad)).toBe(DEFAULT_MCP_CONNECT_CONCURRENCY);
        }
        expect(resolveMcpConnectConcurrency(1)).toBe(1);
        expect(resolveMcpConnectConcurrency(MAX_MCP_CONNECT_CONCURRENCY + 1)).toBe(MAX_MCP_CONNECT_CONCURRENCY);
    });
});

describe("R10 S3 AC2: a failing server keeps today's behaviour", () => {
    it("R10 S3 AC2: the other servers' tools are advertised, the failure is warned once per server in config order and re-thrown by the first getClient", async () => {
        const boomA = new Error("a failed to start");
        const boomC = new Error("c failed to start");
        addServer("a", [tool("x")], { open: true, failWith: boomA });
        addServer("b", [tool("y")], { open: true });
        const c = addServer("c", [tool("z")], { failWith: boomC });
        const { logger, warns } = recordingLogger();
        const registry = makeRegistry(["a", "b", "c"], logger);
        const listing = registry.listAllTools();
        await flush(); // a and b are done, c is still gated
        c.release();
        const tools = await listing;

        expect(tools.map((t) => t.name)).toEqual(["b__y"]);
        // Same message and shape as before, ordered by configured server key (not completion order).
        expect(warns.map((w) => w.msg)).toEqual(["Failed to list tools from MCP server", "Failed to list tools from MCP server"]);
        expect(warns.map((w) => (w.obj as { server: string }).server)).toEqual(["a", "c"]);
        expect((warns[0].obj as { error: unknown }).error).toBe(boomA);

        // The recorded failure is re-thrown once by the model's first call to that server (c9f0a791),
        // then a later call makes a fresh attempt.
        await expect(registry.getClient("a")).rejects.toBe(boomA);
        await expect(registry.getClient("a")).rejects.toBe(boomA); // fresh attempt fails again (server still down)
        expect(h.started.filter((n) => n === "a")).toHaveLength(2);
    });
});

describe("R10 S3 AC3: startup timings and deterministic order", () => {
    it("R10 S3 AC3: before any listing the timings are empty; after it there is one entry per server", async () => {
        const registry = makeRegistry(["one", "two"]);
        expect(registry.startupTimings()).toEqual({ connectMs: {}, toolsReadyMs: 0 });
        addServer("one", [tool("a")], { open: true });
        addServer("two", [tool("b")], { open: true, failWith: new Error("down") });
        await registry.listAllTools();
        const timings = registry.startupTimings();
        expect(Object.keys(timings.connectMs).sort()).toEqual(["one", "two"]); // the failed server is timed too
        for (const ms of Object.values(timings.connectMs)) {
            expect(Number.isInteger(ms)).toBe(true);
            expect(ms).toBeGreaterThanOrEqual(0);
        }
        expect(timings.toolsReadyMs).toBeGreaterThanOrEqual(Math.max(...Object.values(timings.connectMs)) - 1);
        // A copy: mutating it does not change the registry's record.
        timings.connectMs["one"] = 999;
        expect(registry.startupTimings().connectMs["one"]).not.toBe(999);
    });

    it("R10 S3 AC3: the tool list is in configured server-key order even when the second server finishes first", async () => {
        const first = addServer("first", [tool("a1"), tool("a2")]);
        const second = addServer("second", [tool("b1")]);
        const registry = makeRegistry(["first", "second"]);
        const listing = registry.listAllTools();
        await flush();
        second.release();
        await flush();
        expect(h.resolved).toEqual(["second"]); // second finished first
        first.release();
        expect((await listing).map((t) => t.name)).toEqual(["first__a1", "first__a2", "second__b1"]);
        // The routing table is complete and identical.
        expect(registry.resolveToolName("second__b1")).toEqual({ server: "second", tool: "b1" });
    });
});

describe("R10 S3 AC5: annotation plumbing", () => {
    it("R10 S3 AC5: pickToolAnnotations keeps only the three boolean hints", () => {
        expect(
            pickToolAnnotations({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: "x" })
        ).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        expect(pickToolAnnotations({ readOnlyHint: "yes", openWorldHint: true })).toBeUndefined();
        expect(pickToolAnnotations({})).toBeUndefined();
        expect(pickToolAnnotations(undefined)).toBeUndefined();
        expect(pickToolAnnotations(null)).toBeUndefined();
        expect(pickToolAnnotations("readOnlyHint")).toBeUndefined();
        expect(annotationsOf({})).toEqual({});
        expect("annotations" in annotationsOf({ annotations: { openWorldHint: true } })).toBe(false);
    });

    it("R10 S3 AC5: the http client maps annotations the same way", async () => {
        // `HttpMcpClient` is the fake in this file; exercise the REAL class through its module.
        const { HttpMcpClient } = await vi.importActual<typeof import("../../src/clients/http-client.js")>("../../src/clients/http-client.js");
        const client = new HttpMcpClient("web", { transport: "http", url: "http://127.0.0.1:1/mcp" } as never);
        (client as unknown as { client: unknown }).client = {
            listTools: async () => ({
                tools: [
                    { name: "get", description: "g", inputSchema: schema, annotations: { readOnlyHint: true } },
                    { name: "bare", description: "b", inputSchema: schema },
                ],
            }),
        };
        const listed = await client.listTools();
        expect(listed[0]).toEqual({ name: "get", description: "g", inputSchema: schema, annotations: { readOnlyHint: true } });
        expect("annotations" in listed[1]).toBe(false);
    });

    it("R10 S3 AC5: the in-process client forwards descriptor annotations, and only when present", async () => {
        const client = new InProcessMcpClient(
            [
                { name: "guide", description: "g", inputSchema: schema, annotations: { readOnlyHint: true, openWorldHint: true } },
                { name: "task", description: "t", inputSchema: schema },
            ],
            async () => "ok",
            {} as ExecutionContext
        );
        const listed = await client.listTools();
        expect(listed[0].annotations).toEqual({ readOnlyHint: true });
        expect("annotations" in listed[1]).toBe(false);
    });

    it("R10 S3 AC5: annotations survive registry.listAllTools unchanged and drive toolClass", async () => {
        addServer("fs", [tool("read_text_file", { readOnlyHint: true }), tool("edit_file", { readOnlyHint: false, destructiveHint: true })], { open: true });
        addServer("thirdparty", [tool("lookup"), tool("mutate", { readOnlyHint: false })], { open: true });
        const registry = makeRegistry(["fs", "thirdparty"]);
        const tools = await registry.listAllTools();
        expect(tools.find((t) => t.name === "fs__edit_file")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
        expect(tools.find((t) => t.name === "thirdparty__lookup")).not.toHaveProperty("annotations");
        expect(registry.toolClass("fs", "read_text_file")).toBe("safe");
        expect(registry.toolClass("fs", "edit_file")).toBe("barrier");
        expect(registry.toolClass("thirdparty", "lookup")).toBe("safe"); // unannotated third party: today's behaviour
        expect(registry.toolClass("thirdparty", "mutate")).toBe("barrier");
        expect(registry.toolClass("unlisted", "whatever")).toBe("safe");
    });
});

describe("R10 S3 AC6: the pinned fs server must annotate every tool (P1-A4)", () => {
    it("R10 S3 AC6: a fully annotated fs server logs no warning", async () => {
        addServer("fs", [tool("read_text_file", { readOnlyHint: true }), tool("edit_file", { readOnlyHint: false })], { open: true });
        const { logger, warns } = recordingLogger();
        await makeRegistry(["fs"], logger).listAllTools();
        expect(warns).toEqual([]);
    });

    it("R10 S3 AC6: an fs tool without readOnlyHint warns by name, does not fail start-up, and is ordered as a barrier", async () => {
        addServer("fs", [tool("read_text_file", { readOnlyHint: true }), tool("brand_new_tool"), tool("odd", { destructiveHint: true })], { open: true });
        const { logger, warns } = recordingLogger();
        const registry = makeRegistry(["fs"], logger);
        const tools = await registry.listAllTools();
        expect(tools).toHaveLength(3); // start-up still succeeds
        expect(warns).toHaveLength(1);
        expect(warns[0].msg).toContain("readOnlyHint");
        expect((warns[0].obj as { tools: string[] }).tools).toEqual(["brand_new_tool", "odd"]);
        expect(registry.toolClass("fs", "brand_new_tool")).toBe("barrier");
    });

    it("R10 S3 AC6: a non-fs server is never warned about", async () => {
        addServer("other", [tool("bare")], { open: true });
        const { logger, warns } = recordingLogger();
        await makeRegistry(["other"], logger).listAllTools();
        expect(warns).toEqual([]);
    });
});
