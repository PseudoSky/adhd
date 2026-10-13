// bin: sources — parsing, command naming and resolution (T08 / D-07 / D-20, REVIEW-FIXES G2 G11).
//
// Driven through the package root exactly as a consumer imports it. No process is started:
// every launcher here is the recording fake, and "nothing ran" is `started.length === 0`.

import { describe, it, expect } from 'vitest';
import {
  SourceError,
  buildArgvOperation,
  parseSourceSpec,
  resolveSource,
  type IResolvedSource,
} from '../index';
import { createFakeLauncher } from './helpers/fake-launcher';
import { createStubMcpUpstream } from './helpers/stub-mcp-upstream';

function sourceErrorOf(fn: () => unknown): SourceError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SourceError);
    return e as SourceError;
  }
  throw new Error('expected a SourceError');
}

async function rejectionOf(p: Promise<unknown>): Promise<SourceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SourceError);
    return e as SourceError;
  }
  throw new Error('expected a SourceError rejection');
}

describe('Feature: a source argument is parsed without touching anything', () => {
  it('@parse bin: carries the command verbatim', () => {
    expect(parseSourceSpec('bin:touch')).toEqual({ kind: 'bin', command: 'touch' });
    expect(parseSourceSpec('bin:/usr/local/bin/mcp-server')).toEqual({
      kind: 'bin',
      command: '/usr/local/bin/mcp-server',
    });
  });

  it('@parse negative: bin: with no command, or a command line, is invalid-spec (a name, never a shell line)', () => {
    expect(sourceErrorOf(() => parseSourceSpec('bin:')).code).toBe('invalid-spec');
    expect(sourceErrorOf(() => parseSourceSpec('bin:sh -c "rm -rf x"')).code).toBe('invalid-spec');
    expect(sourceErrorOf(() => parseSourceSpec('bin:node\tstub.js')).code).toBe('invalid-spec');
  });

  it('@parse remote: accepts http and https only', () => {
    expect(parseSourceSpec('remote:https://example.test/mcp')).toEqual({
      kind: 'remote',
      url: 'https://example.test/mcp',
    });
    expect(parseSourceSpec('remote:http://localhost:3000')).toMatchObject({ kind: 'remote' });
    expect(sourceErrorOf(() => parseSourceSpec('remote:ftp://example.test')).code).toBe('invalid-spec');
    expect(sourceErrorOf(() => parseSourceSpec('remote:not a url')).code).toBe('invalid-spec');
  });

  it('@parse anything else is a file; empty is invalid', () => {
    expect(parseSourceSpec('./api.ts')).toEqual({ kind: 'file', path: './api.ts' });
    expect(sourceErrorOf(() => parseSourceSpec('')).code).toBe('invalid-spec');
  });
});

describe('Feature: the operation id comes from the command name (G11)', () => {
  const idOf = (command: string): string => buildArgvOperation(command).operation.id;

  it('@name strips directories and only known executable extensions', () => {
    expect(idOf('touch')).toBe('touch');
    expect(idOf('/usr/bin/touch')).toBe('touch');
    expect(idOf('C:\\tools\\git.exe')).toBe('git');
    expect(idOf('run.cmd')).toBe('run');
    expect(idOf('run.bat')).toBe('run');
    expect(idOf('server.js')).toBe('server');
    expect(idOf('server.mjs')).toBe('server');
    expect(idOf('server.cjs')).toBe('server');
    expect(idOf('tool.py')).toBe('tool');
  });

  it('@name versioned names stay whole (python3.11 is not python3)', () => {
    expect(idOf('python3.11')).toBe('python3.11');
    expect(idOf('/usr/bin/node20.5')).toBe('node20.5');
    expect(idOf('archive.tar')).toBe('archive.tar');
  });
});

describe('Feature: resolveSource turns a source into the pair a host consumes', () => {
  it('@S3 run: bin: resolves lazily to ONE argv operation and starts nothing (SRC-05 / PS-28)', async () => {
    const launcher = createFakeLauncher();
    const resolved = await resolveSource({ kind: 'bin', command: '/usr/bin/touch' }, 'run', {
      launcher,
      cwd: '/work',
    });
    expect(launcher.started).toHaveLength(0);
    expect(resolved.sourceId).toBe('bin:touch');
    expect(resolved.operations).toHaveLength(1);
    expect(resolved.operations[0]?.id).toBe('touch');
    expect(resolved.pkg.id).toBe('touch');
    expect(Object.keys(resolved.pkg.fns)).toEqual(['touch']);
    await resolved.dispose();
    expect(launcher.started).toHaveLength(0);
  });

  it('@S7 serve: bin: starts the process now (explicit start) and exposes the upstream tools', async () => {
    const stub = createStubMcpUpstream({ tools: [{ name: 'read_file' }] });
    const resolved: IResolvedSource = await resolveSource({ kind: 'bin', command: 'node' }, 'serve', {
      launcher: stub.launcher,
      cwd: '/work',
      args: ['stub.js', '--flag'],
      env: { EXTRA: '1' },
    });
    expect(stub.started).toEqual([{ command: 'node', args: ['stub.js', '--flag'], cwd: '/work', env: { EXTRA: '1' } }]);
    expect(resolved.operations.map((o) => o.id)).toEqual(['node.read_file']);
    expect(resolved.mcp?.tools.has('read_file')).toBe(true);
    await resolved.dispose();
  });

  it('@unsupported remote and file sources are typed errors, not silent fallbacks', async () => {
    const launcher = createFakeLauncher();
    const remote = await rejectionOf(
      resolveSource({ kind: 'remote', url: 'https://example.test/mcp' }, 'serve', { launcher, cwd: '/w' })
    );
    expect(remote.code).toBe('unsupported');
    const file = await rejectionOf(resolveSource({ kind: 'file', path: './api.ts' }, 'run', { launcher, cwd: '/w' }));
    expect(file.code).toBe('unsupported');
    expect(launcher.started).toHaveLength(0);
  });
});
