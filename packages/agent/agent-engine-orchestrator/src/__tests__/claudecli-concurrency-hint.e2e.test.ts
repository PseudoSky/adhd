/**
 * 424b6362 (R3-PAR-B) AC4/AC5/AC6 e2e (ADR-0009 e2e lane; not env-gated).
 *
 * - AC4 (wired): the REAL loopback bridge, with the provider's hook, advertises readOnlyHint on
 *   exactly task / tasks_batch / agent in tools/list (real MCP client over HTTP).
 * - AC6 (race-safety): the real taskTool -> Orchestrator -> ClaudeCliProvider -> bridge ->
 *   McpClientRegistry -> stdio server chain, driven by a stand-in `claude` that fires its tool calls
 *   SIMULTANEOUSLY (fake-claude-mcp.mjs `parallel:true`). Per-run caps must be exact under that race.
 * - AC5 (tripwire): the REAL `claude` CLI (haiku-4-5; paid, but NOT env-gated: a handful of tiny
 *   turns) runs same-message `task` calls through the governed bridge. They must overlap (cross-process
 *   latch, no sleeps) AND a deny verdict must still deny a hinted tool. The CLI version is pinned so a
 *   behaviour flip on upgrade forces a revisit of CONCURRENCY_HINT_TOOLS.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { taskTool } from "../tools/task.js";
import { concurrencyHintAnnotations } from "../providers/claudecli.js";
import { startToolBridge } from "../providers/claudecli-tool-bridge.js";
import type { EngineLogger } from "../interfaces.js";
import { FAKE_CLAUDE, makeBridgeEnv, type IBridgeEnv } from "./fixtures/bridge-env.js";

const COUNTING = fileURLToPath(new URL("./fixtures/counting-mcp-server.mjs", import.meta.url));
const LATCH = fileURLToPath(new URL("./fixtures/latch-mcp-server.mjs", import.meta.url));
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
      tools: names.map((n) => ({ name: `s__${n}`, description: "d", inputSchema: { type: "object" as const } })),
      logger,
      executeTool: async () => ({ result: "", isError: false }),
      toolAnnotations: (tool) => concurrencyHintAnnotations(tool),
    });
    const client = new Client({ name: "t", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp/s`), {
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

describe("424b6362 AC5: real claude CLI, governed bridge, hinted task-shaped tools", () => {
  it("424b6362 AC5: claude CLI version is the one the finding was recorded against", () => {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
    expect(r.status, "claude CLI must be installed to run this suite").toBe(0);
    // eslint-disable-next-line no-console
    console.log("424b6362 AC5 claude version:", r.stdout.trim());
    expect(r.stdout.trim().split(" ")[0], "claude CLI changed: re-run this suite and revisit CONCURRENCY_HINT_TOOLS (424b6362)").toBe(PINNED_CLAUDE_VERSION);
  });

  it("424b6362 AC5: same-message task calls overlap AND a deny verdict still denies the hinted agent tool", { timeout: 240_000, retry: 1 }, async () => {
    const work = freshDir("adhd-par-real-");
    const env = makeBridgeEnv({
      mcpServers: { latch: { transport: "stdio", command: process.execPath, args: [LATCH], env: { LATCH_DIR: work, LATCH_DEADLINE_MS: "20000" } } },
      gate: (c) => (c.tool === "agent" ? "deny" : "allow"),
      maxLoops: 8,
    });
    envs.push(env);
    const prompt =
      'In ONE single assistant message, issue THREE parallel tool calls: mcp__latch__task with id "a", ' +
      'mcp__latch__task with id "b", and mcp__latch__agent with id "c". Do not call anything else. ' +
      "After the results come back reply with the single word ok.";
    const out = await taskTool({ agent_name: "bridge-agent", prompt }, env.deps);
    expect(out.status).toBe("completed");
    // (b) the deny verdict held for the hinted tool: it never executed and the engine recorded the denial.
    expect(existsSync(join(work, "ran-agent"))).toBe(false);
    const denied = env.events(out.task_id, "TOOL_CALL").filter((e) => e["permission"] === "deny");
    expect(denied.map((e) => e["tool"])).toEqual(["latch__agent"]);
    expect(denied[0]!["code"]).toBe("PERMISSION_DENIED");
    // (a) both task calls were in flight together: each saw its peer's start through the cross-process latch.
    for (const id of ["a", "b"]) {
      const done = JSON.parse(readFileSync(join(work, `done-${id}`), "utf8")) as { sawPeer: boolean };
      expect(done.sawPeer, `task ${id} never saw its peer: the CLI serialised same-message calls (424b6362)`).toBe(true);
    }
  });
});
