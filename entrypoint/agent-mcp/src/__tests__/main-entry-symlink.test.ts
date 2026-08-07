/**
 * Teeth test for BUG-011 (CRITICAL).
 *
 * `entrypoint/agent-mcp/src/index.ts` gated server startup on:
 *
 *   const isMainModule =
 *       process.argv[1] !== undefined &&
 *       path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
 *
 * `path.resolve(argv[1])` only NORMALIZES a path — it never resolves
 * symlinks — while Node always resolves `import.meta.url` to the loaded
 * module's REALPATH. So on any symlinked launch (npm/npx's
 * `node_modules/.bin/agent-mcp`, pnpm's symlinked store, an MCP host's
 * `type:local` launcher, or macOS's `/tmp` -> `/private/tmp`), argv[1] (the
 * symlink path) never equalled import.meta.url (the realpath) and
 * `isMainModule` was always `false` — `main()` never ran. The process loaded
 * env, then exited 0 silently: no server, no port bound, no DB touched.
 *
 * This test drives the REAL, BUILT production entry
 * (`entrypoint/agent-mcp/dist/src/index.js` — the exact file `npm`/`npx`
 * launch via the package's `bin` field) through an actual filesystem
 * symlink, as a real child process (`node <symlink>`), and asserts the real
 * HTTP transport port becomes reachable within a bounded deadline — the
 * only way to prove `main()` genuinely ran. Nothing here is mocked; the
 * `project.json` `test` target now `dependsOn: ["build"]` specifically so
 * `dist/` is always fresh for this test (CLAUDE.md §7 "live testing is
 * mandatory" — this is not a paid/external service, so it is NOT env-gated).
 *
 * Red -> green:
 *   - Pre-fix (`path.resolve(argv[1]) === fileURLToPath(import.meta.url)`):
 *     argv[1] is the symlink path, which `path.resolve` does not dereference,
 *     so it never equals the realpath-resolved `import.meta.url` of the
 *     dist file it points at. `isMainModule` is `false`, `main()` never
 *     runs, and the HTTP port never opens — this test times out and FAILS.
 *   - Post-fix (`realpathSync(argv[1]) === fileURLToPath(import.meta.url)`):
 *     the symlink resolves to the same realpath as the loaded module,
 *     `isMainModule` is `true`, `main()` runs, and the port becomes
 *     reachable well inside the deadline — this test PASSES.
 *   Verified manually during development by reverting the guard in
 *   `src/index.ts` to the pre-fix comparison and re-running this file alone
 *   (`npx vitest run src/__tests__/main-entry-symlink.test.ts`): it fails on
 *   a deadline timeout with the pre-fix guard, and passes with the fix.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// entrypoint/agent-mcp/src/__tests__/ -> entrypoint/agent-mcp/
const PACKAGE_ROOT = resolve(__dirname, "..", "..");
const DIST_ENTRY = join(PACKAGE_ROOT, "dist", "src", "index.js");

// entrypoint/agent-mcp/src/__tests__/ -> repo root (4 levels up), per
// CLAUDE.md §10: all ephemeral test artifacts live under the single
// canonical `tmp/` root, never a scattered ad-hoc dir.
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const TMP_ROOT = join(REPO_ROOT, "tmp", "agent-mcp", "main-entry-symlink");

/** Reserves a genuinely free loopback port by binding an OS-assigned
 *  ephemeral port and immediately releasing it (same technique as
 *  `sse-port-contention.test.ts`'s `reserveFreePort`). */
async function reserveFreePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
        const probe = http.createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const addr = probe.address();
            const port = addr && typeof addr === "object" ? addr.port : undefined;
            probe.close(() => {
                if (port === undefined) reject(new Error("could not reserve a free port"));
                else resolvePort(port);
            });
        });
    });
}

/** Polls `http://127.0.0.1:<port>` until a TCP connection is actually
 *  accepted (any HTTP response, even a 4xx, proves the port is bound and
 *  being served by the real `startServer()`/`StreamableHTTPServerTransport`
 *  — a bare unresolved connection or ECONNREFUSED means nothing is
 *  listening) or the deadline elapses. */
async function waitForPortReachable(port: number, deadlineMs: number): Promise<void> {
    const start = Date.now();
    let lastErr: unknown;
    while (Date.now() - start < deadlineMs) {
        try {
            await new Promise<void>((res, rej) => {
                const req = http.get(
                    { host: "127.0.0.1", port, path: "/", timeout: 500 },
                    (response) => {
                        response.resume();
                        res();
                    }
                );
                req.on("error", rej);
                req.on("timeout", () => {
                    req.destroy();
                    rej(new Error("request timeout"));
                });
            });
            return; // reachable
        } catch (err) {
            lastErr = err;
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    throw new Error(
        `port ${port} never became reachable within ${deadlineMs}ms (last error: ${String(lastErr)})`
    );
}

const cleanupDirs: string[] = [];
let child: ChildProcessWithoutNullStreams | undefined;

afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
    }
    child = undefined;
    cleanupDirs.splice(0).forEach((dir) => {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    });
});

describe("BUG-011: isMainModule guard must survive a symlinked launch", () => {
    it(
        "starts the real MCP server (binds the real HTTP transport port) when invoked through a symlink pointing at the built dist entry",
        { timeout: 30_000 },
        async () => {
            expect(
                existsSync(DIST_ENTRY),
                `expected built entry at ${DIST_ENTRY} — run "npx nx build agent-mcp" first ` +
                    `(the "test" target now dependsOn: ["build"], so a plain "npx nx test ` +
                    `agent-mcp" always produces this)`
            ).toBe(true);

            mkdirSync(TMP_ROOT, { recursive: true });
            const tmpDir = mkdtempSync(join(TMP_ROOT, "run-"));
            cleanupDirs.push(tmpDir);

            // A fake $HOME so this test never touches the real machine's
            // ~/.adhd/agent-mcp/* files (mirrors registry-prompt-resolver.test.ts's
            // fresh-machine isolation).
            const fakeHome = join(tmpDir, "home");
            mkdirSync(fakeHome, { recursive: true });

            // The actual bug fixture: a SYMLINK (not the real file) is what gets
            // launched — exactly like npm/npx's node_modules/.bin/agent-mcp or
            // pnpm's symlinked store entry.
            const symlinkPath = join(tmpDir, "agent-mcp-symlink.js");
            symlinkSync(DIST_ENTRY, symlinkPath);

            const port = await reserveFreePort();

            child = spawn(process.execPath, [symlinkPath], {
                env: {
                    ...process.env,
                    HOME: fakeHome,
                    ADHD_AGENT_TRANSPORT: "http",
                    ADHD_AGENT_PORT: String(port),
                    ADHD_AGENT_SSE_ENABLED: "false",
                },
                stdio: ["ignore", "pipe", "pipe"],
            });

            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString();
            });
            let exitedEarly: { code: number | null; signal: string | null } | undefined;
            child.on("exit", (code, signal) => {
                exitedEarly = { code, signal };
            });

            try {
                await waitForPortReachable(port, 20_000);
            } catch (err) {
                throw new Error(
                    `${String(err)}\n\n` +
                        `child ${exitedEarly ? `exited early (code=${exitedEarly.code}, signal=${exitedEarly.signal})` : "still running"}\n` +
                        `stderr:\n${stderr}`
                );
            }

            // The child must still be alive and NOT have exited 0 silently —
            // that silent-exit-0 IS the pre-fix bug behavior this guards against.
            expect(exitedEarly).toBeUndefined();
        }
    );
});
