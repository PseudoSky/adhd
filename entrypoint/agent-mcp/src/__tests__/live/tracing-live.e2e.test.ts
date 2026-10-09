/**
 * tracing-live.e2e.test.ts — c536ce29 LIVE-AC1..AC5, AC7: the tracing/logging pipeline proven end to
 * end against REAL providers, the REAL dev server, and the PRODUCTION store.
 *
 * GATED: runs only with AGENT_MCP_LIVE=1. This is the one permitted gate reason (AGENTS.md §7,
 * "Live testing is mandatory"): both providers are paid third-party services (the `claude` CLI and
 * the Anthropic API). Each run spends a few thousand tokens (two single-turn "Reply with exactly:
 * ok" tasks on claude-haiku-4-5, well under one US cent in total).
 *
 * Approved gate — owner: the repo owner (pseudosky), by direct instruction on 2026-10-09 ("use both
 * the claude cli provider and claude oauth to produce logs through the real dev server ... operate
 * on the production store, no custom locations"). Recorded in this file's header, in this package's
 * README.md ("Live tests") and in AGENTS.md ("Live tests"), as AGENTS.md §7 requires.
 *
 * What it does (no mocks, no server internals imported — only an MCP client over HTTP):
 *  1. Refuses to run if any env override would move the DB / log tree away from the production
 *     store, then resolves the store paths with the same resolvers the server and the tail CLI use
 *     and asserts they live under ~/.adhd/agent-mcp/production.
 *  2. Starts the real dev server (`scripts/serve.mjs run`, built dist) on a free port, with the
 *     inherited environment untouched.
 *  3. Over streamable-HTTP JSON-RPC, creates one `claudecli` agent and one Anthropic-OAuth agent
 *     (secret env pointer ADHD_AGENT_ANTHROPIC_SECRET), runs one task each, deletes the agents.
 *  4. Reads the production DB (read-only) and the production api/ops/trace logs and asserts the
 *     LIVE-AC criteria. Needs the built dist (`npx nx run agent-mcp:build` +
 *     `npx nx run agent-mcp:dist-manifest`), the `claude` binary, and a configured
 *     ADHD_AGENT_ANTHROPIC_SECRET; any missing prerequisite FAILS the run (it never skips).
 *
 * Note on LIVE-AC3 [claudecli]: the corrected arithmetic prices a cold-cache 1-hour cache write at
 * `input_cache_write_1h`; the product prices it at the 5-minute rate (backlog b726a987), so this
 * assertion goes red on any run where the CLI writes the prompt cache. A warm-cache run (cache read,
 * no write) does not reach that path and passes.
 *
 * Run: AGENT_MCP_LIVE=1 npx vitest run --config entrypoint/agent-mcp/vitest.e2e.config.ts \
 *        entrypoint/agent-mcp/src/__tests__/live/tracing-live.e2e.test.ts
 * Docs: entrypoint/agent-mcp/docs/logging.md
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveLogRoots, type LogRoots } from "../../config.js";
import { resolveTailDbPath } from "../../scripts/tail-db-path.js";

const LIVE = process.env["AGENT_MCP_LIVE"] === "1";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const REPO_ROOT = resolve(PROJECT_ROOT, "..", "..");
const PRODUCTION_NS = join(homedir(), ".adhd", "agent-mcp", "production");
const PROMPT = "Reply with exactly: ok";
const TASK_TIMEOUT_MS = 120_000;

/** Env that would redirect the store away from production; any of them set => refuse. */
const REDIRECT_ENV = [
    "ADHD_AGENT_DATABASE_PATH",
    "ADHD_AGENT_REGISTRY_DB_PATH",
    "ADHD_AGENT_LOGGING_DIR",
    "ADHD_AGENT_TRACING_LOG_DIR",
] as const;

type Kind = "claudecli" | "oauth";

interface IUsage {
    uncached: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
    /** Vendor-reported cost (claude CLI `total_cost_usd`), when the transport reports one. */
    vendorCostUsd?: number;
}

interface IEvidence {
    kind: Kind;
    agent: string;
    taskId: string;
    status: string;
    result: string;
    apiLines: Record<string, unknown>[];
    opsLines: Record<string, unknown>[];
    traceLines: Record<string, unknown>[];
    wireUsage: IUsage;
    dbTask: Record<string, unknown>;
    dbUsage: Record<string, unknown>;
    dbEvents: Record<string, unknown>[];
}

type Rec = Record<string, unknown>;

/** Reads every JSONL file in `dir` modified at/after `sinceMs` and returns the parsed lines. */
function readJsonl(dir: string, sinceMs: number): { file: string; line: string; rec: Rec }[] {
    if (!existsSync(dir)) return [];
    const out: { file: string; line: string; rec: Rec }[] = [];
    for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const file = join(dir, name);
        if (statSync(file).mtimeMs < sinceMs) continue;
        for (const line of readFileSync(file, "utf8").split("\n")) {
            if (!line.trim()) continue;
            try {
                out.push({ file, line, rec: JSON.parse(line) as Rec });
            } catch {
                /* a torn trailing line is not a record */
            }
        }
    }
    return out;
}

/** Built at runtime so this file never contains a literal key-shaped string (repo secret-scan). */
const PLANTED_PREFIX = ["sk", "ant", ""].join("-");

/** Secret shapes that must never appear in a log (LIVE-AC4). */
const SECRET_SHAPES: readonly RegExp[] = [
    /sk-ant-[A-Za-z0-9_-]{8,}/,
    /bearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/-]{8,}/i,
    /\bsk-[A-Za-z0-9]{20,}/,
    /\bghp_[A-Za-z0-9]{20,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
];

/** Returns the secret-looking substrings found in `text`, plus any literal env secret values. */
function findSecrets(text: string, literals: readonly string[]): string[] {
    const hits: string[] = [];
    for (const re of SECRET_SHAPES) {
        const m = re.exec(text);
        if (m) hits.push(`${re.source} -> ${m[0].slice(0, 6)}...`);
    }
    for (const lit of literals) if (text.includes(lit)) hits.push(`literal env secret (len ${lit.length})`);
    return hits;
}

/** Credential VALUES present in this process's env (names matching the server's own rule). */
function envSecretValues(): string[] {
    const name = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_KEY|AUTH)/i;
    return Object.entries(process.env)
        .filter(([k, v]) => v !== undefined && v.length >= 12 && name.test(k))
        .map(([, v]) => v as string);
}

async function freePort(): Promise<number> {
    return await new Promise((res, rej) => {
        const s = createServer();
        s.once("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const addr = s.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            s.close(() => res(port));
        });
    });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `probe` until it returns a value or `deadlineMs` elapses (bounded wait, never a fixed sleep). */
async function until<T>(probe: () => T | undefined, deadlineMs: number, what: string): Promise<T> {
    const end = Date.now() + deadlineMs;
    for (;;) {
        const v = probe();
        if (v !== undefined) return v;
        if (Date.now() > end) throw new Error(`timed out after ${deadlineMs}ms waiting for: ${what}`);
        await sleep(200);
    }
}

function gitPorcelain(): string {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
    return r.stdout;
}

const scratchNames = (): string[] =>
    readdirSync(tmpdir()).filter((n) => /^(agent-mcp-|adhd-agent-mcp)/.test(n));

/** Usage as the PROVIDER's wire reported it (independent of the DB). */
function wireUsage(kind: Kind, api: Rec[]): IUsage {
    if (kind === "oauth") {
        const resp = api.find((r) => r["event"] === "http.response" && String(r["body"] ?? "").includes("message_delta"));
        expect(resp, "an upstream http.response with a message_delta in the api log").toBeDefined();
        const events = String(resp?.["body"]).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as Rec);
        const start = events.find((e) => e["type"] === "message_start") as { message: { usage: Rec } } | undefined;
        const delta = events.filter((e) => e["type"] === "message_delta").pop() as { usage: Rec } | undefined;
        const u = delta?.usage ?? {};
        const cc = (start?.message.usage["cache_creation"] ?? {}) as Rec;
        const write = Number(u["cache_creation_input_tokens"] ?? 0);
        const w1h = Number(cc["ephemeral_1h_input_tokens"] ?? 0);
        return {
            uncached: Number(u["input_tokens"] ?? 0),
            cacheRead: Number(u["cache_read_input_tokens"] ?? 0),
            cacheWrite5m: write - w1h,
            cacheWrite1h: w1h,
            output: Number(u["output_tokens"] ?? 0),
        };
    }
    const result = api
        .filter((r) => r["event"] === "spawn.stdout")
        .map((r) => {
            try {
                return JSON.parse(String(r["body"])) as Rec;
            } catch {
                return undefined;
            }
        })
        .find((b) => b !== undefined && "total_cost_usd" in b);
    expect(result, "a claude CLI result record (spawn.stdout with total_cost_usd) in the api log").toBeDefined();
    const u = (result?.["usage"] ?? {}) as Rec;
    const cc = (u["cache_creation"] ?? {}) as Rec;
    const write = Number(u["cache_creation_input_tokens"] ?? 0);
    const w1h = Number(cc["ephemeral_1h_input_tokens"] ?? 0);
    return {
        uncached: Number(u["input_tokens"] ?? 0),
        cacheRead: Number(u["cache_read_input_tokens"] ?? 0),
        cacheWrite5m: write - w1h,
        cacheWrite1h: w1h,
        output: Number(u["output_tokens"] ?? 0),
        vendorCostUsd: Number(result?.["total_cost_usd"]),
    };
}

/** Rates per million tokens from the production price table (model_price_history), newest row. */
function rateFor(db: Database.Database, model: string): { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; output: number } {
    const id = `anthropic/${model.replace(/-(\d)-(\d)$/, "-$1.$2")}`;
    const row = db
        .prepare("SELECT input_per_m, cache_read_per_m, cache_write_per_m, output_per_m, raw_json FROM model_price_history WHERE model_id = ? ORDER BY observed_at DESC LIMIT 1")
        .get(id) as { input_per_m: number; cache_read_per_m: number; cache_write_per_m: number; output_per_m: number; raw_json: string } | undefined;
    expect(row, `a model_price_history row for ${id}`).toBeDefined();
    const raw = JSON.parse(row?.raw_json ?? "{}") as Record<string, string>;
    return {
        input: row?.input_per_m ?? 0,
        cacheRead: row?.cache_read_per_m ?? 0,
        cacheWrite: row?.cache_write_per_m ?? 0,
        cacheWrite1h: Number(raw["input_cache_write_1h"] ?? "0") * 1e6,
        output: row?.output_per_m ?? 0,
    };
}

describe.skipIf(!LIVE)("c536ce29 LIVE: tracing pipeline, real providers, real dev server, production store (AGENT_MCP_LIVE=1)", () => {
    const runStartMs = Date.now();
    let roots: LogRoots;
    let dbPath: string;
    let supervisor: ChildProcess | undefined;
    let serverPid = 0;
    let port = 0;
    let client: Client | undefined;
    let ro: Database.Database | undefined;
    const evidence = new Map<Kind, IEvidence>();
    const createdAgents: string[] = [];
    let homeBefore: string[] = [];
    let nsBefore: string[] = [];
    let scratchBefore: string[] = [];
    let porcelainBefore = "";

    const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
        const r = (await client?.callTool({ name, arguments: args }, undefined, { timeout: TASK_TIMEOUT_MS })) as {
            isError?: boolean;
            content?: { text?: string }[];
        };
        return { isError: r.isError === true, text: r.content?.[0]?.text ?? "" };
    };

    beforeAll(async () => {
        for (const v of REDIRECT_ENV) expect(process.env[v], `${v} must be unset: this test targets the production store`).toBeUndefined();
        roots = resolveLogRoots();
        dbPath = resolveTailDbPath();
        for (const p of [roots.root, roots.api, roots.ops, roots.trace, dbPath]) expect(p.startsWith(PRODUCTION_NS + "/")).toBe(true);
        expect(existsSync(join(PROJECT_ROOT, "dist", "src", "index.js")), "built dist missing: run `npx nx run agent-mcp:build` then `npx nx run agent-mcp:dist-manifest`").toBe(true);
        expect(existsSync(dbPath), "production DB must already exist").toBe(true);
        porcelainBefore = gitPorcelain();
        homeBefore = readdirSync(join(homedir(), ".adhd")).sort();
        nsBefore = readdirSync(join(homedir(), ".adhd", "agent-mcp")).sort();
        scratchBefore = scratchNames();

        port = await freePort();
        supervisor = spawn(process.execPath, [join(PROJECT_ROOT, "scripts", "serve.mjs"), "run", `--port=${port}`], {
            cwd: PROJECT_ROOT,
            env: { ...process.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        supervisor.stdout?.on("data", (d: Buffer) => (out += d.toString()));
        supervisor.stderr?.on("data", (d: Buffer) => (out += d.toString()));
        serverPid = await until(() => {
            const m = /started server pid=(\d+)/.exec(out);
            return m ? Number(m[1]) : undefined;
        }, 60_000, "serve.mjs to report `started server pid=`");

        const url = new URL(`http://127.0.0.1:${port}/`);
        const connect = async (): Promise<Client> => {
            const c = new Client({ name: "tracing-live", version: "1" });
            await c.connect(new StreamableHTTPClientTransport(url));
            return c;
        };
        const end = Date.now() + 60_000;
        for (;;) {
            try {
                client = await connect();
                break;
            } catch (err) {
                if (Date.now() > end) throw new Error(`server never accepted MCP connections: ${(err as Error).message}\n${out.slice(-2000)}`);
                await sleep(300);
            }
        }
        ro = new Database(dbPath, { readonly: true });

        const defs: Record<Kind, Record<string, unknown>> = {
            claudecli: {
                name: "live-trace-claudecli",
                systemPrompt: "You reply tersely.",
                provider: { type: "claudecli", model: "claude-haiku-4-5", timeoutMs: 110_000 },
                mcpServers: {},
                permissions: {},
            },
            oauth: {
                name: "live-trace-oauth",
                systemPrompt: "You reply tersely.",
                provider: { type: "anthropic", model: "claude-haiku-4-5", env: { secret: "ADHD_AGENT_ANTHROPIC_SECRET" }, timeoutMs: 110_000 },
                mcpServers: {},
                permissions: {},
            },
        };

        const raw: Partial<Record<Kind, { agent: string; taskId: string; status: string; result: string }>> = {};
        for (const kind of ["claudecli", "oauth"] as const) {
            const name = defs[kind]["name"] as string;
            if ((await call("agent_read", { name })).isError) {
                const created = await call("agent_create", defs[kind]);
                expect(created.isError, `agent_create ${name}: ${created.text}`).toBe(false);
                createdAgents.push(name);
            }
            const r = await call("task", { agent_name: name, prompt: PROMPT });
            expect(r.isError, `task ${name}: ${r.text}`).toBe(false);
            const body = JSON.parse(r.text) as { task_id: string; status: string; result: string };
            raw[kind] = { agent: name, taskId: body.task_id, status: body.status, result: body.result };
        }

        // Collect the logs. Wait (bounded) until every channel holds the terminal record of each task.
        for (const kind of ["claudecli", "oauth"] as const) {
            const r = raw[kind];
            if (!r) throw new Error(`no task result for ${kind}`);
            const lines = async (dir: string): Promise<Rec[]> => readJsonl(dir, runStartMs - 5_000).map((x) => x.rec).filter((x) => JSON.stringify(x).includes(r.taskId));
            const settle = async (): Promise<{ api: Rec[]; ops: Rec[]; trace: Rec[] } | undefined> => {
                const [api, ops, trace] = [await lines(roots.api), await lines(roots.ops), await lines(roots.trace)];
                const ok =
                    ops.some((x) => x["event"] === "task.completed") &&
                    trace.some((x) => x["event"] === "agent.task.finish") &&
                    api.some((x) => x["event"] === "mcp.response") &&
                    api.some((x) => (kind === "oauth" ? x["event"] === "http.response" : x["event"] === "spawn.close"));
                return ok ? { api, ops, trace } : undefined;
            };
            let got = await settle();
            const end2 = Date.now() + 20_000;
            while (!got && Date.now() < end2) {
                await sleep(250);
                got = await settle();
            }
            if (!got) throw new Error(`logs for ${kind} task ${r.taskId} never reached a terminal record in all three channels`);
            const dbTask = ro.prepare("SELECT * FROM tasks WHERE id = ?").get(r.taskId) as Rec;
            const dbUsage = ro.prepare("SELECT * FROM task_usage WHERE task_id = ?").get(r.taskId) as Rec;
            const dbEvents = ro.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at").all(r.taskId) as Rec[];
            evidence.set(kind, {
                kind,
                agent: r.agent,
                taskId: r.taskId,
                status: r.status,
                result: r.result,
                apiLines: got.api,
                opsLines: got.ops,
                traceLines: got.trace,
                wireUsage: wireUsage(kind, got.api),
                dbTask,
                dbUsage,
                dbEvents,
            });
        }
    }, 360_000);

    afterAll(async () => {
        try {
            for (const name of createdAgents) await call("agent_delete", { name });
        } finally {
            await client?.close().catch(() => undefined);
            ro?.close();
            if (supervisor?.pid) {
                supervisor.kill("SIGTERM");
                await new Promise<void>((r) => {
                    const t = setTimeout(r, 20_000);
                    supervisor?.once("exit", () => {
                        clearTimeout(t);
                        r();
                    });
                });
            }
        }
    }, 60_000);

    const KINDS = ["claudecli", "oauth"] as const;

    it.each(KINDS)("c536ce29 LIVE-AC1 [%s]: a completed task through the real server on the production store", (kind) => {
        const e = evidence.get(kind) as IEvidence;
        expect(serverPid).toBeGreaterThan(0);
        expect(e.status).toBe("completed");
        expect(e.result.trim()).toMatch(/^ok\.?$/i);
        expect(e.dbTask["status"]).toBe("completed");
        expect(e.dbUsage["is_complete"]).toBe(1);
        expect(e.dbUsage["provider_type"]).toBe(kind === "oauth" ? "anthropic" : "claudecli");
    });

    it.each(KINDS)("c536ce29 LIVE-AC2 [%s]: api + ops + trace lines and DB rows are linked by one task id", (kind) => {
        const e = evidence.get(kind) as IEvidence;
        const ops = e.opsLines.filter((x) => x["task_id"] === e.taskId);
        expect(ops.map((x) => x["event"])).toEqual(expect.arrayContaining(["task.start", "turn.start", "turn.end", "task.completed"]));
        const trace = e.traceLines.filter((x) => x["agent.task_id"] === e.taskId);
        expect(trace.map((x) => x["event"])).toEqual(expect.arrayContaining(["agent.task.start", "agent.model_call.start", "agent.model_call.finish", "agent.task.finish"]));
        const upstream = e.apiLines.filter((x) => x["task_id"] === e.taskId);
        const events = upstream.map((x) => x["event"]);
        expect(events).toEqual(expect.arrayContaining(kind === "oauth" ? ["http.request", "http.response"] : ["spawn.start", "spawn.stdin", "spawn.stdout", "spawn.close"]));
        // The upstream call is one call_id (request <-> response, spawn.start <-> spawn.close).
        const callIds = new Set(upstream.map((x) => x["call_id"]));
        expect(callIds.size).toBe(1);
        // The inbound MCP request that started the task carries the same task id in its response and the ops call_id.
        const mcp = e.apiLines.find((x) => x["event"] === "mcp.response" && x["tool"] === "task");
        expect(String(mcp?.["body"])).toContain(e.taskId);
        expect(ops[0]?.["call_id"]).toBe(mcp?.["call_id"]);
        // DB side.
        expect(e.dbTask["id"]).toBe(e.taskId);
        expect(e.dbUsage["task_id"]).toBe(e.taskId);
        expect(e.dbEvents.length).toBeGreaterThanOrEqual(3);
        expect(e.dbEvents.map((x) => x["type"])).toEqual(expect.arrayContaining(["MODEL_REQUEST", "MODEL_RESPONSE", "TASK_COMPLETED"]));
        expect(e.dbTask["session_id"]).toBe(ops[0]?.["session_id"]);
        // Provider-specific wire evidence.
        if (kind === "oauth") {
            const req = upstream.find((x) => x["event"] === "http.request") as Rec;
            expect(req["url"]).toBe("https://api.anthropic.com/v1/messages");
            expect((req["headers"] as Rec)["authorization"]).toMatch(/^\[REDACTED:/);
            expect((upstream.find((x) => x["event"] === "http.response") as Rec)["status"]).toBe(200);
        } else {
            expect(upstream.find((x) => x["event"] === "spawn.close")?.["stdout_bytes"]).toBeGreaterThan(0);
        }
    });

    it.each(KINDS)("c536ce29 LIVE-AC3 [%s]: DB tokens and cost equal api-log usage x pricing-table rate", (kind) => {
        const e = evidence.get(kind) as IEvidence;
        const u = e.wireUsage;
        const wireInput = u.uncached + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
        // Tokens: the DB row equals what the provider reported on the wire.
        expect(e.dbUsage["input_tokens"]).toBe(wireInput);
        expect(e.dbUsage["output_tokens"]).toBe(u.output);
        expect(e.dbUsage["cache_read_input_tokens"] ?? 0).toBe(u.cacheRead);
        expect(e.dbUsage["cache_creation_input_tokens"] ?? 0).toBe(u.cacheWrite5m + u.cacheWrite1h);
        expect(e.dbUsage["uncached_input_tokens"]).toBe(u.uncached);
        // The ops-log turn.end record carries the same totals.
        const turnEnd = e.opsLines.find((x) => x["event"] === "turn.end") as Rec;
        expect(turnEnd["input_tokens"]).toBe(wireInput);
        expect(turnEnd["output_tokens"]).toBe(u.output);

        // Cost: wire usage x the production price table (model_price_history), written out.
        const db = new Database(dbPath, { readonly: true });
        try {
            const rate = rateFor(db, String(e.dbUsage["model"]));
            const expected =
                (u.uncached * rate.input + u.cacheRead * rate.cacheRead + u.cacheWrite5m * rate.cacheWrite + u.cacheWrite1h * rate.cacheWrite1h + u.output * rate.output) / 1e6;
            // The oracle must agree with the vendor's own number where the vendor reports one.
            if (u.vendorCostUsd !== undefined) expect(expected).toBeCloseTo(u.vendorCostUsd, 7);
            expect(e.dbUsage["cost_status"]).toBe("priced");
            expect(e.dbUsage["priced_cost_usd"] as number).toBeCloseTo(expected, 9);
            expect(e.dbUsage["est_cost_usd"] as number).toBeCloseTo(expected, 9);
            expect(String(e.dbUsage["pricing_ref"])).toMatch(/^(rate-card:|bundled:|[0-9a-f-]{36}$)/);
        } finally {
            db.close();
        }
    });

    it("c536ce29 LIVE-AC4: no secret appears in any api/ops/trace log written by this run (and the scanner has teeth)", () => {
        const literals = envSecretValues();
        // Negative control: the scanner flags a planted bearer token, an sk-ant key and a literal value.
        expect(findSecrets(`authorization: Bearer ${PLANTED_PREFIX}oat01-abcdefghijklmnop`, [])).not.toEqual([]);
        expect(findSecrets(`x-api-key ${PLANTED_PREFIX}api03-abcdefghijklmnop`, [])).not.toEqual([]);
        expect(findSecrets("nothing here but SECRETVALUE12345", ["SECRETVALUE12345"])).not.toEqual([]);
        expect(findSecrets("authorization: [REDACTED:f1ffb24f:len=26]", [])).toEqual([]);

        const leaks: string[] = [];
        for (const dir of [roots.api, roots.ops, roots.trace]) {
            for (const { file, line } of readJsonl(dir, runStartMs - 5_000)) {
                for (const hit of findSecrets(line, literals)) leaks.push(`${file}: ${hit}`);
            }
        }
        expect(leaks).toEqual([]);
        // Redaction actually ran on the OAuth request: the header is a placeholder, not absent.
        const oauth = evidence.get("oauth") as IEvidence;
        const req = oauth.apiLines.find((x) => x["event"] === "http.request") as Rec;
        expect((req["headers"] as Rec)["authorization"]).toMatch(/^\[REDACTED:[0-9a-f]+:len=\d+\]$/);
    });

    it("c536ce29 LIVE-AC5: nothing written outside ~/.adhd/agent-mcp/production and the repo tmp/", () => {
        // Store paths are the production namespace.
        for (const p of [roots.api, roots.ops, roots.trace, dbPath]) expect(p.startsWith(PRODUCTION_NS + "/")).toBe(true);
        // Tracked and untracked (non-ignored) repo state is unchanged by the run.
        expect(gitPorcelain()).toBe(porcelainBefore);
        // No new top-level entries under ~/.adhd or ~/.adhd/agent-mcp.
        expect(readdirSync(join(homedir(), ".adhd")).sort()).toEqual(homeBefore);
        expect(readdirSync(join(homedir(), ".adhd", "agent-mcp")).sort()).toEqual(nsBefore);
        // The claudecli scratch (mcp-config / agent-spec) lives under <production>/temp, not os.tmpdir().
        const leaked = scratchNames().filter((n) => !scratchBefore.includes(n));
        expect(leaked).toEqual([]);
        // The server's pid/log live under the repo's gitignored tmp/ (serve.mjs).
        expect(existsSync(join(REPO_ROOT, "tmp", "agent-mcp", "serve", `serve-${port}.log`))).toBe(true);
    });
});
