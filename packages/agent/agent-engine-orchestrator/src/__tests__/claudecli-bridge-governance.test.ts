/**
 * f9dadeaa — claudecli bridge governance bypass (spawn-free unit lane).
 *
 * The claudecli provider runs its own tool loop inside the `claude` child; every MCP tool call it makes
 * reaches the engine through `ProviderChatRequest.executeTool`. That seam used to skip the permission
 * gate, `pre:tool_call`, `policy.check` / `toolCallCount`, `post:tool_call` and `transform:tool_result`.
 * These tests drive the REAL `Orchestrator.run` with a provider that calls `executeTool` exactly the way
 * the bridge does, and compare against an engine-native control (a provider returning `toolCalls`).
 * Built-in (CLI) governance is asserted on the real `ClaudeCliProvider` spawn argv with only
 * `child_process.spawn` mocked. No subprocess is started and no port is bound; the end-to-end proof
 * through the real loopback bridge + a real MCP server is `claudecli-bridge-governance.e2e.test.ts`.
 *
 * Teeth: with `governToolCall` removed from the bridge `executeTool` (negative control run when this file
 * was authored) every GOV-AC1..4 assertion below goes red.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "stream";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { AgentDefinition, PermissionAction } from "@adhd/agent-base-types";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";
import { CLAUDE_BUILTIN_SERVER } from "../providers/types.js";
import { Orchestrator } from "../engine/orchestrator.js";
import { PolicyEngine } from "../engine/policy.js";
import { HookRegistry } from "../engine/hooks.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const silent: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} };
const nowIso = () => new Date().toISOString();

type Mode = "native" | "bridged";
type Gate = (c: { server: string; tool: string }) => PermissionAction;

async function drive(mode: Mode, gate: Gate | undefined, nCalls: number, maxLoops: number) {
  const executed: string[] = [];
  const seen = { pre: 0, post: 0, transform: 0 };
  const hooks = new HookRegistry();
  hooks.register("pre:tool_call" as never, (async () => { seen.pre++; }) as never);
  hooks.register("post:tool_call" as never, (async () => { seen.post++; }) as never);
  hooks.register("transform:tool_result" as never, (async () => { seen.transform++; }) as never);

  const tool = { name: "counter__bump", description: "b", inputSchema: { type: "object", properties: {} } };
  const registry = {
    listAllTools: async () => [tool],
    closeAll: async () => {},
    getClient: async (s: string) => ({
      callTool: async (t: string) => { executed.push(`${s}__${t}`); return { ok: true }; },
    }),
  };
  const modelSaw: Array<{ result: unknown; isError: boolean }> = [];
  let turn = 0;
  const provider = {
    chat: async (req: ProviderChatRequest) => {
      turn++;
      if (mode === "bridged") {
        for (let i = 0; i < nCalls; i++) modelSaw.push(await req.executeTool!("counter", "bump", {}));
        return { message: { id: "m", sessionId: "s", role: "assistant", content: "done", createdAt: nowIso() }, stopReason: "completed" as const };
      }
      if (turn > nCalls) return { message: { id: `m${turn}`, sessionId: "s", role: "assistant", content: "done", createdAt: nowIso() }, stopReason: "completed" as const };
      return {
        message: { id: `m${turn}`, sessionId: "s", role: "assistant", content: "", createdAt: nowIso(), toolCalls: [{ id: `c${turn}`, server: "counter", tool: "bump", arguments: {} }] },
        stopReason: "tool_calls" as const,
      };
    },
  };
  const def = { name: "a", version: 1, provider: { type: "openai", model: "x" }, systemPrompt: "s", mcpServers: {}, permissions: {}, maxToolLoops: maxLoops, createdAt: nowIso(), updatedAt: nowIso() } as unknown as AgentDefinition;
  const ctx = { taskId: "t", sessionId: "s", agentName: "a", agentDefinition: def, recursionDepth: 0, toolCallCount: 0 };
  const nativeResults: Array<{ result: unknown; isError: boolean }> = [];
  const sessionStore = {
    appendMessage: async (_s: string, m: { role: string; toolResults?: Array<{ result: unknown; isError: boolean }> }) => {
      if (m.role === "tool") for (const r of m.toolResults ?? []) nativeResults.push(r);
    },
    close() {},
  };
  const taskStore = { updateStatus() {}, appendEvent() {}, unregisterCancellation() {} };
  let err: string | undefined;
  try {
    await new Orchestrator().run({
      executionContext: ctx, messages: [{ id: "u", sessionId: "s", role: "user", content: "hi", createdAt: nowIso() }],
      registry, provider, policy: new PolicyEngine({ serverMaxDepth: 5, serverMaxToolLoops: maxLoops }), taskStore, sessionStore,
      signal: new AbortController().signal, taskId: "t", hooks, logger: silent,
      config: {
        server: { contextLimit: 0, defaultMaxTokens: 1024 }, queue: { concurrency: 1 }, sse: { baseUrl: "http://x" }, plugins: { entries: [] },
        getProviderConfig: () => ({}), subprocessEnv: () => ({}), resolveEnvName: () => undefined, isEnvNameAllowed: () => true,
        ...(gate ? { permissionGate: (c: never) => gate(c) } : {}),
      },
    } as never);
  } catch (e) { err = e instanceof Error ? e.message : String(e); }
  return { executed, seen, modelSaw: mode === "bridged" ? modelSaw : nativeResults, err, toolCallCount: ctx.toolCallCount };
}

const text = (r: { result: unknown }) => JSON.stringify(r.result);

describe("f9dadeaa GOV-AC1: a denied tool is not executed over the bridge", () => {
  it("f9dadeaa GOV-AC1: deny -> handler count 0, the model sees PERMISSION_DENIED (same payload as native)", async () => {
    const gate: Gate = (c) => (c.tool === "bump" ? "deny" : "allow");
    const b = await drive("bridged", gate, 1, 5);
    const n = await drive("native", gate, 1, 5);
    expect(b.executed).toEqual([]);
    expect(b.modelSaw).toHaveLength(1);
    expect(b.modelSaw[0]!.isError).toBe(true);
    expect(text(b.modelSaw[0]!)).toContain("PERMISSION_DENIED");
    expect(b.modelSaw[0]!.result).toEqual(n.modelSaw[0]!.result);
    expect(b.err).toBeUndefined();
  });
});

describe("f9dadeaa GOV-AC2: an ask verdict fails closed on the bridge", () => {
  it("f9dadeaa GOV-AC2: ask -> not executed, PERMISSION_ASK_DENIED naming the bridge's lack of HITL", async () => {
    const b = await drive("bridged", () => "ask", 1, 5);
    expect(b.executed).toEqual([]);
    expect(b.modelSaw[0]!.isError).toBe(true);
    expect(text(b.modelSaw[0]!)).toContain("PERMISSION_ASK_DENIED");
    expect(text(b.modelSaw[0]!)).toMatch(/HITL suspend is not supported over the claudecli tool bridge/);
  });
});

describe("f9dadeaa GOV-AC3: maxToolLoops bounds bridged calls", () => {
  it("f9dadeaa GOV-AC3: maxToolLoops=1 with 3 bridged calls executes at most 1 and returns the native cap error", async () => {
    const b = await drive("bridged", undefined, 3, 1);
    expect(b.executed).toHaveLength(1);
    expect(b.modelSaw).toHaveLength(3);
    expect(b.modelSaw[0]!.isError).toBe(false);
    for (const r of b.modelSaw.slice(1)) {
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("MAX_TOOL_LOOPS_EXCEEDED");
    }
    // The task fails exactly as the native path does (native throws the same ToolError out of run()).
    const n = await drive("native", undefined, 3, 1);
    expect(n.err).toContain("Tool call count 1 has reached or exceeded the maximum of 1");
    expect(b.err).toBe(n.err);
    expect(b.toolCallCount).toBe(n.toolCallCount);
  });
});

describe("f9dadeaa GOV-AC4/AC6: hooks fire for bridged calls exactly as native; native is unchanged", () => {
  it("f9dadeaa GOV-AC4: pre/post/transform counts for N allowed bridged calls equal the native control", async () => {
    const b = await drive("bridged", () => "allow", 2, 5);
    const n = await drive("native", () => "allow", 2, 5);
    expect(n.seen).toEqual({ pre: 2, post: 2, transform: 2 });
    expect(b.seen).toEqual(n.seen);
    expect(b.executed).toHaveLength(2);
    expect(b.toolCallCount).toBe(2);
  });

  it("f9dadeaa GOV-AC4: a gate-refused bridged call fires no pre/post/transform hooks, like native (the gate runs before pre:tool_call)", async () => {
    const b = await drive("bridged", () => "deny", 1, 5);
    const n = await drive("native", () => "deny", 1, 5);
    expect(b.seen).toEqual(n.seen);
    expect(b.seen).toEqual({ pre: 0, post: 0, transform: 0 });
  });

  it("f9dadeaa GOV-AC6: native deny and native cap behave as before", async () => {
    const d = await drive("native", () => "deny", 1, 5);
    expect(d.executed).toEqual([]);
    expect(text(d.modelSaw[0]!)).toContain("PERMISSION_DENIED");
    const c = await drive("native", () => "allow", 3, 1);
    expect(c.executed).toHaveLength(1);
    expect(c.err).toContain("maximum of 1");
  });
});

// ── GOV-AC5: CLI built-ins cannot bypass the gate (spawn argv) ───────────────────────────────────

const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1 });
const scratchRoot = mkdtempSync(join(tmpdir(), "f9dadeaa-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

function fakeProc() {
  const stdout = new Readable({ read() {} });
  queueMicrotask(() => { stdout.push(RESULT_LINE + "\n"); stdout.push(null); });
  return { stdout, stdin: { write: () => true, end: () => {} }, stderr: new Readable({ read() {} }), pid: undefined, on: () => {}, kill: () => {}, exitCode: 0, killed: false };
}

async function spawnArgv(opts: { allowed?: string[]; spec?: boolean; policy?: (tool: string) => PermissionAction }) {
  const { spawn } = await import("child_process");
  const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
  spawnMock.mockReset();
  spawnMock.mockReturnValue(fakeProc());
  const { ClaudeCliProvider } = await import("../providers/claudecli.js");
  const provider = new ClaudeCliProvider(
    { type: "claudecli", model: "claude-haiku-4-5", ...(opts.allowed ? { allowedBuiltinTools: opts.allowed } : {}), ...(opts.spec ? { systemPromptIsAgentSpec: true } : {}) } as never,
    {}, undefined,
    { wire: { tempDir: scratchRoot }, server: { contextLimit: 0, defaultMaxTokens: 1 }, subprocessEnv: () => ({}), resolveEnvName: () => undefined } as unknown as EngineConfig,
    silent,
  );
  const messages = opts.spec
    ? [{ role: "system", content: "---\nname: s\ndescription: d\ntools: Bash\n---\nbody" }, { role: "user", content: "go" }]
    : [{ role: "user", content: "go" }];
  const req = { messages, ...(opts.policy ? { builtinToolPolicy: opts.policy } : {}) } as unknown as ProviderChatRequest;
  let error: unknown;
  try { await provider.chat(req); } catch (e) { error = e; }
  return { args: spawnMock.mock.calls[0]?.[1] as string[] | undefined, spawned: spawnMock.mock.calls.length > 0, error };
}

const gateFor = (verdicts: Record<string, PermissionAction>) => (tool: string): PermissionAction => verdicts[tool] ?? "allow";

describe("f9dadeaa GOV-AC5: CLI built-ins cannot bypass the gate", () => {
  it("f9dadeaa GOV-AC5: a denied built-in is absent from --tools; allowed ones remain", async () => {
    const { args } = await spawnArgv({ allowed: ["Read", "Bash", "Write"], policy: gateFor({ Bash: "deny" }) });
    expect(args![args!.indexOf("--tools") + 1]).toBe("Read,Write");
  });

  it("f9dadeaa GOV-AC5: an ask built-in is withheld too (ask cannot be answered inside the CLI loop)", async () => {
    const { args } = await spawnArgv({ allowed: ["Read", "Bash"], policy: gateFor({ Read: "ask" }) });
    expect(args![args!.indexOf("--tools") + 1]).toBe("Bash");
  });

  it("f9dadeaa GOV-AC5: the gate is consulted with server 'claude-builtin'", async () => {
    const seen: string[] = [];
    await spawnArgv({ allowed: ["Edit"], policy: (t) => { seen.push(t); return "allow"; } });
    expect(seen).toContain("Edit");
    expect(CLAUDE_BUILTIN_SERVER).toBe("claude-builtin");
  });

  it("f9dadeaa GOV-AC5: no policy / all allowed leaves --tools unchanged (no regression)", async () => {
    const { args } = await spawnArgv({ allowed: ["Read", "Bash"] });
    expect(args![args!.indexOf("--tools") + 1]).toBe("Read,Bash");
  });

  it("f9dadeaa GOV-AC5: agent-spec mode FAILS CLOSED (no spawn) when the gate denies a built-in", async () => {
    const r = await spawnArgv({ spec: true, allowed: ["Read"], policy: gateFor({ Bash: "deny" }) });
    expect(r.spawned).toBe(false);
    expect(String(r.error)).toMatch(/refuses to spawn in agent-spec mode/);
    expect(String(r.error)).toContain("Bash=deny");
  });

  it("f9dadeaa GOV-AC5: agent-spec mode fails closed on a wildcard deny even for a built-in the list does not name", async () => {
    const r = await spawnArgv({ spec: true, policy: () => "deny" });
    expect(r.spawned).toBe(false);
    expect(String(r.error)).toContain("__unlisted_builtin__=deny");
  });

  it("f9dadeaa GOV-AC5: agent-spec mode still spawns when every built-in is allowed", async () => {
    const r = await spawnArgv({ spec: true, policy: () => "allow" });
    expect(r.spawned).toBe(true);
    expect(r.args).toContain("--agent");
  });
});
