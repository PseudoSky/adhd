/**
 * 424b6362 (R3-PAR-B) AC4/AC5/AC6 e2e (ADR-0009 e2e lane; not env-gated).
 *
 * - AC4 (wired): the REAL loopback bridge, with the provider's hook, advertises readOnlyHint on
 *   exactly task / tasks_batch / agent in tools/list (real MCP client over HTTP).
 * - AC6 (race-safety): the real taskTool -> Orchestrator -> ClaudeCliProvider -> bridge ->
 *   McpClientRegistry -> stdio server chain, driven by a stand-in `claude` that fires its tool calls
 *   SIMULTANEOUSLY (fake-claude-mcp.mjs `parallel:true`). Per-run caps must be exact under that race.
 * - AC5 (tripwire): the REAL `claude` CLI (haiku-4-5; paid, but NOT env-gated: a handful of tiny
 *   turns) runs same-message `task` calls through the governed bridge. They must overlap (in-process promise
 *   latch, no sleeps) AND a deny verdict must still deny a hinted tool. The CLI version is tripwired so a
 *   behaviour flip on upgrade forces a revisit of CONCURRENCY_HINT_TOOLS -- via ONE
 *   explicit tripwire test (95ee2a24 AC5); every other test runs on any claude version.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { taskTool } from "../tools/task.js";
import { AGENT_MCP_SERVER_NAME, concurrencyHintAnnotations } from "../providers/claudecli.js";
import { startToolBridge } from "../providers/claudecli-tool-bridge.js";
import type { EngineLogger } from "../interfaces.js";
import { FAKE_CLAUDE, makeBridgeEnv, type IBridgeEnv } from "./fixtures/bridge-env.js";

const COUNTING = fileURLToPath(new URL("./fixtures/counting-mcp-server.mjs", import.meta.url));
/** claude CLI version the AC5 finding was recorded against; a different version must re-prove it. */
const PINNED_CLAUDE_VERSION = "2.1.296";
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const scratch: string[] = [];
const envs: IBridgeEnv[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.dispose();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(d);
  return d;
}

describe("424b6362 AC4: the real bridge advertises the concurrency hint on exactly the three tools", () => {
  it("424b6362 AC4: tools/list over HTTP carries readOnlyHint for task/tasks_batch/agent and nothing else", async () => {
    const names = ["task", "tasks_batch", "agent", "task_status", "bump"];
    const bridge = await startToolBridge({
      tools: names.map((n) => ({ name: `${AGENT_MCP_SERVER_NAME}__${n}`, description: "d", inputSchema: { type: "object" as const } })),
      logger,
      executeTool: async () => ({ result: "", isError: false }),
      toolAnnotations: (tool, _def, server) => concurrencyHintAnnotations(tool, server),
    });
    const client = new Client({ name: "t", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp/${AGENT_MCP_SERVER_NAME}`), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
      }));
      const listed = (await client.listTools()).tools;
      const hinted = listed.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
      expect(hinted).toEqual(["agent", "task", "tasks_batch"]);
      for (const t of listed.filter((x) => !hinted.includes(x.name))) expect(t.annotations).toBeUndefined();
    } finally {
      await client.close();
      await bridge.close();
    }
  });
});

describe("95ee2a24 AC1: a foreign server's same-named tools get no readOnlyHint from the real bridge", () => {
  it("95ee2a24 AC1: tools/list on a foreign route carries no annotations while agent-mcp's own route is hinted", async () => {
    const names = ["task", "tasks_batch", "agent"];
    const mk = (server: string) => names.map((n) => ({ name: `${server}__${n}`, description: "d", inputSchema: { type: "object" as const } }));
    const bridge = await startToolBridge({
      tools: [...mk(AGENT_MCP_SERVER_NAME), ...mk("foreign")],
      logger,
      executeTool: async () => ({ result: "", isError: false }),
      toolAnnotations: (tool, _def, server) => concurrencyHintAnnotations(tool, server),
    });
    const list = async (server: string) => {
      const client = new Client({ name: "t", version: "0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp/${server}`), {
          requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
        }));
        return (await client.listTools()).tools;
      } finally { await client.close(); }
    };
    try {
      const own = await list(AGENT_MCP_SERVER_NAME);
      expect(own.map((t) => t.annotations?.readOnlyHint)).toEqual([true, true, true]);
      const foreign = await list("foreign");
      expect(foreign.map((t) => t.name).sort()).toEqual(["agent", "task", "tasks_batch"]);
      for (const t of foreign) expect(t.annotations, `foreign ${t.name} must not be hinted`).toBeUndefined();
    } finally {
      await bridge.close();
    }
  });
});

describe("424b6362 AC6: per-run caps are exact under simultaneous same-message bridged calls", () => {
  const bumpEnv = (maxLoops: number): { env: IBridgeEnv; counter: string } => {
    const work = freshDir("adhd-par-race-");
    const counter = join(work, "counter.txt");
    const env = makeBridgeEnv({
      claudePath: FAKE_CLAUDE,
      maxLoops,
      mcpServers: { counter: { transport: "stdio", command: process.execPath, args: [COUNTING], env: { COUNTING_COUNTER_FILE: counter, COUNTING_PID_FILE: join(work, "pids.txt") } } },
      subprocessEnv: { ADHD_FAKE_CLAUDE_OUT: join(work, "self.json") },
    });
    envs.push(env);
    return { env, counter };
  };
  const runs = (counter: string): number => (existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0);
  const simultaneous = (n: number): string => JSON.stringify({ parallel: true, calls: Array.from({ length: n }, () => ({ server: "counter", tool: "bump" })) });

  it("424b6362 AC6: maxToolLoops=1 with two simultaneous calls executes exactly one (the other gets MAX_TOOL_LOOPS_EXCEEDED)", async () => {
    const { env, counter } = bumpEnv(1);
    const out = await taskTool({ agent_name: "bridge-agent", prompt: simultaneous(2) }, env.deps);
    expect(runs(counter)).toBe(1);
    expect(env.hookCounts).toEqual({ pre: 2, post: 1, transform: 1 });
    expect(out.status).toBe("failed");
    const [failed] = env.events(out.task_id, "TASK_FAILED");
    expect(String(failed?.["error"])).toContain("[MAX_TOOL_LOOPS_EXCEEDED]");
  }, 60_000);

  it("424b6362 AC6: maxToolLoops=3 with three simultaneous calls executes all three, each with its own bridge call id", async () => {
    const { env, counter } = bumpEnv(3);
    const out = await taskTool({ agent_name: "bridge-agent", prompt: simultaneous(3) }, env.deps);
    expect(out.status).toBe("completed");
    expect(runs(counter)).toBe(3);
    expect(env.hookCounts).toEqual({ pre: 3, post: 3, transform: 3 });
    const ids = env.events(out.task_id, "TOOL_CALL").map((e) => e["callId"]).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(3);
  }, 60_000);
});

/**
 * 95ee2a24 AC5 -- the ONE place a claude CLI version change is allowed to turn this lane red. The behaviour tests
 * below run on any installed version; only this tripwire compares the version against the one the finding was
 * recorded on, and it fails loudly with the steps to clear it.
 */
describe("95ee2a24 AC5: claude CLI version tripwire (the only version-pinned test)", () => {
  it("95ee2a24 AC5: the installed claude CLI is the version the same-message concurrency finding was recorded against", () => {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
    expect(r.status, "claude CLI must be installed to run this suite").toBe(0);
    const installed = r.stdout.trim().split(" ")[0];
    // eslint-disable-next-line no-console
    console.log("424b6362 AC5 claude version:", r.stdout.trim());
    expect(
      installed,
      [
        `claude CLI drifted: installed ${installed}, finding recorded on ${PINNED_CLAUDE_VERSION}.`,
        "This is a tripwire, not a product failure. To clear it:",
        "  1. Run the other tests in this file (they pass or fail on their own, on any version):",
        "     'same-message task calls overlap AND a deny verdict still denies' is the behavioural proof.",
        "  2. If they pass, set PINNED_CLAUDE_VERSION in this file to the installed version.",
        "  3. If overlap no longer needs readOnlyHint (or no longer happens with it), revisit",
        "     CONCURRENCY_HINT_TOOLS in providers/claudecli.ts and backlog f4aa41ec.",
      ].join("\n"),
    ).toBe(PINNED_CLAUDE_VERSION);
  });
});

describe("424b6362 AC5: real claude CLI, governed bridge, hinted task-shaped tools (runs on any claude version)", () => {
  it("424b6362 AC5: same-message task calls overlap AND a deny verdict still denies the hinted agent tool", { timeout: 240_000, retry: 1 }, async () => {
    const work = freshDir("adhd-par-real-");
    // agent-mcp's own tool names are served by the engine's in-process client (the server name `agent-mcp` is the
    // engine's self-reference), so the latch lives in-process: a promise latch decides overlap, a failure-only
    // deadline bounds it, nothing sleeps.
    const started = new Set<string>();
    const waiters: Array<() => void> = [];
    const bothStarted = (): boolean => started.has("a") && started.has("b");
    const inProcess = {
      descriptors: ["task", "agent"].map((name) => ({
        name, description: `Latch test tool ${name}. Pass id "a" or "b".`,
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      })),
      handler: async (tool: string, args: unknown): Promise<unknown> => {
        const id = String((args as { id?: unknown } | undefined)?.id ?? "");
        if (tool === "agent") {
          writeFileSync(join(work, "ran-agent"), id);
          return { content: [{ type: "text", text: `agent ran ${id}` }] };
        }
        started.add(id);
        for (const w of waiters.splice(0)) w();
        let timer: NodeJS.Timeout | undefined;
        if (!bothStarted()) {
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
            timer = setTimeout(resolve, 20_000); // failure-path bound only: serialised calls never see the peer
          });
        }
        if (timer) clearTimeout(timer);
        writeFileSync(join(work, `done-${id}`), JSON.stringify({ sawPeer: bothStarted() }));
        return { content: [{ type: "text", text: `done ${id}` }] };
      },
    };
    const env = makeBridgeEnv({
      mcpServers: { [AGENT_MCP_SERVER_NAME]: { transport: "stdio", command: "never-spawned", args: [] } /* placeholder: agent-mcp is served in-process */ },
      inProcess,
      gate: (c) => (c.tool === "agent" ? "deny" : "allow"),
      maxLoops: 8,
    });
    envs.push(env);
    const prompt =
      'In ONE single assistant message, issue THREE parallel tool calls: mcp__agent-mcp__task with id "a", ' +
      'mcp__agent-mcp__task with id "b", and mcp__agent-mcp__agent with id "c". Do not call anything else. ' +
      "After the results come back reply with the single word ok.";
    const out = await taskTool({ agent_name: "bridge-agent", prompt }, env.deps);
    expect(out.status).toBe("completed");
    // (b) the deny verdict held for the hinted tool: it never executed and the engine recorded the denial.
    expect(existsSync(join(work, "ran-agent"))).toBe(false);
    const denied = env.events(out.task_id, "TOOL_CALL").filter((e) => e["permission"] === "deny");
    expect(denied.map((e) => e["tool"])).toEqual([`${AGENT_MCP_SERVER_NAME}__agent`]);
    expect(denied[0]!["code"]).toBe("PERMISSION_DENIED");
    // (a) both task calls were in flight together: each saw its peer's start through the cross-process latch.
    for (const id of ["a", "b"]) {
      const done = JSON.parse(readFileSync(join(work, `done-${id}`), "utf8")) as { sawPeer: boolean };
      expect(done.sawPeer, `task ${id} never saw its peer: the CLI serialised same-message calls (424b6362)`).toBe(true);
    }
  });
});
