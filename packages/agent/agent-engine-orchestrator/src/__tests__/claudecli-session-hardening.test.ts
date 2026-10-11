/**
 * 95ee2a24 -- claudecli session retention hardening (blind-review M1 / M2 / M3).
 *
 *  AC2  removeTranscripts / commit only ever touch ids that are UUIDs (traversal ids touch nothing)
 *  AC3  the resume key changes with the bridged tool set, settingSources, permission mode (and the other inputs)
 *  AC4  orphan transcripts recorded by this feature are swept on provider start; sessions that cannot be resumed
 *       are not retained; SIGTERM/SIGINT clean up; the crash leak window is bounded by the ledger sweep
 *
 * Unit lane: only `child_process.spawn` is mocked (no model call, no subprocess); signals and pids go through the
 * registry's injectable process seam, so no real signal is sent and no real process is probed.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import {
    CLI_SESSION_ID_RE,
    ClaudeCliSessionRegistry,
    claudeCliResumeConfigKey,
    isCliSessionId,
    removeTranscripts,
    type IRegistryProcess,
    type IResumeKeyInputs,
} from "../providers/claudecli-session.js";
import type { ProviderChatRequest } from "../providers/types.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const root = mkdtempSync(join(tmpdir(), "95ee2a24-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/** A fresh config dir per test so ledgers and transcripts never leak between cases. */
function freshConfigDir(): string {
    const d = join(root, `cfg-${n++}`);
    mkdirSync(join(d, "projects", "-proj"), { recursive: true });
    return d;
}

const U1 = "a1a1a1a1-1111-4111-8111-111111111111";
const U2 = "a2a2a2a2-2222-4222-8222-222222222222";
const U3 = "a3a3a3a3-3333-4333-8333-333333333333";
const user = (content: string) => ({ role: "user", content }) as ProviderChatRequest["messages"][number];
const assistant = (content: string) => ({ role: "assistant", content }) as ProviderChatRequest["messages"][number];
const system = (content: string) => ({ role: "system", content }) as ProviderChatRequest["messages"][number];

function transcript(configDir: string, id: string): string {
    const file = join(configDir, "projects", "-proj", `${id}.jsonl`);
    writeFileSync(file, "{}\n");
    return file;
}

/** A process stand-in: records listeners, never delivers a real signal. */
class FakeProc implements IRegistryProcess {
    constructor(readonly pid = 4242) {}
    readonly listeners = new Map<string, Array<() => void>>();
    once(event: string, listener: () => void): this {
        const l = this.listeners.get(event) ?? [];
        l.push(listener);
        this.listeners.set(event, l);
        return this;
    }
    removeListener(event: string, listener: () => void): this {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((x) => x !== listener));
        return this;
    }
    listenerCount(event: string): number { return (this.listeners.get(event) ?? []).length; }
    fire(event: string): void { for (const l of [...(this.listeners.get(event) ?? [])]) l(); }
}

describe("95ee2a24 AC2: only UUID session ids are ever retained, resumed or deleted", () => {
    const traversal = ["../../victim", "..", "../victim", "/etc/passwd", "a/b", "x\0y", "child-1", "", `${U1}/../../victim`, `${U1}\n`];

    it("95ee2a24 AC2: the UUID matcher accepts v4-shaped ids and rejects everything else", () => {
        expect(isCliSessionId(U1)).toBe(true);
        expect(CLI_SESSION_ID_RE.test(U1.toUpperCase())).toBe(true);
        for (const bad of traversal) expect(isCliSessionId(bad), JSON.stringify(bad)).toBe(false);
        expect(isCliSessionId(undefined)).toBe(false);
        expect(isCliSessionId(42)).toBe(false);
    });

    it("95ee2a24 AC2: removeTranscripts deletes the UUID transcript and nothing outside the projects dir for traversal ids", () => {
        const cfg = freshConfigDir();
        const outside = join(cfg, "victim.jsonl"); // projects/-proj/../../victim.jsonl
        const inProjects = join(cfg, "projects", "victim.jsonl"); // projects/-proj/../victim.jsonl
        const sibling = join(cfg, "projects", "-proj", "child-1.jsonl"); // a non-UUID name inside the dir
        for (const f of [outside, inProjects, sibling]) writeFileSync(f, "keep");
        const mine = transcript(cfg, U1);
        removeTranscripts(cfg, [...traversal, "victim", "child-1", U1]);
        expect(existsSync(mine)).toBe(false);
        for (const f of [outside, inProjects, sibling]) expect(existsSync(f), f).toBe(true);
    });

    it("95ee2a24 AC2: commit refuses a non-UUID id, so it never enters the delete set or becomes a resume parent", () => {
        const cfg = freshConfigDir();
        const victim = join(cfg, "victim.jsonl");
        writeFileSync(victim, "keep");
        const s = new ClaudeCliSessionRegistry(Date.now, undefined, { proc: new FakeProc() });
        expect(s.commit("S", { configKey: "k", configDir: cfg, cliSessionId: "../../victim", nonSystem: [user("x")], reply: "y" })).toBe(false);
        expect(s.size).toBe(0);
        s.releaseAll();
        expect(existsSync(victim)).toBe(true);
        expect(s.commit("S", { configKey: "k", configDir: cfg, cliSessionId: U1, nonSystem: [user("x")], reply: "y" })).toBe(true);
        const plan = s.plan("S", "k", cfg, [user("x"), assistant("y"), user("z")]);
        expect(plan).toMatchObject({ mode: "resume", parentId: U1 });
        s.releaseAll();
    });
});

describe("95ee2a24 AC3: the resume key covers every input that shapes the transcript's request prefix", () => {
    const base: IResumeKeyInputs = {
        systemPrompt: "be terse",
        model: "claude-haiku-4-5",
        cwd: "/w",
        builtinTools: ["Bash"],
        builtinToolsArgv: ["--tools", "Bash"],
        bridgedTools: [{ name: "s__a", description: "does a", inputSchema: { type: "object" } }, { name: "s__b", description: "does b" }],
        settingSources: "project",
        permissionMode: "dangerously-skip-permissions",
    };
    const key = (o: Partial<IResumeKeyInputs> = {}): string => claudeCliResumeConfigKey({ ...base, ...o });

    it("95ee2a24 AC3: identical inputs give the same key regardless of bridged tool order", () => {
        expect(key()).toBe(key());
        expect(key({ bridgedTools: [...base.bridgedTools].reverse() })).toBe(key());
    });

    const changes: Array<[string, Partial<IResumeKeyInputs>]> = [
        ["a bridged tool is added", { bridgedTools: [...base.bridgedTools, { name: "s__c", description: "c" }] }],
        ["a bridged tool is removed", { bridgedTools: base.bridgedTools.slice(0, 1) }],
        ["a bridged tool is renamed", { bridgedTools: [{ ...base.bridgedTools[0]!, name: "s__z" }, base.bridgedTools[1]!] }],
        ["a bridged tool description changes", { bridgedTools: [{ ...base.bridgedTools[0]!, description: "does a differently" }, base.bridgedTools[1]!] }],
        ["a bridged tool schema changes", { bridgedTools: [{ ...base.bridgedTools[0]!, inputSchema: { type: "object", required: ["q"] } }, base.bridgedTools[1]!] }],
        ["settingSources changes", { settingSources: "user,project" }],
        ["settingSources goes to the CLI default", { settingSources: undefined }],
        ["the permission mode changes", { permissionMode: "acceptEdits" }],
        ["the system prompt changes", { systemPrompt: "be verbose" }],
        ["the model changes", { model: "claude-sonnet-4-6" }],
        ["the cwd changes", { cwd: "/other" }],
        ["the declared built-in tools change", { builtinTools: ["Bash", "Read"] }],
        ["the gate-filtered --tools argv changes", { builtinToolsArgv: ["--tools", ""] }],
    ];
    for (const [label, change] of changes) {
        it(`95ee2a24 AC3: the key changes when ${label}`, () => {
            expect(key(change)).not.toBe(key());
        });
    }
});

// ── provider-level: the key actually gates --resume ────────────────────────────────────────────────────────────────

const startToolBridge = vi.fn();
vi.mock("../providers/claudecli-tool-bridge.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../providers/claudecli-tool-bridge.js")>()),
    startToolBridge: (...a: unknown[]) => startToolBridge(...a),
}));

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
let engineConfigDir = "";
let engineTempDir = "";
const engine = (): EngineConfig => ({
    wire: { tempDir: engineTempDir },
    cwd: root,
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: "" },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({ CLAUDE_CONFIG_DIR: engineConfigDir }),
    resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
}) as unknown as EngineConfig;

const ok = (text: string, sessionId?: string): string =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1, ...(sessionId ? { session_id: sessionId } : {}) });
interface ISpawned { args: string[] }
const spawned: ISpawned[] = [];
let scripts: string[][] = [];

async function arm(): Promise<void> {
    const { spawn } = await import("child_process");
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReset();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation((_bin: string, args: string[]) => {
        const lines = scripts.shift() ?? [ok("OK")];
        const stdout = new Readable({ read() {} });
        spawned.push({ args });
        queueMicrotask(() => { for (const l of lines) stdout.push(l + "\n"); stdout.push(null); });
        return {
            stdout, stderr: new Readable({ read() {} }), pid: undefined, on: () => {}, kill: () => {}, exitCode: 0, killed: false,
            stdin: { write: () => true, end: () => {} },
        };
    });
}
beforeEach(async () => {
    spawned.length = 0; scripts = []; startToolBridge.mockReset();
    startToolBridge.mockResolvedValue({ baseUrl: "http://127.0.0.1:1", token: "t", serverNames: ["s"], calls: () => 0, close: async () => {} });
    engineConfigDir = freshConfigDir();
    engineTempDir = join(root, `tmp-${n++}`);
    await arm();
});

const flag = (args: string[], f: string): string | undefined => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const toolDef = (name: string, description: string) => ({ name: `s__${name}`, description, inputSchema: { type: "object" } });

async function chat(
    sessions: ClaudeCliSessionRegistry,
    messages: ProviderChatRequest["messages"],
    opts: { providerConfig?: Record<string, unknown>; tools?: ReturnType<typeof toolDef>[]; deps?: Record<string, unknown> } = {},
): Promise<void> {
    const { ClaudeCliProvider } = await import("../providers/claudecli.js");
    const provider = new ClaudeCliProvider(
        { type: "claudecli", model: "claude-haiku-4-5", ...opts.providerConfig } as never, {}, undefined, engine(), logger, undefined,
        { sessionKey: "S", sessions, ...opts.deps },
    );
    await provider.chat({
        messages,
        ...(opts.tools ? { tools: opts.tools as never, executeTool: async () => ({ result: "", isError: false }) } : {}),
    });
}

describe("95ee2a24 AC3: a changed tool surface or setting never resumes the old transcript", () => {
    const first = [system("sys"), user("one")];
    const second = [system("sys"), user("one"), assistant("a1"), user("two")];

    async function secondRun(change: { tools?: ReturnType<typeof toolDef>[]; providerConfig?: Record<string, unknown> }, base: { tools?: ReturnType<typeof toolDef>[] } = {}): Promise<string[]> {
        const sessions = new ClaudeCliSessionRegistry(Date.now, undefined, { proc: new FakeProc() });
        scripts = [[ok("a1", U1)], [ok("a2", U2)]];
        await chat(sessions, first, { tools: base.tools ?? [toolDef("t", "d")] });
        await chat(sessions, second, { tools: change.tools ?? base.tools ?? [toolDef("t", "d")], providerConfig: change.providerConfig });
        sessions.releaseAll();
        return spawned[1]!.args;
    }

    it("95ee2a24 AC3: control -- an unchanged surface resumes", async () => {
        expect(flag(await secondRun({}), "--resume")).toBe(U1);
    });
    it("95ee2a24 AC3: a different bridged tool set replays instead of resuming", async () => {
        expect(await secondRun({ tools: [toolDef("t", "d"), toolDef("u", "new")] })).not.toContain("--resume");
    });
    it("95ee2a24 AC3: a changed bridged tool description replays instead of resuming", async () => {
        expect(await secondRun({ tools: [toolDef("t", "d, reworded")] })).not.toContain("--resume");
    });
    it("95ee2a24 AC3: changed settingSources replays instead of resuming", async () => {
        expect(await secondRun({ providerConfig: { settingSources: "user,project" } })).not.toContain("--resume");
    });
});

describe("95ee2a24 AC4: sessions that cannot be resumed are not retained", () => {
    it("95ee2a24 AC4: sessionResumable:false keeps --no-session-persistence and retains nothing", async () => {
        const sessions = new ClaudeCliSessionRegistry(Date.now, undefined, { proc: new FakeProc() });
        await chat(sessions, [user("one-shot")], { deps: { sessionResumable: false } });
        expect(spawned[0]!.args).toContain("--no-session-persistence");
        expect(spawned[0]!.args).not.toContain("--session-id");
        expect(sessions.size).toBe(0);
        expect(existsSync(join(engineTempDir, "claudecli-ledgers"))).toBe(false);
    });

    it("95ee2a24 AC4: createProvider threads sessionResumable:false through to the provider", async () => {
        const { createProvider } = await import("../providers/factory.js");
        const { claudeCliSessions } = await import("../providers/claudecli-session.js");
        const selection = { providerType: "claudecli", modelRef: "claude-haiku-4-5" } as never;
        const oneShot = createProvider(selection, {}, engine(), logger, { executionContext: { sessionId: "one-shot" } as never, sessionResumable: false });
        await oneShot.chat({ messages: [user("hi")] });
        expect(spawned[0]!.args).toContain("--no-session-persistence");
        const kept = createProvider(selection, {}, engine(), logger, { executionContext: { sessionId: "kept" } as never });
        await kept.chat({ messages: [user("hi")] });
        expect(spawned[1]!.args).toContain("--session-id");
        claudeCliSessions.releaseAll();
    });

    it("95ee2a24 AC4: at the cap, never-resumed (one-shot-shaped) sessions are evicted before a proven-resumable one", () => {
        const cfg = freshConfigDir();
        let t = 0;
        const s = new ClaudeCliSessionRegistry(() => t, { idleTtlMs: 1e9, maxRetained: 2 }, { proc: new FakeProc() });
        const commit = (key: string, id: string, nonSystem = [user("x")]): void => {
            s.commit(key, { configKey: "k", configDir: cfg, cliSessionId: id, nonSystem, reply: "y" });
        };
        const resumable = transcript(cfg, U1);
        commit("resumable", U1);
        t = 1;
        expect(s.plan("resumable", "k", cfg, [user("x"), assistant("y"), user("z")]).mode).toBe("resume"); // proven resumable
        t = 2; // `resumable` is now the OLDEST by recency among three, yet it must survive
        const oneShotA = transcript(cfg, U2);
        commit("oneShotA", U2);
        t = 3;
        const oneShotB = transcript(cfg, U3);
        commit("oneShotB", U3);
        expect(s.size).toBe(2);
        expect(existsSync(oneShotA)).toBe(false); // evicted first
        expect(existsSync(oneShotB)).toBe(true);
        expect(existsSync(resumable)).toBe(true);
        s.releaseAll();
    });
});

describe("95ee2a24 AC4: orphan transcripts are swept on provider start", () => {
    const ledgerDir = (tempRoot: string): string => join(tempRoot, "claudecli-ledgers");
    const dead = 999_001;
    const live = 999_002;
    const ledger = (tempRoot: string, cfg: string, pid: number, uuidTail: string, ids: unknown[]): string => {
        mkdirSync(ledgerDir(tempRoot), { recursive: true });
        const f = join(ledgerDir(tempRoot), `${pid}-${uuidTail}.json`);
        writeFileSync(f, JSON.stringify({ pid, entries: [{ configDir: cfg, ids }] }));
        return f;
    };
    const isAlive = (pid: number): boolean => pid === live;
    const T1 = "00000000-0000-4000-8000-000000000001";
    const T2 = "00000000-0000-4000-8000-000000000002";

    it("95ee2a24 AC4: the first chat deletes a dead process's recorded transcripts and ledger, and only those", async () => {
        const cfg = engineConfigDir;
        const orphan = transcript(cfg, U1);
        const liveOwned = transcript(cfg, U2);
        const unrelated = transcript(cfg, U3); // a user's own transcript: never recorded by this feature
        const victim = join(cfg, "victim.jsonl");
        writeFileSync(victim, "keep");
        const tmp = engineTempDir;
        const deadLedger = ledger(tmp, cfg, dead, T1, [U1, "../../victim"]);
        const liveLedger = ledger(tmp, cfg, live, T2, [U2]);
        const stray = join(ledgerDir(tmp), "notes.txt");
        writeFileSync(stray, "not a ledger");

        const sessions = new ClaudeCliSessionRegistry(Date.now, undefined, { proc: new FakeProc(), isAlive });
        await chat(sessions, [user("hi")]);

        expect(existsSync(orphan)).toBe(false);
        expect(existsSync(deadLedger)).toBe(false);
        expect(existsSync(liveOwned)).toBe(true);
        expect(existsSync(liveLedger)).toBe(true);
        expect(existsSync(unrelated)).toBe(true);
        expect(existsSync(victim)).toBe(true);
        expect(existsSync(stray)).toBe(true);
        sessions.releaseAll();
    });

    it("95ee2a24 AC4: the sweep runs once per ledger root, and sweepOrphans reports how many ledgers it cleared", () => {
        const cfg = freshConfigDir();
        const tmp = join(root, `tmp-${n++}`);
        transcript(cfg, U1);
        ledger(tmp, cfg, dead, T1, [U1]);
        const s = new ClaudeCliSessionRegistry(Date.now, undefined, { proc: new FakeProc(), isAlive });
        expect(s.sweepOrphans(tmp)).toBe(1);
        ledger(tmp, cfg, dead, T2, [U2]); // appears after the first sweep: not re-scanned within this process
        expect(s.sweepOrphans(tmp)).toBe(0);
        expect(s.sweepOrphans(undefined)).toBe(0);
    });

    it("95ee2a24 AC4: a live registry records its ids in a ledger and a clean release removes it", async () => {
        const cfg = engineTempDir;
        const sessions = new ClaudeCliSessionRegistry(Date.now, undefined, { proc: new FakeProc(), isAlive });
        scripts = [[ok("a", U1)]];
        await chat(sessions, [user("hi")]);
        const files = readdirSync(ledgerDir(cfg));
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^4242-[0-9a-f-]{36}\.json$/);
        sessions.releaseAll();
        expect(existsSync(ledgerDir(cfg)) ? readdirSync(ledgerDir(cfg)) : []).toEqual([]);
    });

    it("95ee2a24 AC4: an unclean exit (ledger left behind) is healed by the next registry's sweep -- the crash window is one process lifetime", async () => {
        const cfg = engineConfigDir;
        const crashed = new ClaudeCliSessionRegistry(Date.now, undefined, { proc: new FakeProc(), isAlive });
        scripts = [[ok("a", U1)]];
        await chat(crashed, [user("hi")]);
        const pinned = flag(spawned[0]!.args, "--session-id")!;
        const files = [transcript(cfg, pinned), transcript(cfg, U1)];
        // `crashed` never runs releaseAll (SIGKILL). A new process (different pid, registry) starts later:
        const next = new ClaudeCliSessionRegistry(Date.now, undefined, { proc: new FakeProc(777), isAlive: (pid) => pid === 777 });
        scripts = [[ok("b", U2)]];
        await chat(next, [user("hi")], { deps: { sessionKey: "T" } });
        for (const f of files) expect(existsSync(f), f).toBe(false);
        next.releaseAll();
    });
});

describe("95ee2a24 AC4: SIGTERM / SIGINT clean up, then restore Node's default termination", () => {
    function armed(extra?: () => void): { s: ClaudeCliSessionRegistry; proc: FakeProc; reraise: ReturnType<typeof vi.fn>; file: string } {
        const cfg = freshConfigDir();
        const proc = new FakeProc();
        const reraise = vi.fn();
        const s = new ClaudeCliSessionRegistry(Date.now, undefined, { proc, reraise });
        const plan = s.plan("S", "k", cfg, [user("x")]);
        const file = transcript(cfg, plan.mode === "fresh" ? plan.newId : U1);
        extra?.();
        return { s, proc, reraise, file };
    }

    for (const sig of ["SIGTERM", "SIGINT"] as const) {
        it(`95ee2a24 AC4: ${sig} removes retained transcripts and re-raises the signal when nothing else handles it`, () => {
            const { s, proc, reraise, file } = armed();
            expect(proc.listenerCount(sig)).toBe(1);
            proc.fire(sig);
            expect(existsSync(file)).toBe(false);
            expect(s.size).toBe(0);
            expect(reraise).toHaveBeenCalledExactlyOnceWith(sig);
        });

        it(`95ee2a24 AC4: ${sig} cleans up but does not re-raise when the host has its own handler`, () => {
            const { proc, reraise, file } = armed();
            proc.once(sig, () => {}); // the host's own graceful-shutdown handler
            proc.fire(sig);
            expect(existsSync(file)).toBe(false);
            expect(reraise).not.toHaveBeenCalled();
        });
    }

    it("95ee2a24 AC4: the exit hook still releases everything", () => {
        const { proc, file } = armed();
        proc.fire("exit");
        expect(existsSync(file)).toBe(false);
    });
});
