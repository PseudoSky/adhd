/**
 * b8372f5a (D1) — a `claude` child that fails to start (binary missing from PATH => spawn ENOENT)
 * is reported as PROVIDER_ERROR naming the binary and the PATH, never as the PROVIDER_AUTH_ERROR
 * "returned empty result / check `claude auth status`" message.
 *
 * Unit lane (ADR-0009): `child_process.spawn` is the only replaced boundary. The real-subprocess
 * proof (a genuinely absent binary through the real spawn path) is `claudecli-spawn-failure.e2e.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "stream";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";
import { ToolError } from "../validation/errors.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const engineConfig = {
  server: { contextLimit: 0, defaultMaxTokens: 8192 },
  queue: { concurrency: 1 },
  sse: { baseUrl: "" },
  plugins: { entries: [] },
  getProviderConfig: () => ({}),
  subprocessEnv: () => ({ PATH: "/nowhere/bin" }),
  resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
} as unknown as EngineConfig;
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const request: ProviderChatRequest = {
  messages: [{ role: "user", content: "Say OK" } as ProviderChatRequest["messages"][number]],
};

type Behaviour = { kind: "spawn-error"; err: NodeJS.ErrnoException } | { kind: "empty" } | { kind: "ok" };

/** A fake child. `spawn-error` mirrors node: `error` fires once a listener exists and stdout closes with no data. */
function fakeProc(b: Behaviour) {
  const stdout = new Readable({ read() {} });
  const proc = {
    stdout,
    stdin: { write: () => true, end: () => {} },
    stderr: new Readable({ read() {} }),
    pid: undefined as number | undefined,
    on: (event: string, cb: (e: Error) => void) => {
      if (event === "error" && b.kind === "spawn-error") {
        queueMicrotask(() => {
          cb(b.err);
          stdout.push(null);
        });
      }
    },
    once: () => {},
    kill: vi.fn(),
    exitCode: 0 as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
  };
  if (b.kind === "empty") queueMicrotask(() => stdout.push(null));
  if (b.kind === "ok") {
    queueMicrotask(() => {
      stdout.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK" }) + "\n");
      stdout.push(null);
    });
  }
  return proc;
}

async function chatWith(b: Behaviour, claudePath?: string) {
  const { spawn } = await import("child_process");
  const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
  spawnMock.mockReset();
  spawnMock.mockReturnValue(fakeProc(b));
  const { ClaudeCliProvider } = await import("../providers/claudecli.js");
  const provider = new ClaudeCliProvider(
    { type: "claudecli", model: "claude-haiku-4-5", ...(claudePath ? { claudePath } : {}) },
    {},
    undefined,
    engineConfig,
    logger
  );
  return provider.chat(request);
}

const enoent = (bin: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`spawn ${bin} ENOENT`), { code: "ENOENT", errno: -2, syscall: `spawn ${bin}`, path: bin });

describe("claudecli spawn failure (b8372f5a)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("b8372f5a D1-AC1: spawn ENOENT rejects with PROVIDER_ERROR naming ENOENT, the binary and the PATH", async () => {
    const err = await chatWith({ kind: "spawn-error", err: enoent("claude") }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ToolError);
    const te = err as ToolError;
    expect(te.code).toBe("PROVIDER_ERROR");
    expect(te.message).toContain("spawn claude ENOENT");
    expect(te.message).toContain("`claude` binary was not found");
    expect(te.message).toContain("PATH=/nowhere/bin");
    expect(te.message).not.toContain("auth status");
    expect((te.data as { spawnErrorCode?: string }).spawnErrorCode).toBe("ENOENT");
  });

  it("b8372f5a D1-AC1: a configured claudePath is the binary named in the error", async () => {
    const te = (await chatWith({ kind: "spawn-error", err: enoent("/opt/x/claude") }, "/opt/x/claude").then(
      () => undefined,
      (e: unknown) => e
    )) as ToolError;
    expect(te.code).toBe("PROVIDER_ERROR");
    expect(te.message).toContain("`/opt/x/claude` binary was not found");
  });

  it("b8372f5a D1-AC1: a non-ENOENT spawn failure (EACCES) is also PROVIDER_ERROR with its code, no PATH claim", async () => {
    const eacces = Object.assign(new Error("spawn claude EACCES"), { code: "EACCES" });
    const te = (await chatWith({ kind: "spawn-error", err: eacces }).then(
      () => undefined,
      (e: unknown) => e
    )) as ToolError;
    expect(te.code).toBe("PROVIDER_ERROR");
    expect(te.message).toContain("(EACCES)");
    expect(te.message).not.toContain("was not found");
  });

  it("b8372f5a D1-AC2: a started CLI that returns nothing is still the PROVIDER_AUTH_ERROR empty-result error", async () => {
    const te = (await chatWith({ kind: "empty" }).then(
      () => undefined,
      (e: unknown) => e
    )) as ToolError;
    expect(te.code).toBe("PROVIDER_AUTH_ERROR");
    expect(te.message).toContain("Claude CLI returned empty result.");
    expect(te.message).toContain("`claude auth status`");
  });

  it("b8372f5a D1-AC2: a normal result is unaffected", async () => {
    const res = await chatWith({ kind: "ok" });
    expect(res.message.content).toBe("OK");
  });
});
