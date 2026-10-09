/**
 * c536ce29 (wire tracing, W1) — `tracedSpawn` against REAL child processes (`node -e`). Spawns
 * subprocesses, so it lives in the e2e lane.
 *
 *   c536ce29 TRC-AC5w  start/stdin/stdout/exit are logged with the right code and signal and a
 *                      byte-exact stdout; the child's own behaviour (exit code, stdout) is unchanged
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { noopLogChannel } from "../wire/channels.js";
import { tracedSpawn } from "../wire/index.js";
import { makeTestChannel, waitFor, type ITestChannel } from "./wire-test-utils.js";

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const CANARY = ["sk-ant-", "api03-CANARY0123456789abcdef"].join(""); // assembled at runtime so the repo secret scan sees no key-shaped literal
const created: ITestChannel[] = [];
afterEach(async () => {
    for (const c of created.splice(0)) await c.dispose();
});

const SCRIPT = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  process.stdout.write('echo:' + input.toUpperCase() + '\\n');
  process.stdout.write('second line é\\n');
  process.stderr.write('warn\\n');
  process.exit(3);
});`;

interface IRun {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: Buffer;
    stderr: string;
}

async function run(spawnFn: typeof spawn, stdin: string, env?: NodeJS.ProcessEnv): Promise<IRun> {
    const child = spawnFn(process.execPath, ["-e", SCRIPT, "--", "--token", CANARY], { env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdin!.write(stdin);
    child.stdin!.end();
    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr }));
    });
}

describe("c536ce29 TRC-AC5w tracedSpawn", () => {
    it("c536ce29 TRC-AC5w: logs start/stdin/stdout/exit with exact code, signal and stdout; child behaviour is unchanged", async () => {
        const tc = makeTestChannel();
        created.push(tc);
        const plain = await run(spawn, "hello");
        const traced = await run(tracedSpawn(tc.channel, spawn), "hello", { ...process.env, MY_PRIVATE_VALUE: "do-not-log-this-value" });

        // behaviour parity
        expect(traced.code).toBe(3);
        expect(traced.code).toBe(plain.code);
        expect(traced.signal).toBeNull();
        expect(traced.stdout.equals(plain.stdout)).toBe(true);
        expect(traced.stderr).toBe(plain.stderr);
        expect(traced.stdout.toString()).toBe("echo:HELLO\nsecond line é\n");

        const closeRec = await waitFor(async () => (await tc.records()).find((r) => r.event === "spawn.close"), "spawn.close");
        const recs = await tc.records();
        const by = (e: string): typeof recs => recs.filter((r) => r.event === e);
        const start = by("spawn.start")[0]!;
        expect(start.command).toBe(process.execPath);
        expect((start.args as string[])[0]).toBe("-e");
        expect(start.env_names).toContain("MY_PRIVATE_VALUE");
        expect(JSON.stringify(start)).not.toContain("do-not-log-this-value");
        expect(typeof start.pid).toBe("number");

        const stdinRec = by("spawn.stdin");
        expect(stdinRec.map((r) => r.body).join("")).toBe("hello");
        const stdoutBytes = Buffer.concat(by("spawn.stdout").map((r) => Buffer.from(r.body as string, "utf8")));
        expect(stdoutBytes.equals(traced.stdout)).toBe(true);
        expect(by("spawn.stderr").map((r) => r.body).join("")).toBe("warn\n");

        const exit = by("spawn.exit")[0]!;
        expect(exit.code).toBe(3);
        expect(exit.signal).toBeNull();
        expect(typeof exit.duration_ms).toBe("number");
        expect(closeRec.stdout_bytes).toBe(traced.stdout.length);
        expect(closeRec.stdout_sha256).toBe(sha(traced.stdout));
        for (const r of recs.filter((x) => x.event.startsWith("spawn."))) expect(r.call_id).toBe(start.call_id);

        // secret in argv never reaches the file
        expect(await tc.rawText()).not.toContain("CANARY0123456789abcdef");
    });

    it("c536ce29 TRC-AC5w: a signal-terminated child logs the signal and kill() still works", async () => {
        const tc = makeTestChannel();
        created.push(tc);
        const child = tracedSpawn(tc.channel, spawn)(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
        await waitFor(async () => ((await tc.records()).some((r) => r.event === "spawn.start") ? true : undefined), "spawn.start");
        const exited = new Promise<NodeJS.Signals | null>((r) => child.on("exit", (_c, s) => r(s)));
        child.kill("SIGTERM");
        expect(await exited).toBe("SIGTERM");
        const exit = await waitFor(async () => (await tc.records()).find((r) => r.event === "spawn.exit"), "spawn.exit");
        expect(exit.signal).toBe("SIGTERM");
        expect(exit.code).toBeNull();
    });

    it("c536ce29 TRC-AC5w: spawn failure logs spawn.error and the child still emits its 'error' event", async () => {
        const tc = makeTestChannel();
        created.push(tc);
        const child = tracedSpawn(tc.channel, spawn)("definitely-not-a-real-binary-c536ce29", []);
        const err = await new Promise<NodeJS.ErrnoException>((r) => child.on("error", r));
        expect(err.code).toBe("ENOENT");
        const rec = await waitFor(async () => (await tc.records()).find((r) => r.event === "spawn.error"), "spawn.error");
        expect(rec.error_code).toBe("ENOENT");
    });

    it("c536ce29 TRC-AC5w: an inert channel passes straight through to the base spawn and logs nothing", async () => {
        const tc = makeTestChannel();
        created.push(tc);
        const traced = await run(tracedSpawn(noopLogChannel(), spawn), "x");
        expect(traced.code).toBe(3);
        expect(traced.stdout.toString()).toBe("echo:X\nsecond line é\n");
        expect((await tc.records()).length).toBe(0);
    });
});
