/**
 * c536ce29 / 03be90c3 S8B-AC2 (agent-mcp-tail DB path, srt run-policy dir). S8B-AC1 lives in stray-writers.test.ts.
 *
 * Isolated `Environment` instances rooted in an os.tmpdir() sandbox that teardown removes (the
 * same construction log-paths.test.ts uses); no process is spawned and `process.env` is not
 * mutated. Because the sandbox itself sits under os.tmpdir(), "not under tmpdir" proves nothing —
 * assertions are that the paths are INSIDE the resolved namespaced roots.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Environment } from '@adhd/environment';

import { agentMcpEnvironmentSpec, resolveLogRoots, type AgentMcpConfig } from '../config.js';
import { resolveTailDbPath } from '../scripts/tail-db-path.js';
import {
  provisionRunSrtPolicy,
  removeRunSrtPolicy,
  resolveSrtRunSettingsPath,
  srtPolicyLockPath,
  srtRunPolicyDir,
  SRT_SETTINGS_ENV,
} from '../srt-policy.js';

const under = (child: string, parent: string): boolean => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

let sandbox: string;
let adhdRoot: string;
let cwd: string;
// Hermeticity: the Environment cascade reads live `process.env`, and agent-mcp's config loader
// populates it from the checkout's `.env` hierarchy (which can pin a relative
// ADHD_AGENT_DATABASE_PATH). These tests assert the sandbox-rooted default, so every ADHD_* var is
// removed for the test and restored verbatim afterwards.
let savedAdhdEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedAdhdEnv = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('ADHD_')) {
      savedAdhdEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 's8b-')));
  adhdRoot = join(sandbox, 'adhd');
  cwd = join(sandbox, 'cwd');
  mkdirSync(join(cwd, '.git'), { recursive: true });
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedAdhdEnv)) process.env[k] = v;
  removeRunSrtPolicy();
  rmSync(sandbox, { recursive: true, force: true });
});

function makeEnv() {
  return new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {
    namespace: 'production',
    adhdRoot,
    cwd,
  });
}

describe('c536ce29 S8B-AC2 agent-mcp-tail resolves the production store through the environment', () => {
  it('c536ce29 S8B-AC2: tail DB path is the environment-resolved store under the sandbox ADHD root, never cwd/data or a raw home path', () => {
    const env = makeEnv();
    const p = resolveTailDbPath(env);
    // resolveTailDbPath returns the ABSOLUTE path (path.resolve) of the configured store.
    expect(p).toBe(resolve(env.config.db.path ?? env.files['db']));
    expect(p).toBe(resolve(env.files['db']));
    expect(under(p, adhdRoot)).toBe(true);
    expect(under(p, join(cwd, 'data'))).toBe(false);
  });

  it('c536ce29 S8B-AC2: an explicit db.path (ADHD_AGENT_DATABASE_PATH) still wins', () => {
    const env = makeEnv();
    const pinned = join(sandbox, 'pinned.db');
    const p = resolveTailDbPath({
      config: { ...env.config, db: { ...env.config.db, path: pinned } },
      files: env.files,
      paths: env.paths,
      provenance: { ...env.provenance, 'db.path': { source: 'env', scope: 'global', env: 'ADHD_AGENT_DATABASE_PATH' } },
    });
    expect(p).toBe(pinned);
  });

  it('de046157 AC6.1: a relative db.path from the process environment is rejected, never resolved against the process cwd', () => {
    const env = makeEnv();
    const rel = join('data', 'agent-mcp', 'agents-dev.db');
    expect(() =>
      resolveTailDbPath({
        config: { ...env.config, db: { ...env.config.db, path: rel } },
        files: env.files,
        paths: env.paths,
        provenance: { ...env.provenance, 'db.path': { source: 'env', scope: 'global', env: 'ADHD_AGENT_DATABASE_PATH' } },
      })
    ).toThrow(/absolute/);
  });
});

describe('c536ce29 S8B-AC2 srt run-policy lives under the namespaced temp root', () => {
  it('c536ce29 S8B-AC2: the run policy dir and per-pid file are inside roots.temp', () => {
    const roots = resolveLogRoots(makeEnv());
    expect(under(roots.temp, adhdRoot)).toBe(true);
    expect(srtRunPolicyDir(roots)).toBe(join(roots.temp, 'srt'));
    const file = resolveSrtRunSettingsPath({} as NodeJS.ProcessEnv, roots);
    expect(file).toBe(join(roots.temp, 'srt', `run-${process.pid}.json`));
  });

  it('c536ce29 S8B-AC2: provisioning actually writes the policy (and its lock path) into the temp root; the env override still wins', () => {
    const roots = resolveLogRoots(makeEnv());
    const env = {} as NodeJS.ProcessEnv;
    provisionRunSrtPolicy(cwd, env, roots);
    const file = resolveSrtRunSettingsPath(env, roots);
    expect(existsSync(file)).toBe(true);
    expect(under(file, roots.temp)).toBe(true);
    expect(under(srtPolicyLockPath(file), roots.temp)).toBe(true);
    expect(resolveSrtRunSettingsPath({ [SRT_SETTINGS_ENV]: '/custom/srt.json' } as NodeJS.ProcessEnv, roots)).toBe('/custom/srt.json');
  });
});
