/**
 * 61358b6f AC9 / host wiring — the exit-status sentinel is produced by
 * `@adhd/agent-core-native-tooling` (the launcher) and parsed by
 * `@adhd/agent-engine-orchestrator` (the engine), two packages that cannot import
 * each other. agent-mcp depends on both, so the pin lives here: both expressions
 * accept and reject the same corpus, and the producer's text parses.
 */
import { mkdtempSync, readdirSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LAUNCHER_SOURCE,
  SHELL_EXIT_SENTINEL_RE as PRODUCER_RE,
  formatExitSentinel,
  resolveNativeToolingMap,
} from '@adhd/agent-core-native-tooling';
import {
  SHELL_EXIT_SENTINEL_RE as ENGINE_RE,
  parseShellExitStatus,
} from '@adhd/agent-engine-orchestrator';
import { buildNativeToolingContext, withDefaultMcpServers } from '../defaults.js';
import { provisionSrtPolicy } from '../srt-policy.js';

const ACCEPT = ['[exit status: 1]', '[exit status: 0]', '[exit status: 255]', 'err\n[exit status: 2]', 'err\n[exit status: 2]\n', '[exit status: 143]\n\n'];
const REJECT = ['', 'hi', '[exit status: -1]', '[exit status: ]', '[exit status: 1000]', 'x [exit status: 1]', '[exit status: 1] x', '[exit status:1]', '[Exit Status: 1]', '[exit status: 1]\nmore'];

describe('61358b6f AC9 sentinel contract (producer vs engine)', () => {
  it('the two expressions are the same expression', () => {
    expect(PRODUCER_RE.source).toBe(ENGINE_RE.source);
    expect(PRODUCER_RE.flags).toBe(ENGINE_RE.flags);
  });

  it('both accept and reject the same corpus', () => {
    for (const s of ACCEPT) {
      expect(PRODUCER_RE.test(s), `producer accepts ${JSON.stringify(s)}`).toBe(true);
      expect(ENGINE_RE.test(s), `engine accepts ${JSON.stringify(s)}`).toBe(true);
    }
    for (const s of REJECT) {
      expect(PRODUCER_RE.test(s), `producer rejects ${JSON.stringify(s)}`).toBe(false);
      expect(ENGINE_RE.test(s), `engine rejects ${JSON.stringify(s)}`).toBe(false);
    }
  });

  it('the text the producer emits (formatExitSentinel and the launcher printf) is parsed by the engine', () => {
    for (const n of [1, 2, 127, 143]) {
      expect(parseShellExitStatus('shell_execute', [{ type: 'text', text: `${formatExitSentinel(n)}\n` }])).toBe(n);
    }
    // The launcher's own format string is the sentinel format.
    expect(LAUNCHER_SOURCE).toContain("printf '[exit status: %s]\\n'");
  });
});

describe('61358b6f host wiring (buildNativeToolingContext -> resolved shell server)', () => {
  const roots: string[] = [];
  const root = () => {
    const r = mkdtempSync(join(tmpdir(), 'agent-mcp-exitshim-'));
    roots.push(r);
    return r;
  };
  afterAll(() => {
    for (const r of roots) {
      for (const e of readdirSync(r)) chmodSync(join(r, e), 0o755);
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('builds the shim from the host PATH and the resolved shell server leads with it', () => {
    const exitShimRoot = root();
    const ctx = buildNativeToolingContext({ cwd: '/P', sandbox: false, exitShimRoot, dispatchSelf: { transport: 'stdio', command: 'x' } });
    expect(ctx.exitShim?.dir.startsWith(exitShimRoot)).toBe(true);
    expect(ctx.exitShim?.origPath).toBe(ctx.env?.['PATH']);
    const def = withDefaultMcpServers({ nativeTooling: { fs: false, dispatch: false } } as never, ctx);
    const shell = def.mcpServers['shell'] as { env?: Record<string, string> };
    expect(shell.env?.['PATH']?.split(delimiter)[0]).toBe(ctx.exitShim?.dir);
    expect(shell.env?.['ADHD_SHIM_ORIG_PATH']).toBe(ctx.exitShim?.origPath);
    // Same map the resolver gives for this ctx, so host and resolver cannot diverge.
    expect(resolveNativeToolingMap({ fs: false, dispatch: false }, { cwd: '/P', sandbox: false, exitShim: ctx.exitShim, env: ctx.env })['shell']).toBeDefined();
  });

  it('exitShimRoot:false builds no shim and the shell server carries no PATH override', () => {
    const ctx = buildNativeToolingContext({ cwd: '/P', sandbox: false, exitShimRoot: false, dispatchSelf: { transport: 'stdio', command: 'x' } });
    expect(ctx.exitShim).toBeUndefined();
    const def = withDefaultMcpServers({ nativeTooling: { fs: false, dispatch: false } } as never, ctx);
    const shell = def.mcpServers['shell'] as { env?: Record<string, string> };
    expect(shell.env?.['ADHD_SHIM_ORIG_PATH']).toBeUndefined();
  });
});

describe('61358b6f srt policy: the shim dir is readable but never writable', () => {
  it('denyWrite and allowRead survive a later provision that does not name them (additive, not host-managed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mcp-exitshim-policy-'));
    try {
      const settingsPath = join(dir, 'run.json');
      const shim = join(dir, 'exit-shim', 'abc');
      provisionSrtPolicy({ settingsPath, allowWrite: [tmpdir()], allowRead: [shim], denyWrite: [shim], applySandboxExtras: true });
      // A later per-task provision (addRunSrtAllowWrite) does not repeat the shim dir.
      provisionSrtPolicy({ settingsPath, allowWrite: ['/some/other/root'], applySandboxExtras: true });
      const fsPolicy = JSON.parse(readFileSync(settingsPath, 'utf8')).filesystem;
      expect(fsPolicy.denyWrite).toContain(shim);
      expect(fsPolicy.allowRead).toContain(shim);
      expect(fsPolicy.allowWrite).not.toContain(shim);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
