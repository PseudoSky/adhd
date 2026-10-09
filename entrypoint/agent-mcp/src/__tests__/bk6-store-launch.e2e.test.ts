/**
 * de046157 BK6 AC6.3 (plan 9ed453c1-b113-473d-8c35-fc6dc2541306) — e2e lane (ADR-0009).
 *
 * Drives the REAL built agent-mcp entry (dist/src/index.js) as a host does — a real MCP client over
 * stdio JSON-RPC — from three different launch directories, with an isolated fake HOME (the real
 * `~/.adhd` production store is never touched) and no store override:
 *
 *   - "repo root": a directory holding a `.env` with the F1 line
 *     `ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db`
 *   - a neutral empty directory
 *   - a directory nested several levels below the repo root
 *
 * Assertions (consumer-visible, no mocks): the server logs the IDENTICAL absolute `store=<abs>
 * mode=production source=default` line, serves the IDENTICAL `agent_list` rows (seeded into the
 * production store of the fake HOME), and never creates the cwd-relative dev DB. An explicit absolute
 * ADHD_AGENT_DATABASE_PATH reports `mode=custom source=env`; a relative one fails the launch loudly.
 *
 * Teeth (AC6.4, run during development against the pre-change build): the repo-root launch logged no
 * `store=` line, opened `<cwd>/data/agent-mcp/agents-dev.db` and listed 0 agents, so the identical-path
 * and identical-roster assertions are red on the old anchor logic.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyLockingPragmas } from '@adhd/agent-core-env';
import { agentCreateInputSchema } from '@adhd/agent-engine-orchestrator';

import { runMigrationsOn } from '../db/migrate-runner.js';
import { AgentStore } from '../store/agent-store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'src', 'index.js');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'agent-mcp');
const SEEDED = ['bk6-alpha', 'bk6-beta', 'bk6-gamma'];

let tmpDir: string;
let fakeHome: string;
let fakeRepo: string;
let neutral: string;
let nested: string;
let productionStore: string;

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ADHD_') || value === undefined) continue;
    env[key] = value;
  }
  env.HOME = fakeHome;
  env.ADHD_AGENT_TRANSPORT = 'stdio';
  env.ADHD_AGENT_SSE_ENABLED = 'false';
  env.ADHD_AGENT_SKIP_LEGACY_MIGRATION = 'true';
  return { ...env, ...extra };
}

function seed(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  applyLockingPragmas(sqlite, { busyTimeoutMs: 5_000 });
  const db = drizzle(sqlite);
  runMigrationsOn(sqlite, db);
  const store = new AgentStore(db);
  for (const name of SEEDED) {
    store.create(agentCreateInputSchema.parse({ name, provider: { type: 'claudecli' }, systemPrompt: `${name} prompt` }));
  }
  sqlite.close();
}

interface ILaunch {
  stderr: string;
  names: string[];
}

/** Launches the built server from `cwd`, lists agents like a host, returns stderr + roster. */
async function launch(cwd: string, extra: Record<string, string> = {}): Promise<ILaunch> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    env: childEnv(extra),
    cwd,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const client = new Client({ name: 'bk6-store-e2e', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'agent_list', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '[]';
    const names = (JSON.parse(text) as Array<{ name: string }>).map((a) => a.name).sort();
    return { stderr, names };
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe('de046157 AC6.3 built server resolves the same store from any launch directory', () => {
  beforeAll(() => {
    expect(fs.existsSync(DIST_ENTRY), `expected built entry at ${DIST_ENTRY} — run "npx nx build agent-mcp" first`).toBe(true);
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'bk6-store-')));
    fakeHome = path.join(tmpDir, 'home');
    fakeRepo = path.join(tmpDir, 'repo');
    neutral = path.join(tmpDir, 'neutral');
    nested = path.join(fakeRepo, 'packages', 'deep', 'nested');
    for (const d of [fakeHome, fakeRepo, neutral, nested]) fs.mkdirSync(d, { recursive: true });
    // The F1 trigger: the repo root's .env pins a RELATIVE dev DB.
    fs.writeFileSync(path.join(fakeRepo, '.env'), 'ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db\n');
    productionStore = path.join(fakeHome, '.adhd', 'agent-mcp', 'production', 'data', 'agents.db');
    seed(productionStore);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('de046157 AC6.3: repo root, neutral dir and nested dir log the identical absolute store line and serve the identical roster', async () => {
    const line = `store=${productionStore} mode=production source=default`;
    const results = [await launch(fakeRepo), await launch(neutral), await launch(nested)];
    for (const r of results) {
      expect(r.stderr).toContain(line);
      expect(r.names).toEqual([...SEEDED].sort());
    }
    // The cwd-relative dev DB must never have been created or opened.
    expect(fs.existsSync(path.join(fakeRepo, 'data', 'agent-mcp', 'agents-dev.db'))).toBe(false);
    expect(fs.existsSync(path.join(nested, 'data'))).toBe(false);
    // The launch-directory .env assignment was reported, not silently dropped.
    expect(results[0]?.stderr).toContain('ignoring ADHD_AGENT_DATABASE_PATH');
  }, 120_000);

  it('de046157 AC6.2: an explicit absolute ADHD_AGENT_DATABASE_PATH selects that store and logs mode=custom source=env', async () => {
    const dev = path.join(tmpDir, 'dev', 'agents-dev.db');
    seed(dev);
    const r = await launch(fakeRepo, { ADHD_AGENT_DATABASE_PATH: dev });
    expect(r.stderr).toContain(`store=${dev} mode=custom source=env`);
    expect(r.names).toEqual([...SEEDED].sort());
  }, 60_000);

  it('de046157 AC6.1: a relative ADHD_AGENT_DATABASE_PATH in the process environment fails the launch loudly (never cwd-resolved)', () => {
    const out = spawnSync(process.execPath, [DIST_ENTRY], {
      cwd: fakeRepo,
      env: childEnv({ ADHD_AGENT_DATABASE_PATH: 'data/agent-mcp/agents-dev.db' }),
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain('must be an absolute path');
    expect(out.stderr).toContain('data/agent-mcp/agents-dev.db');
    expect(fs.existsSync(path.join(fakeRepo, 'data'))).toBe(false);
  }, 60_000);
});
