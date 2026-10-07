/**
 * a0806529 AC1 / AC2 / AC3 — agent-mcp's stdio stdout is JSON-RPC only.
 *
 * Root cause: `utils/load-env.ts` called dotenv `config()` without
 * `quiet: true`; dotenv >=17 prints `◇ injected env (N) from <file> // tip: …`
 * with `console.log` (STDOUT), ahead of the first JSON-RPC frame, corrupting
 * the MCP stdio stream.
 *
 * a0806529 AC2: spawns the BUILT server (`dist/src/index.js`, produced by
 * `nx build agent-mcp`, wired via the project's e2e `dependsOn`) over real
 * stdio in an isolated cwd + fake HOME, with real `.env` files present at all
 * three hierarchy levels so the banner path is exercised, sends a real
 * `initialize` request, and asserts EVERY stdout line parses as JSON and the
 * first line is a JSON-RPC frame. Not env-gated (ADR-0009: e2e lane).
 * Negative control: removing `quiet: true` from load-env.ts turns this RED.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnvHierarchy } from "../utils/load-env.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..", "..");
const DIST_ENTRY = join(PACKAGE_ROOT, "dist", "src", "index.js");
const TMP_ROOT = join(resolve(PACKAGE_ROOT, "..", ".."), "tmp", "agent-mcp", "stdio-stdout-clean");

const scratch: string[] = [];
afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeScratch(): { home: string; cwd: string } {
    mkdirSync(TMP_ROOT, { recursive: true });
    const root = mkdtempSync(join(TMP_ROOT, "run-"));
    scratch.push(root);
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    mkdirSync(join(home, ".adhd"), { recursive: true });
    mkdirSync(join(cwd, ".adhd"), { recursive: true });
    writeFileSync(join(home, ".adhd", ".env"), "A0806529_HOME=home\nA0806529_SHARED=home\n");
    writeFileSync(join(cwd, ".adhd", ".env"), "A0806529_PROJ=proj\nA0806529_SHARED=proj\n");
    writeFileSync(join(cwd, ".env"), "A0806529_CWD=cwd\nA0806529_SHARED=cwd\n");
    return { home, cwd };
}

describe("a0806529 stdio stdout carries only JSON-RPC", () => {
    it("a0806529 AC1+AC2: built server over stdio, real .env files present — every stdout line is JSON, first is a JSON-RPC frame", async () => {
        expect(existsSync(DIST_ENTRY), `built entry missing: ${DIST_ENTRY} (run nx build agent-mcp)`).toBe(true);
        const { home, cwd } = makeScratch();

        const env: NodeJS.ProcessEnv = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (k.startsWith("ADHD_AGENT_") || k.startsWith("DOTENV_")) continue;
            if (v !== undefined) env[k] = v;
        }
        env.HOME = home;
        env.ADHD_AGENT_SSE_ENABLED = "false";

        const child = spawn(process.execPath, [DIST_ENTRY], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (err += d.toString()));

        const exited = new Promise<void>((r) => child.once("exit", () => r()));
        child.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    clientInfo: { name: "a0806529-e2e", version: "0.0.0" },
                },
            }) + "\n"
        );

        // Bounded wait for the initialize response frame (deadline, not a fixed sleep).
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && !out.includes('"id":1')) {
            await new Promise((r) => setTimeout(r, 50));
        }
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
        child.kill("SIGKILL");

        const lines = out.split("\n").filter((l) => l.length > 0);
        expect(lines.length, `no stdout at all; stderr=${err.slice(0, 2000)}`).toBeGreaterThan(0);
        const bad = lines.filter((l) => {
            try {
                JSON.parse(l);
                return false;
            } catch {
                return true;
            }
        });
        expect(bad, `non-JSON stdout lines: ${JSON.stringify(bad)}`).toEqual([]);
        const first = JSON.parse(lines[0]!) as { jsonrpc?: string };
        expect(first.jsonrpc).toBe("2.0");
        const initLine = lines.find((l) => l.includes('"id":1'));
        expect(initLine, `no initialize response; stderr=${err.slice(0, 2000)}`).toBeDefined();
        expect(JSON.parse(initLine!).result?.serverInfo).toBeDefined();
    }, 90_000);

    it("a0806529 AC3: env still loads from the hierarchy with unchanged precedence, and loading writes nothing to stdout", () => {
        const { home, cwd } = makeScratch();
        const keys = ["A0806529_HOME", "A0806529_PROJ", "A0806529_CWD", "A0806529_SHARED"];
        const savedHome = process.env.HOME;
        const savedWrite = process.stdout.write.bind(process.stdout);
        let wrote = "";
        try {
            for (const k of keys) delete process.env[k];
            process.env.HOME = home; // os.homedir() honors $HOME on POSIX
            process.stdout.write = ((chunk: string | Uint8Array) => {
                wrote += String(chunk);
                return true;
            }) as typeof process.stdout.write;
            loadEnvHierarchy(cwd);
        } finally {
            process.stdout.write = savedWrite;
            if (savedHome === undefined) delete process.env.HOME;
            else process.env.HOME = savedHome;
        }
        try {
            expect(process.env.A0806529_HOME).toBe("home");
            expect(process.env.A0806529_PROJ).toBe("proj");
            expect(process.env.A0806529_CWD).toBe("cwd");
            expect(process.env.A0806529_SHARED).toBe("cwd"); // most-specific wins
            expect(wrote).toBe("");
        } finally {
            for (const k of keys) delete process.env[k];
        }
    });
});
