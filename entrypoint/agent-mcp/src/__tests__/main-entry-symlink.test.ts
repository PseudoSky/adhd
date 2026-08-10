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
 *  - Post-fix (`realpathSync(argv[1]) === fileURLToPath(import.meta.url)`):
 *     the symlink resolves to the same realpath as the loaded module,
 *     `isMainModule` is `true`, `main()` runs, and the port becomes
 *     reachable well inside the deadline — this test PASSES.
 *   Verified manually during development by reverting the guard in
 *   `src/index.ts` to the pre-fix comparison and re-running this file alone
 *   (`npx vitest run src/__tests__/main-entry-symlink.test.ts`): it fails on
 *   a deadline timeout with the pre-fix guard, and passes with the fix.
 *
 * BUG-011 residual divergence (product re-verified 2026-08-08 on the
 * published @adhd/agent-mcp@2.2.3): the first fix trusted Node to have
 * already realpath-resolved `import.meta.url`, but some launch environments
 * (e.g. `--preserve-symlinks-main`, set by certain launchers) keep the
 * ENTRY module's `import.meta.url` at the invoked symlink path while
 * `realpathSync(argv[1])` fully resolves it — the guard went false again
 * and the server silently no-oped (exit 0, 0 bytes) exactly as before. The
 * guard is therefore hardened to realpath BOTH sides:
 * `realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url))`,
 * which holds no matter which side Node failed to resolve.
 *
 * The absolute-symlink launch above does not exercise that residual
 * divergence, and it also does not reproduce npm's real launch shape — the
 * published package's `bin` is `./src/index.js` (dist-root-rebased), npm
 * creates `node_modules/.bin/agent-mcp` as a RELATIVE symlink
 * (`../@adhd/agent-mcp/src/index.js`), and the real install copies (never
 * symlinks) the package content. So this file adds a second test that
 * builds a scratch package tree under `os.tmpdir()` (on macOS that is
 * `/private/var/...`, exercising the `/var` -> `/private/var` symlinked
 * ancestor), copies the built dist in as the package content, links the
 * runtime deps, creates the RELATIVE `.bin` symlink, and spawns
 * `node node_modules/.bin/agent-mcp --help` with `cwd` = the package root —
 * the product's case (2) verbatim. It asserts the process does NOT exit 0
 * silently: the real HTTP transport port becomes reachable, the child stays
 * alive, and some boot output is produced.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// entrypoint/agent-mcp/src/__tests__/ -> entrypoint/agent-mcp/
const PACKAGE_ROOT = resolve(__dirname, "..", "..");
const DIST_ENTRY = join(PACKAGE_ROOT, "dist", "src", "index.js");
const DIST_ROOT = join(PACKAGE_ROOT, "dist");

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

/**
 * Links every runtime dependency of the built package into a scratch package
 * tree's `node_modules`, mirroring what a real `npm install <tarball>` does
 * (offline: symlinks to the repo's own installed packages — `@adhd/*`
 * workspace packages under the project's isolated `node_modules`, everything
 * else from the repo root's hoisted `node_modules`). Resolution inside the
 * child process walks through each symlink to the real package, whose own
 * transitive deps resolve from its per-package pnpm `node_modules`.
 */
function linkScratchPackageDeps(
    pkgNodeModules: string,
    dependencies: Record<string, string> | undefined,
    packageRoot: string,
    repoRoot: string
): void {
    const projectNodeModules = join(packageRoot, "node_modules");
    const rootNodeModules = join(repoRoot, "node_modules");
    for (const dep of Object.keys(dependencies ?? {})) {
        const scoped = dep.startsWith("@");
        const [scope, name] = scoped ? [dep.split("/")[0], dep.split("/")[1]] : ["", dep];
        const fromDir = scoped ? join(projectNodeModules, scope) : projectNodeModules;
        const fromPath = join(fromDir, name);
        const fallbackPath = scoped ? join(rootNodeModules, scope, name) : join(rootNodeModules, name);
        let source: string | undefined;
        if (existsSync(fromPath)) {
            source = fromPath;
        } else if (existsSync(fallbackPath)) {
            source = fallbackPath;
        }
        if (source === undefined) {
            throw new Error(
                `BUG-011 test: cannot find runtime dependency "${dep}" to link into the scratch ` +
                    `package tree (looked in ${fromPath} and ${fallbackPath})`
            );
        }
        const destDir = scoped ? join(pkgNodeModules, scope) : pkgNodeModules;
        mkdirSync(destDir, { recursive: true });
        symlinkSync(source, join(destDir, name));
    }
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

    it(
        "starts the real MCP server when launched EXACTLY like npm/npx: `node node_modules/.bin/agent-mcp` from a scratch package tree under os.tmpdir(), with a RELATIVE .bin symlink and a copied (not symlinked) package content",
        { timeout: 60_000 },
        async () => {
            expect(
                existsSync(DIST_ENTRY),
                `expected built entry at ${DIST_ENTRY} — run "npx nx build agent-mcp" first ` +
                    `(the "test" target now dependsOn: ["build"], so a plain "npx nx test ` +
                    `agent-mcp" always produces this)`
            ).toBe(true);

            // os.tmpdir() — NOT the repo's tmp/ — so the scratch tree lives under
            // /private/var on macOS, exercising the /var -> /private/var symlinked
            // ancestor that separates the two realpaths in the residual BUG-011
            // divergence.
            const tmpRoot = mkdtempSync(join(tmpdir(), "adhd-agent-mcp-bug011-"));
            cleanupDirs.push(tmpRoot);

            const pkg = join(tmpRoot, "pkg");
            const pkgNodeModules = join(pkg, "node_modules");
            const pkgScope = join(pkgNodeModules, "@adhd");
            const pkgAgentMcp = join(pkgScope, "agent-mcp");

            // 1. Package content = a COPY of the built dist — exactly what `npm
            //    install` unpacks from the published tarball (a real file tree,
            //    never a symlink back into the repo). The dist root IS the package
            //    root once published (dist-manifest rebases bin -> ./src/index.js).
            cpSync(DIST_ROOT, pkgAgentMcp, { recursive: true });

            // 2. Runtime deps from the rebased manifest, linked offline from the
            //    repo's own installed packages (mirrors npm resolving the tarball's
            //    dependencies into the consumer's node_modules).
            const distManifest = JSON.parse(
                readFileSync(join(DIST_ROOT, "package.json"), "utf8")
            ) as { dependencies?: Record<string, string> };
            linkScratchPackageDeps(pkgNodeModules, distManifest.dependencies, PACKAGE_ROOT, REPO_ROOT);

            // 3. npm's .bin entry: a RELATIVE symlink, exactly as npm creates it —
            //    `node_modules/.bin/agent-mcp -> ../@adhd/agent-mcp/src/index.js`.
            const binDir = join(pkgNodeModules, ".bin");
            mkdirSync(binDir, { recursive: true });
            symlinkSync("../@adhd/agent-mcp/src/index.js", join(binDir, "agent-mcp"));

            // A fake $HOME so this test never touches the real machine's
            // ~/.adhd/agent-mcp/* files (same isolation as the absolute-symlink
            // test above).
            const fakeHome = join(tmpRoot, "home");
            mkdirSync(fakeHome, { recursive: true });

            const port = await reserveFreePort();

            // 4. The product's launch shape verbatim: RELATIVE .bin path, cwd =
            //    the package root, --help as the arg (which the server ignores).
            child = spawn(process.execPath, ["node_modules/.bin/agent-mcp", "--help"], {
                cwd: pkg,
                env: {
                    ...process.env,
                    HOME: fakeHome,
                    ADHD_AGENT_TRANSPORT: "http",
                    ADHD_AGENT_PORT: String(port),
                    ADHD_AGENT_SSE_ENABLED: "false",
                },
                stdio: ["ignore", "pipe", "pipe"],
            });

            let stdout = "";
            child.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
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
                await waitForPortReachable(port, 25_000);
            } catch (err) {
                throw new Error(
                    `${String(err)}\n\n` +
                        `child ${exitedEarly ? `exited early (code=${exitedEarly.code}, signal=${exitedEarly.signal})` : "still running"}\n` +
                        `stdout:\n${stdout}\nstderr:\n${stderr}`
                );
            }

            // The hardened guard's contract: the process runs main() and stays
            // alive — never the silent exit-0 (0 bytes) no-op.
            expect(exitedEarly).toBeUndefined();
            expect(stdout.length + stderr.length).toBeGreaterThan(0);
        }
    );
});
