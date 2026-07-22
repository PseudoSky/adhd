/**
 * Teeth test for BUG-AGENTMCP-SSE-PORT-CONTENTION-001.
 *
 * agent-mcp is a stdio-transport MCP server: every host connection spawns
 * its own OS process, so N instances run concurrently. Before this fix,
 * every instance unconditionally bound the SAME fixed SSE port
 * (`env.config.sse.port`, default 3001) — the first instance won the bind,
 * every later one got `EADDRINUSE`, logged a warning, and permanently lost
 * SSE task-streaming AND the OpenAI-compat gateway for its whole lifetime
 * (`startSseServer`'s old `server.on('error', ...)` handler just logged and
 * returned; it never retried).
 *
 * This file proves, against the REAL `startSseServer` (a real `http.Server`
 * bound to a real loopback port — no mocking of the thing under test):
 *
 *  1. Two servers independently REQUESTING THE SAME PORT both come up —
 *     the second falls back to a distinct, OS-assigned ephemeral port
 *     instead of losing SSE/gateway service.
 *  2. Neither server crashes; both are live (accept real HTTP connections).
 *  3. `config.ts`'s bound-port-propagation (`setSseBoundPort` +
 *     `toEngineConfig()`) correctly advertises the port a server ACTUALLY
 *     bound to, not the one it originally requested — the discovery-
 *     correctness half of the fix (`stream_url`/gateway baseUrl links must
 *     point at the real port).
 *  4. `resolveInitialSsePort()` honors an explicit user pin as-is, and
 *     derives a stable-but-different-per-instance candidate otherwise
 *     (feeds directly into (1): this is why two REAL instances mostly
 *     don't even reach the contention path in normal operation — they only
 *     collide when explicitly pinned to the same port, or on a hash
 *     collision, both of which (1) proves are handled anyway).
 *
 * Red -> green (manually verified during development, not re-run
 * automatically here — hand-reverting shipped source inside a permanent
 * test file would itself be a regression risk): reverting
 * `startSseServer`'s `EADDRINUSE` branch to the pre-fix
 * "log a warning, `settle(undefined)`, never retry" behavior makes
 * assertion (1) below fail immediately (`second.port` is `undefined`
 * instead of a distinct live port); reverting `setSseBoundPort`/
 * `toEngineConfig()`'s fallback to the pre-fix
 * `` `http://localhost:${env.config.sse.port}` `` (ignoring the actual
 * bound port entirely) makes assertion (3) fail (`baseUrl` would report
 * the ORIGINALLY REQUESTED port, not the ephemeral one actually bound).
 * Restoring the current source returns both to green.
 */
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { TaskStore } from "@adhd/agent-store-runtime";
import { Environment } from "@adhd/environment";

import { startSseServer } from "../streaming/sse-server.js";
import {
  agentMcpEnvironmentSpec,
  computeSseBaseUrl,
  deriveInstancePort,
  env,
  resolveInitialSsePort,
  setSseBoundPort,
  toEngineConfig,
  type AgentMcpConfig,
} from "../config.js";

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

const CREATE_TASKS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT,
    parent_task_id TEXT,
    is_ephemeral INTEGER DEFAULT 0 NOT NULL,
    recursion_depth INTEGER DEFAULT 0 NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    prompt TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    cancelled_at TEXT,
    depends_on TEXT,
    on_upstream_failure TEXT,
    inputs TEXT,
    resume_token TEXT
);
CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
);
`;

/** A minimal, real (not mocked) TaskStore — enough for startSseServer's
 *  request handler to safely call `taskStore.read()` without throwing on a
 *  missing table. No task rows are needed: this suite never exercises the
 *  `/tasks/:id/stream` body, only bind/port/liveness behavior. */
function buildTaskStore(): { taskStore: TaskStore; close: () => void } {
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_TASKS_TABLE_SQL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite) as any;
  return { taskStore: new TaskStore(db), close: () => sqlite.close() };
}

/** Reserves a genuinely free loopback port by binding an OS-assigned
 *  ephemeral port and immediately releasing it — used as the "both
 *  instances happen to want the same port" fixture below. Small residual
 *  race window (another process could grab it between release and reuse)
 *  is inherent to this technique on any OS and is not itself under test. */
async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = addr && typeof addr === "object" ? addr.port : undefined;
      probe.close(() => {
        if (port === undefined) reject(new Error("could not reserve a free port"));
        else resolve(port);
      });
    });
  });
}

async function httpGetStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        res.resume();
        resolve(res.statusCode ?? -1);
      })
      .on("error", reject);
  });
}

const cleanupDirs: string[] = [];
const openServers: http.Server[] = [];
const closeFns: Array<() => void> = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
  closeFns.splice(0).forEach((fn) => fn());
  cleanupDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  setSseBoundPort(undefined);
});

// ──────────────────────────────────────────────────────────────────────────
// 1+2. Real port contention → distinct, live, non-fatal outcomes
// ──────────────────────────────────────────────────────────────────────────

describe("BUG-AGENTMCP-SSE-PORT-CONTENTION-001: startSseServer port fallback", () => {
  it("a second server requesting the SAME port as an already-bound first server falls back to a distinct, live, OS-assigned port instead of being disabled", async () => {
    const contestedPort = await reserveFreePort();

    const first = buildTaskStore();
    closeFns.push(first.close);
    const firstResult = await startSseServer(first.taskStore, contestedPort, "127.0.0.1");
    openServers.push(firstResult.server);

    // First instance gets exactly the port it asked for — no contention yet.
    expect(firstResult.port).toBe(contestedPort);

    const second = buildTaskStore();
    closeFns.push(second.close);
    const secondResult = await startSseServer(second.taskStore, contestedPort, "127.0.0.1");
    openServers.push(secondResult.server);

    // The core assertion: the second instance is NOT disabled (port is
    // defined) and did NOT get the contested port (proves the fallback
    // actually engaged rather than silently reusing/erroring).
    expect(secondResult.port).toBeDefined();
    expect(secondResult.port).not.toBe(contestedPort);
    expect(secondResult.port).not.toBe(0);

    // Both servers are genuinely live — real HTTP round-trip to each.
    const firstStatus = await httpGetStatus(firstResult.port as number, "/nonexistent");
    const secondStatus = await httpGetStatus(secondResult.port as number, "/nonexistent");
    expect(firstStatus).toBe(404);
    expect(secondStatus).toBe(404);
  });

  it("N=3 servers all requesting the same contested port all end up live on distinct ports", async () => {
    const contestedPort = await reserveFreePort();
    const results: Array<{ port: number | undefined }> = [];

    for (let i = 0; i < 3; i++) {
      const { taskStore, close } = buildTaskStore();
      closeFns.push(close);
      const result = await startSseServer(taskStore, contestedPort, "127.0.0.1");
      openServers.push(result.server);
      results.push(result);
    }

    for (const r of results) {
      expect(r.port).toBeDefined();
    }
    const ports = results.map((r) => r.port);
    expect(new Set(ports).size).toBe(3); // all distinct
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3. Discovery correctness: toEngineConfig() advertises the ACTUAL bound
//    port, not the originally-requested one.
// ──────────────────────────────────────────────────────────────────────────

describe("BUG-AGENTMCP-SSE-PORT-CONTENTION-001: bound-port propagation into toEngineConfig()", () => {
  it("advertises the ACTUAL bound port once setSseBoundPort() has run, even though it differs from the requested/configured port", async () => {
    const contestedPort = await reserveFreePort();

    const winner = buildTaskStore();
    closeFns.push(winner.close);
    const winnerResult = await startSseServer(winner.taskStore, contestedPort, "127.0.0.1");
    openServers.push(winnerResult.server);
    expect(winnerResult.port).toBe(contestedPort);

    const loser = buildTaskStore();
    closeFns.push(loser.close);
    const loserResult = await startSseServer(loser.taskStore, contestedPort, "127.0.0.1");
    openServers.push(loserResult.server);
    expect(loserResult.port).toBeDefined();
    expect(loserResult.port).not.toBe(contestedPort);

    // Simulate this process being the "loser" instance: its main() calls
    // setSseBoundPort(loserResult.port) before any toEngineConfig() call.
    setSseBoundPort(loserResult.port);

    const engineConfig = toEngineConfig();
    // Negative proof embedded in the assertion itself: the pre-fix code
    // always advertised `http://localhost:${env.config.sse.port}` (the
    // CONFIGURED default, unrelated to contestedPort/loserResult.port) —
    // this assertion would fail against that code because
    // env.config.sse.port (3001 by default) is neither contestedPort nor
    // loserResult.port in the overwhelming common case.
    expect(engineConfig.sse.baseUrl).toBe(`http://localhost:${loserResult.port}`);
    expect(engineConfig.sse.baseUrl).not.toBe(`http://localhost:${env.config.sse.port}`);
  });

  it("falls back to the configured port when no server has bound yet (resolvedSseBoundPort unset)", () => {
    setSseBoundPort(undefined);
    const engineConfig = toEngineConfig();
    expect(engineConfig.sse.baseUrl).toBe(`http://localhost:${env.config.sse.port}`);
  });

  it("an explicit sse.baseUrl (ADHD_AGENT_SSE_BASE_URL) override always wins over the actual bound port", () => {
    // Exercises the REAL precedence function config.ts's toEngineConfig()
    // calls — override present, bound port also present and different:
    // override must win.
    expect(computeSseBaseUrl("https://public.example.com", 54321, 3001)).toBe(
      "https://public.example.com"
    );
  });

  it("computeSseBaseUrl prefers the actual bound port over the configured port when no override is set", () => {
    expect(computeSseBaseUrl(undefined, 54321, 3001)).toBe("http://localhost:54321");
  });

  it("computeSseBaseUrl falls back to the configured port when neither an override nor a bound port is known", () => {
    expect(computeSseBaseUrl(undefined, undefined, 3001)).toBe("http://localhost:3001");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4. resolveInitialSsePort(): explicit pin vs per-instance derivation
// ──────────────────────────────────────────────────────────────────────────

/** Isolated `adhdRoot` — mirrors `config.zero-config.test.ts`'s fixture so
 *  this never reads/writes the real machine's `~/.adhd`. */
function mkAdhdRoot(): string {
  const base = join(__dirname, "..", "..", "..", "..", "tmp", "agent-mcp", "sse-port-test");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "root-"));
  cleanupDirs.push(dir);
  return dir;
}

/** Isolated `cwd` outside this repo's git tree (see `config.zero-config.test.ts`
 *  for why: a `.git` ancestor would flip scope resolution to `'project'`). */
function mkCwdFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "adhd-agent-mcp-sse-port-cwd-"));
  cleanupDirs.push(dir);
  return dir;
}

function withEnvVar(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

function makeIsolatedEnv(): Environment<AgentMcpConfig> {
  return new Environment<AgentMcpConfig>("agent-mcp", agentMcpEnvironmentSpec, {
    namespace: "production",
    scope: "global",
    adhdRoot: mkAdhdRoot(),
    cwd: mkCwdFixture(),
  });
}

describe("BUG-AGENTMCP-SSE-PORT-CONTENTION-001: resolveInitialSsePort()", () => {
  it("honors an explicitly-set ADHD_AGENT_SSE_PORT exactly (provenance source !== 'default')", () => {
    const restore = withEnvVar("ADHD_AGENT_SSE_PORT", "6123");
    try {
      const isolated = makeIsolatedEnv();
      const result = resolveInitialSsePort(isolated);
      expect(result.explicit).toBe(true);
      expect(result.port).toBe(6123);
    } finally {
      restore();
    }
  });

  it("derives a per-instance candidate (not the fixed 3001 default) when unset, deterministically from instanceId", () => {
    const restore = withEnvVar("ADHD_AGENT_SSE_PORT", undefined);
    try {
      const isolated = makeIsolatedEnv();
      const result = resolveInitialSsePort(isolated);
      expect(result.explicit).toBe(false);
      expect(result.port).toBe(deriveInstancePort(isolated.instanceId));
      // Never silently falls back to the old shared-contention default.
      expect(result.port).not.toBe(3001);
    } finally {
      restore();
    }
  });

  it("deriveInstancePort is a pure, deterministic function of instanceId (same input -> same output every call)", () => {
    expect(deriveInstancePort("abc-123")).toBe(deriveInstancePort("abc-123"));
    expect(deriveInstancePort("abc-123")).not.toBe(deriveInstancePort("xyz-789"));
  });
});
