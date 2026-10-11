/**
 * cf7e0e5c review-6: the `provider:builtin_bypass` emit is awaited, not fire-and-forget. The provider
 * finishes persisting the disclosure BEFORE its first CLI turn, so a caller that reads `task_events` right
 * after `await provider.chat(...)` cannot race it. Deterministic: a latch holds the emit open; no timing.
 */
import { Readable } from "stream";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionContext, IHookRegistry } from "@adhd/agent-base-types";
import { createProvider } from "../providers/factory.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const noop = (): void => undefined;
const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", num_turns: 1 });
function fakeProc() {
  const stdout = new Readable({ read: noop });
  queueMicrotask(() => { stdout.push(RESULT_LINE + "\n"); stdout.push(null); });
  return { stdout, stdin: { write: () => true, end: noop }, stderr: new Readable({ read: noop }), pid: undefined, on: noop, kill: noop, exitCode: 0, killed: false };
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r)); };

const ctx = {
  taskId: "t-order", sessionId: "s-order", agentId: "a", userId: "u",
  selection: { providerType: "claudecli", modelRef: "claude-haiku-4-5" },
} as unknown as ExecutionContext;

function build(emit: IHookRegistry["emit"]) {
  return createProvider(
    ctx.selection as never,
    {},
    { wire: { tempDir: process.cwd() }, server: { contextLimit: 0, defaultMaxTokens: 1 }, subprocessEnv: () => ({}), resolveEnvName: () => undefined } as never,
    { info: noop, warn: noop, error: noop, debug: noop } as never,
    { hooks: { emit } as unknown as IHookRegistry, executionContext: ctx, claudecli: { allowedBuiltinTools: ["Edit"] } }
  );
}

describe("cf7e0e5c review-6: provider:builtin_bypass emit completes before the first CLI turn", () => {
  it("cf7e0e5c review-6: chat() holds the spawn until the emit settles, and a failed emit does not fail the chat", async () => {
    const { spawn } = await import("child_process");
    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakeProc());

    let release!: () => void;
    const latch = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const emit = vi.fn(async () => { order.push("emit:start"); await latch; order.push("emit:done"); });
    spawnMock.mockImplementation(() => { order.push("spawn"); return fakeProc(); });

    const chat = build(emit as never).chat({ messages: [{ role: "user", content: "go" }] } as never);
    await settle();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["emit:start"]); // emit open => CLI not spawned yet
    release();
    await chat;
    expect(order).toEqual(["emit:start", "emit:done", "spawn"]);
  });

  it("cf7e0e5c review-6: a rejecting emit is swallowed (observational) and the chat still completes", async () => {
    const { spawn } = await import("child_process");
    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    spawnMock.mockReset();
    spawnMock.mockReturnValue(fakeProc());
    const emit = vi.fn(async () => { throw new Error("sink down"); });
    await expect(build(emit as never).chat({ messages: [{ role: "user", content: "go" }] } as never)).resolves.toBeDefined();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
