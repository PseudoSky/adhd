/**
 * Tests for the `agent-mcp-follow` bin's EXIT-CODE contract (bucket-d
 * post-merge-review follow-up).
 *
 * These drive the REAL built bin (`dist/src/scripts/agent-mcp-follow.js`) as a
 * child process — the same way dispatch-cli / a caller invokes it — because the
 * failures they guard are about the PROCESS exit status, which no in-process
 * unit test can observe:
 *
 *   - a stream that ends without the terminal `done` must exit NON-ZERO;
 *     previously `followTaskStream` resolved `status:null` and the bin mapped
 *     `null -> exit 0` — a false success.
 *   - an unparseable `--base-url` must exit 2 (usage error) with no Node stack
 *     trace; previously `new URL(...)` threw synchronously past the bin's
 *     `.catch` (uncaught → exit 1 + stack).
 *
 * A success control (a well-formed `done` stream → exit 0) proves the harness
 * can actually observe success, so the non-zero assertions have teeth.
 *
 * The bin only needs Node builtins + its own dist, so no DB, no provider, and
 * no network beyond loopback are touched. Tests run by default (no env gate).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// __tests__ -> src -> agent-mcp -> entrypoint -> repo root.
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const DIST_BIN = join(REPO_ROOT, "entrypoint", "agent-mcp", "dist", "src", "scripts", "agent-mcp-follow.js");

const TASK_ID = "44444444-4444-4444-8444-444444444444";

const openServers: http.Server[] = [];

afterEach(async () => {
    await Promise.all(
        openServers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res())))
    );
});

/** Starts a raw `text/event-stream` responder on an ephemeral loopback port. */
async function listenEphemeralSse(handler: (res: http.ServerResponse) => void): Promise<number> {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.flushHeaders?.();
        handler(res);
    });
    openServers.push(server);
    return new Promise<number>((resolvePort) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            resolvePort(addr && typeof addr === "object" ? addr.port : 0);
        });
    });
}

/**
 * Runs the built bin with `args` and resolves on process exit.
 * DEBT-AGENTMCP-TEST-ENV-LEAK-001: ambient `ADHD_AGENT_*` keys are stripped so a
 * runner's env can never influence the child (the bin touches no DB, but the
 * discipline is uniform across this package's spawn tests).
 */
function runBin(
    args: string[],
    timeoutMs = 20_000
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
    return new Promise((resolveRun, rejectRun) => {
        const env: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (key.startsWith("ADHD_AGENT_")) continue;
            if (value !== undefined) env[key] = value;
        }

        let child: ChildProcess;
        try {
            child = spawn(process.execPath, [DIST_BIN, ...args], {
                env,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (err) {
            rejectRun(err);
            return;
        }

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            rejectRun(new Error(`bin timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, timeoutMs);

        child.on("error", (err) => { clearTimeout(timer); rejectRun(err); });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolveRun({ code, signal, stdout, stderr });
        });
    });
}

describe("agent-mcp-follow bin exit codes", () => {
    it(
        `is built and present at ${DIST_BIN} (fail loudly, never skip)`,
        () => {
            expect(
                existsSync(DIST_BIN),
                `expected the built bin at ${DIST_BIN} — run "npx nx build agent-mcp" first`
            ).toBe(true);
        }
    );

    it("exits 0 when a well-formed stream delivers a terminal `done` (success control)", async () => {
        const port = await listenEphemeralSse((res) => {
            res.write(`event: token\ndata: ${JSON.stringify({ type: "token", taskId: TASK_ID, chunk: "ok" })}\n\n`);
            res.write(
                `event: done\ndata: ${JSON.stringify({ type: "done", taskId: TASK_ID, result: "ok", error: null })}\n\n`
            );
            res.end();
        });

        const { code } = await runBin(["--task", TASK_ID, "--base-url", `http://127.0.0.1:${port}`]);
        expect(code).toBe(0);
    });

    it("exits NON-ZERO (never the false-success 0) when the stream ends without a terminal `done`", async () => {
        const port = await listenEphemeralSse((res) => {
            res.write(`event: token\ndata: ${JSON.stringify({ type: "token", taskId: TASK_ID, chunk: "partial" })}\n\n`);
            res.end(); // truncated: task outcome is unknown
        });

        const { code, stderr } = await runBin(["--task", TASK_ID, "--base-url", `http://127.0.0.1:${port}`]);
        expect(code).toBe(1);
        expect(stderr).toMatch(/ended before the terminal 'done'/);
    });

    it("exits 2 with no stack trace for an unparseable --base-url", async () => {
        const { code, stderr } = await runBin(["--task", TASK_ID, "--base-url", "not a valid url"]);
        expect(code).toBe(2);
        expect(stderr).toMatch(/invalid base URL/);
        // No V8 stack frames, no raw TypeError leaking past the bin's .catch.
        expect(stderr).not.toMatch(/\n\s+at\s/);
        expect(stderr).not.toContain("TypeError");
    });
});
