/**
 * dispatch-native-tooling.e2e.test.ts — NAT-TOOL-5 rework (ADR-0008 D4/D8).
 *
 * DEFAULT-RUNNING, hermetic proof through the REAL dispatch host path:
 * `buildProductionAgentMcpRunner` → a real spawned `@adhd/agent-mcp` over stdio
 * JSON-RPC → the stored definition, read back from the registry. No model call
 * is made (`agent_create` / `agent_read` / `agent_verify_mcp` only), so nothing
 * is env-gated.
 *
 * The host STORES only DECLARATIVE state on a dispatch-created agent — the
 * explicit `mcpServers` half (memory-server + backlog) plus a declarative
 * `nativeTooling` — and NEVER writes a resolved fs/shell root. The spawned
 * agent-mcp child resolves `nativeTooling` at TASK time against its own cwd
 * (threaded by the host, D9).
 *
 * ACs (each revert-failing):
 *  A. a dispatch-created agent's stored JSON is byte-identical after firing
 *     `/P` then `/Q` (D8) — reuse performs no write.
 *  B. the fs root resolves to each dispatching cwd (`/P` → `/P`; `/Q` → `/Q`)
 *     via cwd propagation, not a stored root.
 *  C. no resolved fs-root/absolute-cwd is written into a stored `mcpServers`.
 *  D. the explicit memory/backlog servers are present and win (D1).
 *
 * Hermetic: isolated `cwd` + fake `$HOME` + temp `ADHD_AGENT_DATABASE_PATH`
 * (ADR-0008 D11 — agent-mcp's `loadEnvHierarchy` loads `<cwd>/.env` with
 * `override:true` and would otherwise clobber pinned env).
 */
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DispatchUnit } from '@adhd/dispatch-base-spec';
import type { McpServerConfig } from '@adhd/agent-base-types';
import { resolveNativeToolingMap } from '@adhd/agent-core-native-tooling';

import { buildProductionAgentMcpRunner } from '../lib/core.js';
import {
  AGENT_MCP_DIST,
  assertAgentMcpBuilt,
  buildChildEnv,
  cleanupScratch,
  mkFakeHome,
  mkScratch,
} from './helpers/agent-mcp-registry.js';

beforeAll(() => assertAgentMcpBuilt());
afterAll(() => cleanupScratch());

/** A test-only stdio MCP server that reports the cwd it inherited as its tool name. */
const CWD_ECHO = join(__dirname, 'fixtures', 'cwd-echo-server.mjs');

const UNIT = {
  agent_name: 'nat-tool-5-agent',
  provider: null,
  systemPrompt: 'You are a dispatched agent.',
} as unknown as DispatchUnit;

/** The tool name `cwd-echo-server.mjs` exposes when spawned with cwd = `dir`. */
function echoTool(dir: string): string {
  return `at_${basename(dir).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** Build a production dispatch runner pointed at the BUILT agent-mcp, isolated. */
function productionRunner(opts: {
  cwd: string;
  dbPath: string;
  home: string;
  nativeTooling?: Record<string, unknown>;
}) {
  return buildProductionAgentMcpRunner(
    {
      ...process.env,
      ADHD_AGENT_MCP_COMMAND: process.execPath,
      ADHD_AGENT_MCP_ARGS: AGENT_MCP_DIST,
      // Pin a synthetic, cwd-INDEPENDENT backlog entry — the backlog server is
      // never required to work here (only probed by `agent_verify_mcp`, where it
      // fails fast), and a cwd-relative path would muddy the "no /P root" check.
      ADHD_DISPATCH_BACKLOG_MCP_ENTRY: '/tmp/adhd-nat-tool-5/synthetic/backlog/index.js',
      // A refused port, so a verify probe of `memory-server` fails immediately
      // instead of hanging on an absent localhost listener.
      ADHD_DISPATCH_MEMORY_MCP_URL: 'http://127.0.0.1:1/sse',
    },
    {
      cwd: opts.cwd,
      createAgentsIfMissing: true,
      ...(opts.nativeTooling ? { nativeTooling: opts.nativeTooling } : {}),
      env: buildChildEnv({
        HOME: opts.home,
        ADHD_AGENT_DATABASE_PATH: opts.dbPath,
        ADHD_AGENT_SSE_ENABLED: 'false',
        ADHD_AGENT_TRANSPORT: 'stdio',
      }),
    }
  );
}

function stdio(map: Record<string, McpServerConfig>, key: string): Extract<McpServerConfig, { transport: 'stdio' }> {
  const cfg = map[key];
  if (!cfg || cfg.transport !== 'stdio') throw new Error(`no stdio '${key}' server`);
  return cfg;
}

function fsRoot(map: Record<string, McpServerConfig>): string {
  const args = stdio(map, 'fs').args ?? [];
  const root = args[args.length - 1];
  if (!root) throw new Error('fs server resolved without a root arg');
  return root;
}

describe('NAT-TOOL-5 rework — the dispatch host STORES declarative, resolves at task time', () => {
  it('AC-A/AC-C/AC-D: the stored definition is declarative + byte-identical after /P then /Q', async () => {
    const scratch = mkScratch('nat-tool-5-ac-a');
    const P = join(scratch, 'P');
    const Q = join(scratch, 'Q');
    mkdirSync(P, { recursive: true });
    mkdirSync(Q, { recursive: true });
    const home = mkFakeHome(scratch);
    const dbPath = join(scratch, 'registry.db');
    const AGENT = 'nat-tool-5-portable';
    const unit = { ...UNIT, agent_name: AGENT } as DispatchUnit;

    // (1) First dispatch: create the agent at /P.
    const first = productionRunner({ cwd: P, dbPath, home });
    let storedAtP: Record<string, unknown>;
    try {
      await first.ensureAgent(unit);
      storedAtP = await first.callTool<Record<string, unknown>>('agent_read', { name: AGENT });
    } finally {
      await first.close().catch(() => undefined);
    }

    // Declarative nativeTooling — no resolved root.
    expect(storedAtP['nativeTooling']).toEqual({ fs: true, shell: true, dispatch: true });

    // AC-D: the explicit memory/backlog half is present.
    const map = (storedAtP['mcpServers'] ?? {}) as Record<string, McpServerConfig>;
    expect(Object.keys(map).sort()).toEqual(['backlog', 'memory-server']);
    expect(map['memory-server']).toMatchObject({ transport: 'sse' });
    expect(map['backlog']).toMatchObject({ transport: 'stdio', command: 'node' });

    // AC-C: no resolved fs-root / absolute-cwd / native server in the stored map.
    // NEGATIVE CONTROL: baking the resolved native map (the pre-rework behavior)
    // puts `server-filesystem` + `<cwd>` here and makes this red.
    const serialized = JSON.stringify(map);
    expect(serialized).not.toContain('server-filesystem');
    expect(serialized).not.toContain('mcp-shell-server');
    expect(serialized).not.toContain(P);
    expect(serialized).not.toContain(Q);
    expect(serialized).not.toContain('"cwd"');

    // (2) AC-A: reuse the SAME agent from /Q — reuse performs NO write.
    const second = productionRunner({ cwd: Q, dbPath, home });
    try {
      await second.ensureAgent(unit);
      const storedAtQ = await second.callTool<Record<string, unknown>>('agent_read', { name: AGENT });
      // NEGATIVE CONTROL: the pre-rework reuse re-assertion (an `agent_update`
      // that rewrote the map at /Q) would change this JSON -> red.
      expect(JSON.stringify(storedAtQ)).toBe(JSON.stringify(storedAtP));
    } finally {
      await second.close().catch(() => undefined);
    }
  }, 60_000);

  it('AC-B: the fs root resolves to each dispatching cwd (cwd propagation, not a stored root)', async () => {
    const scratch = mkScratch('nat-tool-5-ac-b');
    const P = join(scratch, 'P');
    const Q = join(scratch, 'Q');
    mkdirSync(P, { recursive: true });
    mkdirSync(Q, { recursive: true });
    const home = mkFakeHome(scratch);
    const dbPath = join(scratch, 'registry.db');
    const AGENT = 'nat-tool-5-ac-b';
    const unit = { ...UNIT, agent_name: AGENT } as DispatchUnit;
    const dispatchSelf: McpServerConfig = { transport: 'stdio', command: 'npx', args: ['-y', '@adhd/agent-mcp'] };

    // (1) Capture the STORED declarative config from the real host at /P.
    const first = productionRunner({ cwd: P, dbPath, home });
    let storedNative: Record<string, unknown>;
    try {
      await first.ensureAgent(unit);
      const def = await first.callTool<{
        nativeTooling?: Record<string, unknown>;
        mcpServers?: Record<string, McpServerConfig>;
      }>('agent_read', { name: AGENT });
      storedNative = def.nativeTooling ?? {};
      // The stored map carries no /P root — so a /P root can only come from cwd.
      expect(JSON.stringify(def.mcpServers ?? {})).not.toContain(P);
    } finally {
      await first.close().catch(() => undefined);
    }

    // (2) The SAME stored declarative config resolves fs root /P then /Q — the
    //     exact computation the child performs against its process.cwd(). The
    //     host stores the declaration; the root is cwd-derived, never stored.
    const atP = resolveNativeToolingMap(storedNative, { cwd: P, dispatchSelf });
    const atQ = resolveNativeToolingMap(storedNative, { cwd: Q, dispatchSelf });
    expect(fsRoot(atP)).toBe(P);
    expect(fsRoot(atQ)).toBe(Q);

    // (3) End-to-end cwd propagation through the REAL host + child: a resolved
    //     server inherits the dispatching cwd. A custom fs server (declarative,
    //     no baked root) reports its inherited cwd via its tool name, read back
    //     through the child's `agent_verify_mcp`.
    const echoAgent = 'nat-tool-5-ac-b-echo';
    const customFs: McpServerConfig = {
      transport: 'stdio',
      command: process.execPath,
      args: [CWD_ECHO],
    };
    const echoUnit = { ...UNIT, agent_name: echoAgent } as DispatchUnit;

    const echoAtP = productionRunner({
      cwd: P,
      dbPath,
      home,
      nativeTooling: { fs: customFs, shell: false, dispatch: false },
    });
    try {
      await echoAtP.ensureAgent(echoUnit);
      const verified = await echoAtP.callTool<{
        servers: Array<{ name: string; status: string; tools?: string[] }>;
      }>('agent_verify_mcp', { name: echoAgent });
      const fsServer = verified.servers.find((s) => s.name === 'fs');
      expect(fsServer?.status, 'the custom fs server must resolve + handshake').toBe('verified');
      expect(fsServer?.tools, 'the resolved server inherits the dispatching cwd /P').toContain(
        echoTool(P)
      );
    } finally {
      await echoAtP.close().catch(() => undefined);
    }

    const echoAtQ = productionRunner({
      cwd: Q,
      dbPath,
      home,
      nativeTooling: { fs: customFs, shell: false, dispatch: false },
    });
    try {
      await echoAtQ.ensureAgent(echoUnit);
      const verified = await echoAtQ.callTool<{
        servers: Array<{ name: string; status: string; tools?: string[] }>;
      }>('agent_verify_mcp', { name: echoAgent });
      const fsServer = verified.servers.find((s) => s.name === 'fs');
      expect(fsServer?.status).toBe('verified');
      expect(fsServer?.tools, 'the SAME stored def resolves to /Q on reuse').toContain(
        echoTool(Q)
      );
    } finally {
      await echoAtQ.close().catch(() => undefined);
    }
  }, 90_000);
});
