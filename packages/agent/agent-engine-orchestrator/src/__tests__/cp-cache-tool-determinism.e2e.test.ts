/**
 * cp-cache-tool-determinism.e2e.test.ts — 9ed453c1 CACHE: the advertised tool definitions are
 * byte-identical across independently spawned servers, so the cached prompt prefix survives the
 * task boundary.
 *
 * Real components: the real `McpClientRegistry` spawning REAL stdio servers — the genuine
 * `mcp-shell-server==1.1.12` through `uvx` (a hard prerequisite, same as the product's default
 * toolset: a missing `uvx` turns this suite red, it does not skip) and an offline fixture that
 * reproduces the unordered-set behaviour with a fresh shuffle per process — and the real
 * `ClaudeCliProvider.chat()` + loopback bridge (only the `claude` binary is the fake CLI).
 *
 * Negative controls (recorded when authored, 9ed453c1): without `canonicalizeToolDefinitions`, the
 * five real-server spawns (PYTHONHASHSEED=1..5) yield MORE THAN ONE distinct sha256, and so do the
 * five fixture spawns and the two bridge listings — the `expect(raw.size).toBeGreaterThan(1)`
 * assertions below are those recordings and go red if the premise stops holding.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { McpClientRegistry } from '../clients/registry.js';
import type { InProcessToolHandler } from '../clients/in-process.js';
import { canonicalizeToolDefinitions } from '../engine/tool-schema-compact.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import { ClaudeCliProvider } from '../providers/claudecli.js';
import type { ToolDefinition } from '../providers/types.js';
import type { ExecutionContext, McpServerConfig } from '../validation/index.js';

const SHUFFLED = fileURLToPath(new URL('./fixtures/shuffled-allowlist-server.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-mcp.mjs', import.meta.url));
const ALLOW = 'ls,cat,echo,pwd,grep,head,tail,wc,sort,find';
const N = 5;

const ctx = {} as ExecutionContext;
const noopHandler: InProcessToolHandler = (async () => ({})) as unknown as InProcessToolHandler;
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Engine config shaped like the claudecli bridge harness (stdio spawn needs cwd/subprocessEnv). */
const engineFor = (dir: string, extraEnv: Record<string, string> = {}): EngineConfig =>
  ({
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: '' },
    plugins: { entries: [] },
    cwd: dir,
    wire: { tempDir: join(dir, 'tmp') },
    getProviderConfig: () => ({}),
    subprocessEnv: () => extraEnv,
    resolveEnvName: () => undefined,
    isEnvNameAllowed: () => true,
  }) as unknown as EngineConfig;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Spawn the server fresh (a new process, like a new task), list its tools, close it. */
async function listFresh(cfg: McpServerConfig): Promise<ToolDefinition[]> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adhd-cpcache-')));
  dirs.push(dir);
  const registry = new McpClientRegistry({ shell: cfg }, undefined, [], noopHandler, ctx, { ...engineFor(dir), wire: undefined } as EngineConfig, logger);
  try {
    return await registry.listAllTools();
  } finally {
    await registry.closeAll();
  }
}

const realServer = (seed: number): McpServerConfig =>
  ({
    transport: 'stdio',
    command: 'uvx',
    args: ['--from', 'mcp-shell-server==1.1.12', 'mcp-shell-server'],
    env: { ALLOW_COMMANDS: ALLOW, PYTHONHASHSEED: String(seed) },
  }) as McpServerConfig;

const fixtureServer = (): McpServerConfig =>
  ({ transport: 'stdio', command: process.execPath, args: [SHUFFLED], env: { ALLOW_COMMANDS: ALLOW } }) as McpServerConfig;

describe('9ed453c1 CACHE AC1: N independently spawned servers => byte-identical definitions after normalization', () => {
  it('9ed453c1 CACHE AC1: REAL mcp-shell-server==1.1.12 (uvx), PYTHONHASHSEED=1..5', async () => {
    const raw: ToolDefinition[][] = [];
    for (let seed = 1; seed <= N; seed++) raw.push(await listFresh(realServer(seed)));
    expect(raw.every((t) => t.some((d) => /Allowed commands: /.test(d.description ?? '')))).toBe(true);

    // negative control (recorded): the raw definitions are NOT stable across spawns
    expect(new Set(raw.map(sha)).size).toBeGreaterThan(1);
    // the fix
    const normalized = raw.map((t) => sha(canonicalizeToolDefinitions(t)));
    expect(new Set(normalized).size).toBe(1);

    // semantics: the allowed set is exactly the configured one
    const d = canonicalizeToolDefinitions(raw[0]!)[0]!.description!;
    const listed = /^Allowed commands: (.*)$/m.exec(d)![1]!.split(', ');
    expect(new Set(listed)).toEqual(new Set(ALLOW.split(',')));
  }, 180_000);

  it('9ed453c1 CACHE AC1: offline fixture reproducing the unordered set (fresh shuffle per process), 5 spawns', async () => {
    const raw: ToolDefinition[][] = [];
    for (let i = 0; i < N; i++) raw.push(await listFresh(fixtureServer()));
    expect(new Set(raw.map(sha)).size).toBeGreaterThan(1);
    expect(new Set(raw.map((t) => sha(canonicalizeToolDefinitions(t)))).size).toBe(1);
  }, 60_000);
});

describe('9ed453c1 CACHE AC3: the claudecli bridge tools/list is byte-stable across two chat() calls', () => {
  it('9ed453c1 CACHE AC3: two tasks, two server spawns => identical bridge listing; raw listings differ', async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    const listings: string[] = [];
    const rawShas: string[] = [];

    for (let task = 0; task < 2; task++) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adhd-cpcache-')));
      dirs.push(dir);
      const selfOut = join(dir, 'claude-self.json');
      const cfg = fixtureServer();
      const bridgeEngine = engineFor(dir, { ADHD_FAKE_CLAUDE_OUT: selfOut });
      const registry = new McpClientRegistry({ shell: cfg }, undefined, [], noopHandler, ctx, { ...bridgeEngine, wire: undefined } as EngineConfig, logger);
      try {
        const raw = await registry.listAllTools();
        rawShas.push(sha(raw));
        // exactly what engine/orchestrator.ts hands every provider
        const tools = canonicalizeToolDefinitions(raw);
        const provider = new ClaudeCliProvider(
          { type: 'claudecli', claudePath: FAKE_CLAUDE, model: 'claude-haiku-4-5' },
          { shell: cfg },
          undefined,
          bridgeEngine,
          logger
        );
        await provider.chat({
          messages: [{ role: 'user', content: JSON.stringify({ calls: [] }) } as never],
          tools,
          executeTool: async () => ({ result: 'ok', isError: false }),
        });
        const self = JSON.parse(readFileSync(selfOut, 'utf8')) as { toolListing: Record<string, unknown> };
        expect(Object.keys(self.toolListing)).toEqual(['shell']);
        listings.push(JSON.stringify(self.toolListing));
      } finally {
        await registry.closeAll();
      }
    }

    expect(rawShas[0]).not.toBe(rawShas[1]); // negative control (recorded): the server's own listings differ
    expect(listings[0]).toContain('Allowed commands: ');
    expect(listings[0]).toBe(listings[1]);
  }, 60_000);
});
