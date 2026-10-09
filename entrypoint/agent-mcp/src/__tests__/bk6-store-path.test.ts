/**
 * de046157 BK6 (plan 9ed453c1-b113-473d-8c35-fc6dc2541306) — unambiguous production-vs-dev store.
 *
 * Unit lane (pure, no subprocess; ADR-0009). Real `Environment` instances rooted in a sandbox
 * `adhdRoot` (never `~/.adhd`) and the REAL `loadEnvHierarchy` against real files under
 * `os.tmpdir()`. The launch-from-three-cwds proof against the built server is
 * bk6-store-launch.e2e.test.ts.
 *
 *   AC6.1  resolution order env > cascade > production default; a relative path from the process env is
 *          rejected, a relative path from a config FILE is anchored to that file's directory.
 *   AC6.2  `store=<abs> mode=<production|custom> source=<env|cascade|default>`; mode is derived.
 *   AC6.4  Teeth: each cwd-independence test fails if the cwd is consulted (the old
 *          `path.resolve(db.path)` / cwd-`.env` behaviour).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Environment } from '@adhd/environment';

import { agentMcpEnvironmentSpec, type AgentMcpConfig } from '../config.js';
import { formatStoreLine, resolveStore, StorePathError } from '../config-store-path.js';
import { loadEnvHierarchy } from '../utils/load-env.js';

const KEY = 'ADHD_AGENT_DATABASE_PATH';
const REPO_DEV_VALUE = 'data/agent-mcp/agents-dev.db';

let sandbox: string;
let adhdRoot: string;
let cwd: string;
let home: string;
let saved: NodeJS.ProcessEnv;

const write = (file: string, body: string): void => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
};
const makeEnv = (): Environment<AgentMcpConfig> =>
  new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {
    namespace: 'production',
    scope: 'global',
    adhdRoot,
    cwd,
  });

beforeEach(() => {
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('ADHD_')) delete process.env[k];
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'bk6-')));
  adhdRoot = join(sandbox, 'adhd');
  cwd = join(sandbox, 'cwd');
  home = join(sandbox, 'home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(sandbox, { recursive: true, force: true });
});

describe('de046157 AC6.1/AC6.2 resolveStore', () => {
  it('de046157 AC6.2: nothing configured resolves the production default, mode=production source=default', () => {
    const env = makeEnv();
    const store = resolveStore(env);
    expect(store.path).toBe(resolve(env.files['db'] as string));
    expect(store.path.startsWith(join(adhdRoot, 'agent-mcp', 'production', 'data'))).toBe(true);
    expect(store).toMatchObject({ source: 'default', mode: 'production' });
    expect(formatStoreLine(store)).toBe(`store=${store.path} mode=production source=default`);
  });

  it('de046157 AC6.1: an absolute ADHD_AGENT_DATABASE_PATH wins; outside the production root it is mode=custom source=env', () => {
    const dev = join(sandbox, 'dev', 'agents-dev.db');
    process.env[KEY] = dev;
    const store = resolveStore(makeEnv());
    expect(store).toEqual({ path: dev, source: 'env', mode: 'custom' });
    expect(formatStoreLine(store)).toBe(`store=${dev} mode=custom source=env`);
  });

  it('de046157 AC6.2: mode is derived — an explicit path INSIDE the production root is still production', () => {
    const inside = join(resolve(makeEnv().paths['data'] as string), 'agents.db');
    process.env[KEY] = inside;
    expect(resolveStore(makeEnv())).toMatchObject({ path: inside, source: 'env', mode: 'production' });
  });

  it('de046157 AC6.1: a relative path from the process environment is rejected loudly, naming value and source — never resolved against the cwd', () => {
    process.env[KEY] = REPO_DEV_VALUE;
    let err: Error | undefined;
    try {
      resolveStore(makeEnv());
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(StorePathError);
    expect(err?.message).toContain(JSON.stringify(REPO_DEV_VALUE));
    expect(err?.message).toContain('process environment');
    expect(err?.message).toContain('absolute');
  });

  it('de046157 AC6.1: an empty ADHD_AGENT_DATABASE_PATH is rejected (it would otherwise resolve to the cwd)', () => {
    process.env[KEY] = '';
    expect(() => resolveStore(makeEnv())).toThrow(StorePathError);
  });

  it("de046157 AC6.1: a relative db.path in the global config.yaml is anchored to that file's directory, independent of cwd", () => {
    write(join(adhdRoot, 'agent-mcp', 'production', 'config.yaml'), 'db:\n  path: stores/dev.db\n');
    const expected = join(adhdRoot, 'agent-mcp', 'production', 'stores', 'dev.db');
    expect(resolveStore(makeEnv())).toMatchObject({ path: expected, source: 'cascade', mode: 'production' });
    const prev = process.cwd();
    try {
      process.chdir(sandbox);
      expect(resolveStore(makeEnv()).path).toBe(expected);
    } finally {
      process.chdir(prev);
    }
  });

  it('de046157 AC6.1: the process env beats the cascade file', () => {
    write(join(adhdRoot, 'agent-mcp', 'production', 'config.yaml'), 'db:\n  path: stores/dev.db\n');
    const abs = join(sandbox, 'env-wins.db');
    process.env[KEY] = abs;
    expect(resolveStore(makeEnv())).toMatchObject({ path: abs, source: 'env' });
  });
});

describe('de046157 AC6.1 loadEnvHierarchy: .env discovery never selects the store from the launch directory', () => {
  it('de046157 AC6.1: <cwd>/.env ADHD_AGENT_DATABASE_PATH (the F1 repo-root line) is ignored with a warning naming the file', () => {
    write(join(cwd, '.env'), `${KEY}=${REPO_DEV_VALUE}\nADHD_AGENT_BK6_OTHER=kept\n`);
    const warnings: string[] = [];
    loadEnvHierarchy(cwd, { warn: (m) => warnings.push(m) });
    expect(process.env[KEY]).toBeUndefined();
    expect(process.env.ADHD_AGENT_BK6_OTHER).toBe('kept'); // every other key keeps the cwd layering
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(cwd, '.env'));
    expect(warnings[0]).toContain(KEY);
  });

  it('de046157 AC6.1: <cwd>/.adhd/.env is ignored for the store key too', () => {
    write(join(cwd, '.adhd', '.env'), `${KEY}=/somewhere/else.db\n`);
    const warnings: string[] = [];
    loadEnvHierarchy(cwd, { warn: (m) => warnings.push(m) });
    expect(process.env[KEY]).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('de046157 AC6.1: the same store results from two different cwds (one holding the dev .env, one empty)', () => {
    const other = join(sandbox, 'other');
    mkdirSync(other, { recursive: true });
    write(join(cwd, '.env'), `${KEY}=${REPO_DEV_VALUE}\n`);
    loadEnvHierarchy(cwd, { warn: () => undefined });
    const fromRepo = process.env[KEY];
    delete process.env[KEY];
    loadEnvHierarchy(other, { warn: () => undefined });
    expect(fromRepo).toBe(process.env[KEY]);
    expect(resolveStore(makeEnv())).toMatchObject({ source: 'default', mode: 'production' });
  });

  it('de046157 AC6.1: ~/.adhd/.env may supply the store; a relative value is anchored to ~/.adhd, not the cwd', () => {
    write(join(home, '.adhd', '.env'), `${KEY}=stores/dev.db\n`);
    const expected = join(home, '.adhd', 'stores', 'dev.db');
    loadEnvHierarchy(cwd, { warn: () => undefined });
    expect(process.env[KEY]).toBe(expected);
    const prev = process.cwd();
    try {
      delete process.env[KEY];
      process.chdir(sandbox);
      loadEnvHierarchy(cwd, { warn: () => undefined });
      expect(process.env[KEY]).toBe(expected);
    } finally {
      process.chdir(prev);
    }
  });

  it('de046157 AC6.1: an absolute ~/.adhd/.env store is kept as-is, and the process env still beats it', () => {
    const abs = join(sandbox, 'dev', 'a.db');
    write(join(home, '.adhd', '.env'), `${KEY}=${abs}\n`);
    loadEnvHierarchy(cwd, { warn: () => undefined });
    expect(process.env[KEY]).toBe(abs);
    process.env[KEY] = '/explicit/b.db';
    loadEnvHierarchy(cwd, { warn: () => undefined });
    expect(process.env[KEY]).toBe('/explicit/b.db');
  });

  it('de046157 AC6.1: an explicit process-env value is untouched and silences the ignored-file warning', () => {
    process.env[KEY] = '/explicit/agents.db';
    write(join(cwd, '.env'), `${KEY}=${REPO_DEV_VALUE}\n`);
    const warnings: string[] = [];
    loadEnvHierarchy(cwd, { warn: (m) => warnings.push(m) });
    expect(process.env[KEY]).toBe('/explicit/agents.db');
    expect(warnings).toEqual([]);
  });
});
