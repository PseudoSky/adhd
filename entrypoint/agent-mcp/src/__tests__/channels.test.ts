/**
 * c536ce29 (wire/ops tracing, segment W2) — log-channel creation and the pino -> ops routing.
 *
 *   c536ce29 TRC-AC15  files land ONLY under the environment-resolved roots (api/ ops/ under the
 *                      logs dir) with per-process names; `logging.api=off` writes no api records
 *                      but ops still are (+ a `log.disabled` warn); a canary secret never appears
 *                      in either file (negative control: the identity redactor DOES leak it, so
 *                      the scan has teeth); `server.start` carries `bind_host`
 *   c536ce29 W2-AC-A   pino lines appear in the ops channel file AND still on stderr
 *   c536ce29 W2-AC-B   an unwritable log dir never prevents startup and is reported once on stderr
 *
 * Real: the real `agentMcpEnvironmentSpec` resolved by a real `Environment` over isolated temp
 * dirs, the real vendored sox-telemetry log channel writing real files, the real pino logger.
 * Nothing is spawned.
 */
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Environment } from '@adhd/environment';
import { identityRedactor } from '@adhd/agent-plugin-tracing';

import { agentMcpEnvironmentSpec, resolveLogRoots, type AgentMcpConfig, type LogRoots } from '../config.js';
import { createAgentLogger } from '../logger.js';
import { logServerStart } from '../ops-log.js';
import { closeLogChannels, collectKnownSecrets, createLogChannels, getLogChannels, initLogChannels } from '../wire/channels.js';

const CANARY = 'CANARYsecret-0123456789abcdef';
const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  for (const k of ['ADHD_ENV_SCOPE', 'ADHD_AGENT_LOGGING_DIR', 'ADHD_AGENT_LOGGING_API', 'ADHD_AGENT_LOGGING_INSTANCE_LABEL']) {
    setEnv(k, undefined);
  }
});

afterEach(async () => {
  await closeLogChannels();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const scratch = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

/** A real Environment over an isolated adhd root; returns it with its resolved log roots. */
function realEnv(): { adhdRoot: string; cwd: string; env: Environment<AgentMcpConfig>; roots: LogRoots } {
  const adhdRoot = scratch('trc-w2-root-');
  const cwd = scratch('trc-w2-cwd-');
  const env = new Environment<AgentMcpConfig>('agent-mcp', agentMcpEnvironmentSpec, {
    namespace: 'production',
    adhdRoot,
    cwd,
  });
  return { adhdRoot, cwd, env, roots: resolveLogRoots(env) };
}

/** Every regular file under `dir` (recursive), as absolute paths. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const readJsonl = (file: string): Array<Record<string, unknown>> =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const collector = (): { lines: string[]; write(chunk: string): void; text(): string } => {
  const lines: string[] = [];
  return {
    lines,
    write: (c: string) => {
      lines.push(c);
    },
    text: () => lines.join(''),
  };
};

describe('c536ce29 TRC-AC15 channel files land under the environment-resolved roots', () => {
  it('c536ce29 TRC-AC15 per-process names under api/ and ops/ only; canary never appears; server.start carries bind_host', async () => {
    const { adhdRoot, roots, env } = realEnv();
    const stderr = collector();
    const channels = createLogChannels({ roots, logging: env.config.logging, knownSecrets: [CANARY], stderr });
    expect(channels.apiEnabled).toBe(true);
    expect(channels.opsEnabled).toBe(true);
    expect(channels.failures).toEqual([]);

    // The canary goes through every write path: a structured field, a pino-style line, a raw body
    // + header on the api channel, and a late registerSecret for a value not known at creation.
    const LATE = 'LATEsecret-fedcba9876543210';
    channels.registerSecret(LATE);
    channels.ops.logEvent('probe.field', { note: `value=${CANARY}`, late: LATE });
    channels.ops.destination().write(`{"level":30,"msg":"pino ${CANARY} ${LATE}"}\n`);
    channels.api.logRaw('api.request', {
      headers: { 'x-extra': `Bearer ${CANARY}` },
      body: { body: `{"k":"${CANARY}","l":"${LATE}"}`, body_bytes: 40, body_sha256: 'x', truncated: false },
      call_id: 'c1',
    });
    logServerStart(
      { transport: 'http', bindHost: '127.0.0.1', port: 4242, ssePort: 4343, instance: 'inst-1', version: '9.9.9', apiLog: 'on' },
      channels.ops
    );
    await channels.close();

    const files = filesUnder(adhdRoot);
    expect(files.length).toBeGreaterThanOrEqual(2);
    const apiFiles = files.filter((f) => f.startsWith(roots.api + sep));
    const opsFiles = files.filter((f) => f.startsWith(roots.ops + sep));
    expect(apiFiles).toHaveLength(1);
    expect(opsFiles).toHaveLength(1);
    // Nothing anywhere else under the adhd root (no stray trace/temp/ad-hoc files from the channels).
    expect(files.filter((f) => !apiFiles.includes(f) && !opsFiles.includes(f))).toEqual([]);
    const label = env.config.logging.instanceLabel;
    expect(relative(roots.api, apiFiles[0] as string)).toMatch(
      new RegExp(`^agent-mcp\\.api-\\d{4}-\\d{2}-\\d{2}\\.${label}\\.${process.pid}(\\..*)?\\.jsonl$`)
    );
    expect(relative(roots.ops, opsFiles[0] as string)).toMatch(
      new RegExp(`^agent-mcp\\.ops-\\d{4}-\\d{2}-\\d{2}\\.${label}\\.${process.pid}(\\..*)?\\.jsonl$`)
    );

    const apiText = readFileSync(apiFiles[0] as string, 'utf8');
    const opsText = readFileSync(opsFiles[0] as string, 'utf8');
    for (const text of [apiText, opsText]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(LATE);
    }
    expect(apiText).toContain('"event":"api.request"');
    expect(opsText).toContain('pino');

    const start = readJsonl(opsFiles[0] as string).find((r) => r['event'] === 'server.start');
    expect(start).toBeDefined();
    expect(start).toMatchObject({
      bind_host: '127.0.0.1',
      port: 4242,
      sse_port: 4343,
      transport: 'http',
      instance: 'inst-1',
      version: '9.9.9',
      api_log: 'on',
      pid: process.pid,
    });
  });

  it('c536ce29 TRC-AC15 negative control: the identity redactor leaks the canary, so the scan above has teeth', async () => {
    const { roots, env } = realEnv();
    const channels = createLogChannels({
      roots,
      logging: env.config.logging,
      redactor: identityRedactor,
      stderr: collector(),
    });
    channels.ops.logEvent('probe.field', { note: `value=${CANARY}` });
    await channels.close();
    const [opsFile] = filesUnder(roots.ops);
    expect(readFileSync(opsFile as string, 'utf8')).toContain(CANARY);
  });

  it('c536ce29 TRC-AC15 logging.api=off writes no api records or files but ops still are, with a log.disabled warn', async () => {
    const { adhdRoot, roots, env } = realEnv();
    const channels = createLogChannels({
      roots,
      logging: { ...env.config.logging, api: 'off' },
      knownSecrets: [CANARY],
      stderr: collector(),
    });
    expect(channels.apiEnabled).toBe(false);
    expect(channels.opsEnabled).toBe(true);
    channels.api.logRaw('api.request', { body: { body: 'x', body_bytes: 1, body_sha256: 'x', truncated: false } });
    channels.ops.logEvent('probe.ops', { n: 1 });
    logServerStart(
      { transport: 'stdio', bindHost: null, port: null, instance: 'i', version: '1', apiLog: channels.apiEnabled ? 'on' : 'off' },
      channels.ops
    );
    await channels.close();

    const files = filesUnder(adhdRoot);
    expect(files.filter((f) => f.startsWith(roots.api + sep))).toEqual([]);
    const opsFiles = files.filter((f) => f.startsWith(roots.ops + sep));
    expect(opsFiles).toHaveLength(1);
    const records = readJsonl(opsFiles[0] as string);
    expect(records.find((r) => r['event'] === 'probe.ops')).toBeDefined();
    expect(records.find((r) => r['event'] === 'log.disabled')).toMatchObject({ level: 'warn', config_key: 'logging.api' });
    const start = records.find((r) => r['event'] === 'server.start');
    expect(start).toMatchObject({ api_log: 'off', bind_host: null });
    expect(start).toHaveProperty('bind_host');
  });

  it('c536ce29 TRC-AC15 collectKnownSecrets returns credential VALUES by env-name shape and ignores the rest', () => {
    const got = collectKnownSecrets({
      ADHD_AGENT_OPENAI_SECRET: 'fixture-value-one', // pragma: allowlist secret
      SOME_API_KEY: 'fixture-value-two', // pragma: allowlist secret
      PATH: '/usr/bin',
      HOME: '/home/x',
    });
    expect(got.sort()).toEqual(['fixture-value-one', 'fixture-value-two']);
  });

  it('c536ce29 FIX-L6 collectKnownSecrets does not register GIT_AUTHOR_*/SSH_AUTH_SOCK but still registers AUTH_TOKEN/AUTHORIZATION/OAUTH_TOKEN', () => {
    const got = collectKnownSecrets({
      GIT_AUTHOR_NAME: 'fixture-author-name', // pragma: allowlist secret
      GIT_AUTHOR_EMAIL: 'fixture-author@example.invalid',
      SSH_AUTH_SOCK: '/tmp/fixture-ssh-agent.sock',
      AUTH_TOKEN: 'fixture-auth-token-v', // pragma: allowlist secret
      AUTHORIZATION: 'fixture-authorization-v', // pragma: allowlist secret
      OAUTH_TOKEN: 'fixture-oauth-token-v', // pragma: allowlist secret
      HTTP_AUTH: 'fixture-http-auth-value', // pragma: allowlist secret
    });
    expect(got.sort()).toEqual([
      'fixture-auth-token-v',
      'fixture-authorization-v',
      'fixture-http-auth-value',
      'fixture-oauth-token-v',
    ]);
  });
});

describe('c536ce29 FIX-L7 initLogChannels reports options it discards', () => {
  it('c536ce29 FIX-L7: a second call with different roots returns the first channels and writes a log.init_ignored warn to the ops channel; an identical call stays silent', async () => {
    const { roots, env } = realEnv();
    const first = initLogChannels({ roots, logging: env.config.logging, stderr: collector() });
    expect(first.opsEnabled).toBe(true);

    const same = initLogChannels({ roots, logging: env.config.logging, stderr: collector() });
    expect(same).toBe(first);

    const other = realEnv();
    const second = initLogChannels({ roots: other.roots, logging: other.env.config.logging, stderr: collector() });
    expect(second).toBe(first);
    await first.flush();

    const opsFiles = filesUnder(roots.ops).filter((f) => f.endsWith('.jsonl'));
    const records = opsFiles.flatMap(readJsonl);
    const ignored = records.filter((r) => r['event'] === 'log.init_ignored');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ level: 'warn', ignored_options: ['roots'] });
    // The ignored roots were never created.
    expect(filesUnder(other.roots.ops)).toEqual([]);
  });
});

describe('c536ce29 W2-AC-A pino lines reach the ops channel AND stderr', () => {
  it('c536ce29 W2-AC-A a logger line is on stderr and in the ops file; lines before the late attach and after detach are stderr-only', async () => {
    const { roots, env } = realEnv();
    const stderr = collector();
    const channels = createLogChannels({ roots, logging: env.config.logging, stderr: collector() });
    const { logger, attachOpsDestination } = createAgentLogger({ stderr, level: 'debug', instance: 'inst-w2a' });

    logger.info('before-attach'); // logger works before any channel exists
    attachOpsDestination(channels.ops.destination());
    logger.info({ k: 'v' }, 'after-attach');
    logger.debug('debug-line'); // level semantics unchanged: debug reaches both when level=debug
    attachOpsDestination(undefined);
    logger.info('after-detach');
    await channels.close();

    const err = stderr.text();
    for (const m of ['before-attach', 'after-attach', 'debug-line', 'after-detach']) expect(err).toContain(m);
    expect(err).toContain('"service":"agent-mcp"');
    expect(err).toContain('"instance":"inst-w2a"');

    const [opsFile] = filesUnder(roots.ops);
    const opsText = readFileSync(opsFile as string, 'utf8');
    expect(opsText).toContain('after-attach');
    expect(opsText).toContain('debug-line');
    expect(opsText).not.toContain('before-attach');
    expect(opsText).not.toContain('after-detach');
    const line = opsText
      .split('\n')
      .filter((l) => l.includes('after-attach'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)[0];
    expect(line).toMatchObject({ msg: 'after-attach', k: 'v', service: 'agent-mcp', instance: 'inst-w2a', pid: process.pid });
  });

  it('c536ce29 W2-AC-A the logger honours level=info (debug dropped) and never throws when the destination throws or level is silent', () => {
    const stderr = collector();
    const { logger, attachOpsDestination } = createAgentLogger({ stderr, level: 'info' });
    attachOpsDestination({
      write: () => {
        throw new Error('boom');
      },
    });
    expect(() => logger.info('kept')).not.toThrow();
    logger.debug('dropped');
    expect(stderr.text()).toContain('kept');
    expect(stderr.text()).not.toContain('dropped');
    expect(() => createAgentLogger({ stderr: collector(), level: 'silent' }).logger.info('x')).not.toThrow();
  });
});

describe('c536ce29 W2-AC-B a bad log directory never prevents startup', () => {
  it('c536ce29 W2-AC-B an unwritable ops/api dir degrades to inert channels, is reported once per channel on stderr, and never throws', async () => {
    const { adhdRoot, roots, env } = realEnv();
    // A REGULAR FILE where the logs root should be: every create under it fails (ENOTDIR), as root too.
    const blocker = join(adhdRoot, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const bad: LogRoots = { ...roots, root: blocker, api: join(blocker, 'api'), ops: join(blocker, 'ops') };
    const stderr = collector();

    let channels!: ReturnType<typeof createLogChannels>;
    expect(() => {
      channels = createLogChannels({ roots: bad, logging: env.config.logging, stderr });
    }).not.toThrow();
    expect(channels.opsEnabled).toBe(false);
    expect(channels.apiEnabled).toBe(false);
    expect(channels.failures).toHaveLength(2);

    // Inert channels accept every call, then nothing is written anywhere.
    channels.ops.logEvent('after.failure', { n: 1 });
    channels.api.logRaw('api.request', {});
    channels.ops.destination().write('{"msg":"x"}\n');
    await channels.close();

    const opsNotices = stderr.lines.filter((l) => l.includes("'agent-mcp.ops'"));
    expect(opsNotices).toHaveLength(1);
    expect(opsNotices[0]).toContain('[agent-mcp] log channel');
    expect(stderr.lines.filter((l) => l.includes("'agent-mcp.api'"))).toHaveLength(1);
    expect(filesUnder(adhdRoot).filter((f) => f.endsWith('.jsonl'))).toEqual([]);
  });

  it('c536ce29 W2-AC-B initLogChannels with a bad dir returns inert channels, leaves the logger working, and getLogChannels stays callable', async () => {
    const { adhdRoot, roots, env } = realEnv();
    const blocker = join(adhdRoot, 'blocker2');
    writeFileSync(blocker, 'x');
    const bad: LogRoots = { ...roots, root: blocker, api: join(blocker, 'api'), ops: join(blocker, 'ops') };
    const stderr = collector();

    const channels = initLogChannels({ roots: bad, logging: env.config.logging, stderr });
    expect(channels.opsEnabled).toBe(false);
    expect(getLogChannels()).toBe(channels);
    const { logger } = createAgentLogger({ stderr: collector(), level: 'info' });
    expect(() => logger.info('still works')).not.toThrow();
    expect(() => getLogChannels().ops.logEvent('x')).not.toThrow();
    expect(stderr.lines.filter((l) => l.includes("'agent-mcp.ops'"))).toHaveLength(1);
  });
});
