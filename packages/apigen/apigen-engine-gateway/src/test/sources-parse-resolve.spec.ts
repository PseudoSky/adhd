// guards: a source argument is mis-parsed or mis-named, resolveSource picks the wrong translator or starts a process before the policy has decided, a source failure surfaces as anything but a typed ApiError, or the node probe misclassifies a path
// tier: S
// cites: policy-core REMEDIATION-PLAN T-R7 AC1 (R7a), T08 and D-07 and D-20, REVIEW-FIXES G2 G11
// teeth: red: npx vitest run src/test/sources-parse-resolve.spec.ts -> exit 1; parse-source.ts bin: error code invalid_argument->internal fails "bin: with no command ... is ApiError invalid_argument" and "a source failure maps to the CLI exit code 2"
// skip-expiry: 05f910a0 until 2027-03-31 the three node-probe exec-bit tests are POSIX-only; Windows exec-bit probing is not implemented

// bin: sources — parsing, command naming, classification and resolution (T08 / D-07 / D-20,
// REVIEW-FIXES G2 G11, R7a). Driven through the package root exactly as a consumer imports it.
// No process is started: every launcher here is the recording fake, and "nothing ran" is
// `started.length === 0`.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, CLI_EXIT_CODE, isApiError } from '@adhd/apigen-base-errors';
import { resolveSourceReference } from '@adhd/apigen-core-client';
import type { ISourceProbe, ISourceResolution } from '@adhd/apigen-core-client';
import {
  buildArgvOperation,
  nodeSourceProbe,
  parseSourceSpec,
  resolveSource,
  type IResolveDeps,
} from '../index';
import { createFakeLauncher } from './helpers/fake-launcher';

/** Probe that knows nothing: `bin:` references need none. */
const NO_PROBE: ISourceProbe = { isFile: () => false, isExecutable: () => false, onPath: () => false };

function apiErrorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    expect(isApiError(e)).toBe(true);
    return e as ApiError;
  }
  throw new Error('expected an ApiError');
}

async function rejectionOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(isApiError(e)).toBe(true);
    return e as ApiError;
  }
  throw new Error('expected an ApiError rejection');
}

function classify(reference: string, probe: ISourceProbe = NO_PROBE): ISourceResolution {
  const result = resolveSourceReference(reference, probe);
  if (!result.ok) throw new Error(`unexpected classification failure: ${result.error.message}`);
  return result.value;
}

describe('Feature: a source argument is parsed without touching anything', () => {
  it('@parse bin: carries the command verbatim', () => {
    expect(parseSourceSpec('bin:touch')).toEqual({ kind: 'bin', command: 'touch' });
    expect(parseSourceSpec('bin:/usr/local/bin/mcp-server')).toEqual({
      kind: 'bin',
      command: '/usr/local/bin/mcp-server',
    });
  });

  it('@parse negative: bin: with no command, or a command line, is ApiError invalid_argument (a name, never a shell line)', () => {
    for (const text of ['bin:', 'bin:sh -c "rm -rf x"', 'bin:node\tstub.js']) {
      expect(apiErrorOf(() => parseSourceSpec(text)).code, text).toBe('invalid_argument');
    }
  });

  it('@parse remote: accepts http and https only; other schemes and non-URLs are invalid_argument', () => {
    expect(parseSourceSpec('remote:https://example.test/mcp')).toEqual({
      kind: 'remote',
      url: 'https://example.test/mcp',
    });
    expect(parseSourceSpec('remote:http://localhost:3000')).toMatchObject({ kind: 'remote' });
    expect(apiErrorOf(() => parseSourceSpec('remote:ftp://example.test')).code).toBe('invalid_argument');
    expect(apiErrorOf(() => parseSourceSpec('remote:not a url')).code).toBe('invalid_argument');
  });

  it('@parse anything else is a file; empty is invalid_argument', () => {
    expect(parseSourceSpec('./api.ts')).toEqual({ kind: 'file', path: './api.ts' });
    expect(apiErrorOf(() => parseSourceSpec('')).code).toBe('invalid_argument');
  });

  it('@parse a source failure maps to the CLI exit code 2 (the marshal reads CLI_EXIT_CODE[code])', () => {
    const err = apiErrorOf(() => parseSourceSpec('bin:'));
    expect(CLI_EXIT_CODE[err.code]).toBe(2);
  });
});

describe('Feature: the operation id comes from the command name through the core id rendering (G11, BA-5)', () => {
  const idOf = (command: string): string => buildArgvOperation(command).operation.id;

  it('@name the id is bin/<base>: directories and only known executable extensions are stripped', () => {
    expect(idOf('touch')).toBe('bin/touch');
    expect(idOf('/usr/bin/touch')).toBe('bin/touch');
    expect(idOf('C:\\tools\\git.exe')).toBe('bin/git');
    expect(idOf('run.cmd')).toBe('bin/run');
    expect(idOf('run.bat')).toBe('bin/run');
    expect(idOf('server.js')).toBe('bin/server');
    expect(idOf('server.mjs')).toBe('bin/server');
    expect(idOf('server.cjs')).toBe('bin/server');
    expect(idOf('tool.py')).toBe('bin/tool');
  });

  it('@name versioned names stay whole (python3.11 is not python3)', () => {
    expect(idOf('python3.11')).toBe('bin/python3.11');
    expect(idOf('/usr/bin/node20.5')).toBe('bin/node20.5');
    expect(idOf('archive.tar')).toBe('bin/archive.tar');
  });

  it('@name the id uses the "/" separator, never the retired "." (BA-5)', () => {
    expect(idOf('touch')).not.toContain('.');
    expect(buildArgvOperation('touch').operation.namespace.raw).toBe('bin');
  });
});

describe('Feature: resolveSource turns a classified executable into the pair a host consumes', () => {
  const run = (reference: string, deps: Partial<IResolveDeps> = {}) =>
    resolveSource(classify(reference), { intent: 'run', ...deps });

  it('@S3 run: bin: resolves lazily to ONE argv operation and starts nothing (SRC-05 / PS-28)', async () => {
    const launcher = createFakeLauncher();
    const resolved = await run('bin:/usr/bin/touch', { launcher });
    expect(launcher.started).toHaveLength(0);
    expect(resolved.sourceId).toBe('bin:touch');
    expect(resolved.operations).toHaveLength(1);
    expect(resolved.operations[0]).toMatchObject({ id: 'bin/touch', host: 'argv', binding: 'bin:touch', safe: false });
    expect(resolved.pkg.id).toBe('touch');
    expect(Object.keys(resolved.pkg.fns)).toEqual(['touch']);
    await resolved.dispose();
    expect(launcher.started).toHaveLength(0);
  });

  it('@translator an explicit argv translator is honoured with no intent at all', async () => {
    const launcher = createFakeLauncher();
    const resolution: ISourceResolution = { ...classify('bin:touch'), translator: 'argv' };
    const resolved = await resolveSource(resolution, { launcher });
    expect(resolved.operations[0]?.id).toBe('bin/touch');
    expect(launcher.started).toHaveLength(0);
  });

  it('@translator intent only fills an UNSET translator: a named translator wins over the verb', async () => {
    const launcher = createFakeLauncher();
    const resolution: ISourceResolution = { ...classify('bin:touch'), translator: 'argv' };
    const resolved = await resolveSource(resolution, { launcher, intent: 'serve' });
    expect(resolved.operations[0]?.host).toBe('argv');
  });

  it('@translator an unset translator with intent serve selects mcp, which is IR plus a binding, not a resolved source', async () => {
    const launcher = createFakeLauncher();
    const err = await rejectionOf(resolveSource(classify('bin:node'), { launcher, intent: 'serve' }));
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toContain('IR plus a binding');
    expect(err.message).toContain('bin:node');
    expect(launcher.started).toHaveLength(0);
  });

  it('@translator an unset translator with no intent names both choices', async () => {
    const err = await rejectionOf(resolveSource(classify('bin:node'), {}));
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toContain('needs a translator');
    expect(err.message).toContain('"bin:node"');
  });

  it('@unsupported a code source is invalid_argument pointing at adhd-apigen, exit code 2, and starts nothing', async () => {
    const launcher = createFakeLauncher();
    const err = await rejectionOf(resolveSource(classify('./api.ts'), { launcher, intent: 'run' }));
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toContain('adhd-apigen');
    expect(err.message).toContain('./api.ts');
    expect(CLI_EXIT_CODE[err.code]).toBe(2);
    expect(launcher.started).toHaveLength(0);
  });

  it('@unsupported the argv translator on a reference that is not a command is invalid_argument', async () => {
    const launcher = createFakeLauncher();
    const resolution: ISourceResolution = { ...classify('./api.ts'), translator: 'argv' };
    const err = await rejectionOf(resolveSource(resolution, { launcher }));
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toContain('needs an executable source');
    expect(launcher.started).toHaveLength(0);
  });

  it('@unsupported remote references never reach resolveSource: the core classifier refuses them first', () => {
    const result = resolveSourceReference('remote:https://example.test/mcp', NO_PROBE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported');
  });
});

describe('Feature: the node source probe answers from the real filesystem and PATH', () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeAll(() => {
    // tmp/apigen/ under the repo root is the sanctioned scratch root for this package.
    const root = join(__dirname, '..', '..', '..', '..', '..', 'tmp', 'apigen');
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(join(root, 'source-probe-'));
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
    chmodSync(join(dir, 'tool'), 0o755);
    writeFileSync(join(dir, 'data.txt'), 'plain');
    chmodSync(join(dir, 'data.txt'), 0o644);
    mkdirSync(join(dir, 'subdir'));
    originalPath = process.env['PATH'];
  });

  afterAll(() => {
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('@probe isFile is true for a regular file only; false for a directory and for a missing path', () => {
    expect(nodeSourceProbe.isFile(join(dir, 'tool'))).toBe(true);
    expect(nodeSourceProbe.isFile(join(dir, 'subdir'))).toBe(false);
    expect(nodeSourceProbe.isFile(join(dir, 'missing'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    '@probe isExecutable reads the exec bit: true for 0755, false for 0644 and for a missing path',
    () => {
      expect(nodeSourceProbe.isExecutable(join(dir, 'tool'))).toBe(true);
      expect(nodeSourceProbe.isExecutable(join(dir, 'data.txt'))).toBe(false);
      expect(nodeSourceProbe.isExecutable(join(dir, 'missing'))).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    '@probe onPath finds a bare name in a PATH directory; never a path, an absolute name, a non-executable or an empty entry',
    () => {
      process.env['PATH'] = `:${dir}`; // a leading empty entry must not be read as the cwd
      expect(nodeSourceProbe.onPath('tool')).toBe(true);
      expect(nodeSourceProbe.onPath('data.txt')).toBe(false);
      expect(nodeSourceProbe.onPath('missing')).toBe(false);
      expect(nodeSourceProbe.onPath(join(dir, 'tool'))).toBe(false);
      expect(nodeSourceProbe.onPath('./tool')).toBe(false);
      expect(nodeSourceProbe.onPath('')).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    '@probe the core classifier uses it end to end: an executable file path and a PATH name both resolve as executables',
    () => {
      process.env['PATH'] = dir;
      const byPath = resolveSourceReference(join(dir, 'tool'), nodeSourceProbe);
      expect(byPath.ok && byPath.value.asset).toBe('executable');
      const byName = resolveSourceReference('tool', nodeSourceProbe);
      expect(byName.ok && byName.value.locator).toEqual({ kind: 'command', command: 'tool' });
      const refused = resolveSourceReference(join(dir, 'data.txt'), nodeSourceProbe);
      expect(refused.ok).toBe(false);
    }
  );
});
