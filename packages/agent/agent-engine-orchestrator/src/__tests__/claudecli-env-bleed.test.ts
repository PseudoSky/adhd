import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "stream";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";

/**
 * Proves the fix for backlog 322a1efb — two independent hazards in
 * `ClaudeCliProvider`:
 *
 *  1. **Env bleed / nested-claude wedge.** `buildSubprocessEnv()` used to copy
 *     EVERY entry of `process.env` into the spawned `claude -p` child. When the
 *     engine runs inside an interactive Claude Code session, `CLAUDECODE`, the
 *     session-id vars, etc. leak into the nested CLI, which then believes it is
 *     already inside a session and wedges
 *     (anthropics/claude-code#25803, anthropics/claude-code#29543).
 *
 *  2. **Non-group child termination.** The `finally` block did a bare
 *     `proc.kill("SIGTERM")`, signalling only the direct child and orphaning the
 *     CLI's own MCP-server / tool subprocesses.
 *
 * Each assertion below FAILS if its half of the fix is reverted.
 */

vi.mock("child_process", () => ({
    spawn: vi.fn(),
}));

function makeFakeProc(opts: { pid?: number; hang?: boolean } = {}) {
    const stdout = new Readable({ read() {} });
    const stdin = { write: () => true, end: () => {} };
    const proc = {
        stdout,
        stdin,
        stderr: new Readable({ read() {} }),
        pid: opts.pid,
        on: () => {},
        kill: vi.fn(),
        // A "hang" proc must look alive (exitCode null) or terminateProcessTree
        // early-returns before signalling it.
        exitCode: (opts.hang ? null : 0) as number | null,
        killed: false,
    };
    // A result event only if the test is not meant to hang.
    if (!opts.hang) {
        queueMicrotask(() => {
            stdout.push(
                JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK" }) + "\n"
            );
            stdout.push(null);
        });
    }
    return proc;
}

const engineConfig: EngineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: "" },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    // Host tries to re-add a session var — the provider must strip it anyway.
    subprocessEnv: () => ({ ADHD_AGENT_PASSTHROUGH: "yes", CLAUDECODE: "1" }),
    resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
} as unknown as EngineConfig;

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const request: ProviderChatRequest = {
    messages: [{ role: "user", content: "Say OK" } as ProviderChatRequest["messages"][number]],
};

async function captureSpawnEnv(pid?: number) {
    const { spawn } = await import("child_process");
    const proc = makeFakeProc({ pid });
    const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
    spawnMock.mockClear();
    spawnMock.mockReturnValue(proc);
    const { ClaudeCliProvider } = await import("../providers/claudecli.js");
    const provider = new ClaudeCliProvider(
        { type: "claudecli", model: "claude-haiku-4-5" },
        {},
        undefined,
        engineConfig,
        logger
    );
    await provider.chat(request);
    return { spawnMock, proc };
}

describe("ClaudeCliProvider — enclosing-session env bleed (322a1efb)", () => {
    const saved: Record<string, string | undefined> = {};
    afterEach(() => {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        vi.restoreAllMocks();
    });

    function setEnv(k: string, v: string) {
        saved[k] = process.env[k];
        process.env[k] = v;
    }

    it("strips CLAUDECODE / session-id vars from the spawned child env", async () => {
        setEnv("CLAUDECODE", "1");
        setEnv("CLAUDE_CODE_SESSION_ID", "sess-abc");
        setEnv("CLAUDE_SESSION_ID", "sess-def");
        setEnv("CLAUDE_CODE_ENTRYPOINT", "cli");
        setEnv("ADHD_KEEP_ME", "parent-value");

        const { spawnMock } = await captureSpawnEnv();
        const env = (spawnMock.mock.calls[0][2] as { env: Record<string, string> }).env;

        expect(env.CLAUDECODE).toBeUndefined();
        expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
        expect(env.CLAUDE_SESSION_ID).toBeUndefined();
        expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
        // ...without over-stripping: ordinary parent vars + host passthrough survive.
        expect(env.ADHD_KEEP_ME).toBe("parent-value");
        expect(env.ADHD_AGENT_PASSTHROUGH).toBe("yes");
    });

    it("keeps CLAUDE_CONFIG_DIR / ANTHROPIC_* (auth must still reach the child)", async () => {
        setEnv("CLAUDE_CONFIG_DIR", "/home/u/.claude");
        setEnv("ANTHROPIC_API_KEY", "sk-test");
        const { spawnMock } = await captureSpawnEnv();
        const env = (spawnMock.mock.calls[0][2] as { env: Record<string, string> }).env;
        expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude");
        expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
    });

    it("spawns the child detached on POSIX (own process group)", async () => {
        const { spawnMock } = await captureSpawnEnv();
        const options = spawnMock.mock.calls[0][2] as { detached?: boolean };
        expect(options.detached).toBe(process.platform !== "win32");
    });
});

describe("ClaudeCliProvider — group-aware teardown (322a1efb)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("signals the whole process group when the request aborts mid-flight", async () => {
        const { spawn } = await import("child_process");
        const proc = makeFakeProc({ pid: 4242, hang: true });
        const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
        spawnMock.mockClear();
        spawnMock.mockReturnValue(proc);

        const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as never);

        const { ClaudeCliProvider } = await import("../providers/claudecli.js");
        const provider = new ClaudeCliProvider(
            { type: "claudecli", model: "claude-haiku-4-5" },
            {},
            undefined,
            engineConfig,
            logger
        );

        const controller = new AbortController();
        const promise = provider.chat({ ...request, signal: controller.signal }).catch(() => undefined);

        // Let the provider wire its abort listener + enter the read loop.
        await new Promise((r) => setImmediate(r));
        controller.abort();
        await new Promise((r) => setImmediate(r));

        if (process.platform === "win32") {
            expect(proc.kill).toHaveBeenCalled();
        } else {
            expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
        }

        // The abort listener fired; now unblock the read loop deterministically
        // (a line makes the loop re-check `signal.aborted`) so chat() settles.
        proc.stdout.push("\n");
        proc.stdout.push(null);
        await promise;
    });
});
