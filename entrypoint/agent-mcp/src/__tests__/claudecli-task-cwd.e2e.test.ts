/**
 * 9ed453c1 CWD (AC1 production path + AC5) - e2e lane (ADR-0009), no env gate: nothing here calls a
 * paid third-party service.
 *
 * Drives the REAL `task` MCP tool through the PRODUCTION `createServer` (resolving native-tooling
 * store, `engineConfig()` with the real wire seams, real orchestrator + queue + stores over the shipped
 * migrations) with a claudecli agent whose `claude` is a real stand-in executable
 * (`fake-claude-fs.mjs`). The stand-in is a genuine MCP client (Streamable-HTTP, bearer header from the
 * config) of the loopback `fs` bridge entry the provider wrote into --mcp-config; the bridge executes the
 * call through the engine. It also answers roots/list with its OWN cwd the way Claude Code does. Nothing injects
 * `EngineConfig.cwd`: the only cwd source is the `cwd` argument of the `task` call.
 *
 *   AC1  a `task` dispatched with cwd=/P spawns claude in /P, and in /Q on the next dispatch
 *   AC5  an fs-enabled claudecli agent reads a file under the task cwd through the fs server
 *        (the server's argv root is the task cwd AND claude's roots/list answer is its spawn cwd -
 *        before the fix these disagreed and every read was "Access denied")
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentCreateInput } from "@adhd/agent-engine-orchestrator";

import { createServer } from "../server.js";
import { buildHarness, type Harness } from "./integration/harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_FS = path.resolve(
    here,
    "../../../../packages/agent/agent-engine-orchestrator/src/__tests__/fixtures/fake-claude-fs.mjs"
);
const TMP_ROOT = path.resolve(here, "../../../../tmp/agent-mcp");

interface IReport {
    cwd: string;
    servers: string[];
    /** --mcp-config entry type per server name (since BRIDGE every entry is a loopback `http` bridge). */
    entryTypes: Record<string, string>;
    /** tools/call requests the stand-in issued through the bridge. */
    toolCalls: number;
    text?: string;
    isError?: boolean;
    error?: string;
}

describe("9ed453c1 CWD: the task tool's cwd reaches claude and its fs server (production path)", () => {
    let root: string;
    let harness: Harness;
    let mcp: Client;

    beforeAll(async () => {
        fs.mkdirSync(TMP_ROOT, { recursive: true });
        root = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, "cwd-fs-")));
        fs.chmodSync(FAKE_CLAUDE_FS, 0o755);
        harness = await buildHarness();
        const server = createServer({
            agentStore: harness.agentStore,
            sessionStore: harness.sessionStore,
            taskStore: harness.taskStore,
            queue: harness.queue,
            policy: harness.policy,
            orchestrator: harness.orchestrator,
            hooks: harness.hooks,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            db: harness.db as any,
            dagEngine: harness.dagEngine,
        });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await server.connect(st);
        mcp = new Client({ name: "cwd-fs", version: "0.0.1" }, { capabilities: {} });
        await mcp.connect(ct);
    }, 60_000);

    afterAll(async () => {
        await mcp?.close().catch(() => undefined);
        await harness?.teardown();
        fs.rmSync(root, { recursive: true, force: true });
        // A regression (claude spawned in the host cwd) would drop its report here; never leave it behind.
        fs.rmSync(path.join(process.cwd(), ".fake-claude-fs-report.json"), { force: true });
    });

    function projectDir(name: string, marker: string): string {
        const dir = path.join(root, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "marker.txt"), marker);
        return dir;
    }

    function createAgent(): string {
        const name = `cwd-agent-${crypto.randomUUID()}`;
        harness.agentStore.create({
            name,
            provider: { type: "claudecli", model: "claude-haiku-4-5", claudePath: FAKE_CLAUDE_FS },
            systemPrompt: "x",
            mcpServers: {},
            permissions: {},
            // fs enabled, rooted at the dispatching cwd (the default root); shell/hitl off.
            nativeTooling: { fs: true, shell: false, hitl: false },
        } as unknown as AgentCreateInput);
        return name;
    }

    async function dispatch(agentName: string, cwd: string): Promise<IReport> {
        const res = (await mcp.callTool({
            name: "task",
            arguments: { agent_name: agentName, prompt: "go", cwd },
        })) as { isError?: boolean; content?: Array<{ text?: string }> };
        expect(res.isError, JSON.stringify(res.content)).not.toBe(true);
        return JSON.parse(fs.readFileSync(path.join(cwd, ".fake-claude-fs-report.json"), "utf8")) as IReport;
    }

    it("9ed453c1 CWD AC1+AC5: a task at cwd=/P spawns claude in /P and reads /P/marker.txt through the fs server", async () => {
        const P = projectDir("P", "marker-in-P");
        const report = await dispatch(createAgent(), P);
        // REVERT-FAILING (AC1): without the construct.ts wiring claude spawns in the host cwd, so the
        // report is written to the host cwd and this file is never created in /P (readFileSync throws).
        expect(report.cwd).toBe(P);
        expect(report.servers).toContain("fs");
        // BRIDGE: claude only ever sees loopback http entries, so the read below can only have been executed
        // by the engine (request.executeTool -> the engine-spawned fs server), exactly once - claude has no
        // command to spawn a second fs server from.
        expect(report.entryTypes.fs).toBe("http");
        expect(Object.values(report.entryTypes).every((t) => t === "http")).toBe(true);
        expect(report.toolCalls).toBe(1);
        // REVERT-FAILING (AC5): claude's roots/list answer (its cwd) replaces the fs server's allow-list;
        // a mismatch with the argv root yields "Access denied" instead of the file text.
        expect(report.error).toBeUndefined();
        expect(report.isError).toBe(false);
        expect(report.text).toBe("marker-in-P");
    }, 60_000);

    it("9ed453c1 CWD AC2: the same agent dispatched at /P then /Q reads each project's own file in turn", async () => {
        const P = projectDir("P2", "second-P");
        const Q = projectDir("Q2", "second-Q");
        const agent = createAgent();
        const inP = await dispatch(agent, P);
        const inQ = await dispatch(agent, Q);
        expect([inP.cwd, inP.text]).toEqual([P, "second-P"]);
        expect([inQ.cwd, inQ.text]).toEqual([Q, "second-Q"]);
    }, 60_000);
});
