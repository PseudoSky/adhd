/**
 * guards: A review fix to the entrypoint regresses: strict flag parsing (E11), abort handlers installed only for verbs (E4), attribute precedence flag over environment never merged (D-06), baked-IR and extraction handling, or the HTTP start refusals.
 * tier: S
 * cites: docs/plan/policy-core/REVIEW-FIXES.md (Entrypoint proof, Phase C part 1: E4, E11, E12, D-06)
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isApiError } from '@adhd/apigen-base-errors';
import type { IProcessLauncher } from '@adhd/apigen-engine-gateway';
import { describe, expect, it, vi } from 'vitest';
import { ATTRIBUTES_ENV_VAR, attributesFromFlags } from '../../wrapper/attributes-from-flags';
import { createAttributesLayerPlugin } from '../../wrapper/attributes-layer';
import { createAttributesSource, type IAttributesSource } from '../../wrapper/attributes-source';
import { splitPolicyArgv } from '../../wrapper/flags';
import { HTTP_PORT_ENV_VAR, parseHttpPort } from '../../wrapper/http-port';
import {
  expectedExtractorVersion,
  extractPolicyOperations,
  inspectBakedIr,
  policyDistDir,
  POLICY_IR_FORMAT_VERSION,
  writeBakedIr,
} from '../../wrapper/ir';
import { runIrArtifact } from '../../wrapper/ir-artifact';
import { LOG_LEVEL_ENV_VAR, resolveLogLevel } from '../../wrapper/log-level';
import { startPolicyHttp } from '../../wrapper/mount';
import { readPolicyVersion } from '../../wrapper/package';
import { installAbortOnSignals } from '../../wrapper/signals';
import { dispatchVerb } from '../../wrapper/verbs/index';
import { parseJson, runCli, useScratchTelemetry } from '../helpers/capture';
import { BROKEN_YAML, WORKSPACE_YAML, writePolicy } from '../helpers/fixtures';
import { withTmpDir } from '../helpers/tmp';

useScratchTelemetry();

// A cold live extraction of the client declarations takes several seconds (ts-morph); it is setup, not a timing assertion.
vi.setConfig({ testTimeout: 60_000 });

/** Runs `fn` and returns the error it throws (fails the test when it does not throw). */
async function thrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

/** True when `error` is an ApiError carrying `code`. */
const hasCode = (error: unknown, code: string): boolean => isApiError(error) && error.code === code;

/** A launcher that records every attempt and refuses to start anything. */
function refusingLauncher(): { launcher: IProcessLauncher; attempts: () => number } {
  let attempts = 0;
  return {
    launcher: {
      start: async () => {
        attempts += 1;
        throw new Error('launch attempted');
      },
    },
    attempts: () => attempts,
  };
}

/** Drives a wrapper verb in process through `dispatchVerb` with injected deps and a launcher that must never be used. */
async function drive(argv: string[], env: Record<string, string | undefined> = {}, cwd = process.cwd()) {
  const { launcher, attempts } = refusingLauncher();
  const out: string[] = [];
  const err: string[] = [];
  const verb = await dispatchVerb(argv, { cwd, home: cwd, env, launcher, stdout: (t) => void out.push(t), stderr: (t) => void err.push(t) });
  return { ...verb, stdout: out.join(''), stderr: err.join(''), attempts: attempts() };
}

describe('Review fixes E11 / E12 - strict flags (splitPolicyArgv and the verbs)', () => {
  it('E11 a flag value that starts with -- is refused instead of swallowing the next flag', () => {
    for (const argv of [
      ['--adhd-attributes', '--spec', 'x'],
      ['--spec', '--name', 'x'],
      ['--name', '--adhd-attributes'],
      ['--adhd-attributes=--spec'],
      ['--name=--x'],
    ]) {
      const error = (() => {
        try {
          splitPolicyArgv(argv);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(hasCode(error, 'invalid_argument'), argv.join(' ')).toBe(true);
    }
  });

  it('E11 a repeated --adhd-attributes or --name is invalid_argument, a repeated --spec is allowed in order', () => {
    expect(() => splitPolicyArgv(['--adhd-attributes', '{}', '--adhd-attributes', '{}'])).toThrow(/more than once/);
    expect(() => splitPolicyArgv(['--name', 'a', '--name=b'])).toThrow(/more than once/);
    expect(splitPolicyArgv(['bin:x', '--spec', 'a.yaml', '--spec=b.yaml']).specFiles).toEqual(['a.yaml', 'b.yaml']);
  });

  it('E11 a valueless flag and an unknown flag are invalid_argument', () => {
    expect(() => splitPolicyArgv(['--spec'])).toThrow(/needs a value/);
    expect(() => splitPolicyArgv(['--spec='])).toThrow(/needs a value/);
    expect(() => splitPolicyArgv(['--bogus', 'x'])).toThrow(/unknown flag --bogus/);
  });

  it('E11 everything after the first -- reaches the child untouched, --adhd-* included', () => {
    const split = splitPolicyArgv(['bin:tool', '--adhd-attributes', '{"a":"b"}', '--', '--adhd-attributes', '--spec', '--name', 'x', '--']);
    expect(split.positionals).toEqual(['bin:tool']);
    expect(split.attributes).toBe('{"a":"b"}');
    expect(split.childArgs).toEqual(['--adhd-attributes', '--spec', '--name', 'x', '--']);
  });

  const refused: { name: string; argv: string[]; env?: Record<string, string>; stderr: RegExp }[] = [
    { name: 'a flag value starting with --', argv: ['run', 'bin:nope', '--adhd-attributes', '--spec', 'x'], stderr: /--adhd-attributes needs a value/ },
    { name: 'the = form of a value starting with --', argv: ['run', 'bin:nope', '--adhd-attributes=--x'], stderr: /--adhd-attributes needs a value/ },
    { name: 'a repeated --adhd-attributes', argv: ['run', 'bin:nope', '--adhd-attributes', '{}', '--adhd-attributes', '{}'], stderr: /more than once/ },
    { name: 'a repeated --name', argv: ['serve', 'bin:nope', '--name', 'a', '--name', 'b'], stderr: /more than once/ },
    { name: 'an unknown flag', argv: ['run', 'bin:nope', '--bogus', 'x'], stderr: /unknown flag --bogus/ },
    { name: 'a valueless flag', argv: ['run', 'bin:nope', '--spec'], stderr: /--spec needs a value/ },
    { name: 'attributes that are not valid JSON', argv: ['run', 'bin:nope', '--adhd-attributes', '{nope'], stderr: /attributes: .* is not valid JSON/ },
    { name: 'attributes that are not an object', argv: ['run', 'bin:nope', '--adhd-attributes', '[1]'], stderr: /must be a JSON object/ },
    { name: 'an attribute value that is not string, number or string[]', argv: ['run', 'bin:nope', '--adhd-attributes', '{"a":{"b":1}}'], stderr: /"a" must be a string, a number or a list of strings/ },
    { name: 'a bad ADHD_POLICY_ATTRIBUTES (no flag)', argv: ['run', 'bin:nope'], env: { [ATTRIBUTES_ENV_VAR]: '"scalar"' }, stderr: /must be a JSON object/ },
    { name: 'an unreadable @file of attributes', argv: ['run', 'bin:nope', '--adhd-attributes', '@/definitely/not/here.json'], stderr: /attributes: cannot read/ },
    { name: 'a --name on run', argv: ['run', 'bin:nope', '--name', 'x'], stderr: /--name applies to serve only/ },
  ];
  for (const row of refused) {
    it(`E11 ${row.name}: exit 2, a message on stderr, nothing on stdout, and the launcher is never used`, async () => {
      const result = await drive(row.argv, row.env);
      expect(result.handled).toBe(true);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(row.stderr);
      expect(result.stdout).toBe('');
      expect(result.attempts).toBe(0);
    });
  }
});

describe('Review fix E4 - abort handlers are installed only for verbs', () => {
  it('E4 an apigen command (verify) leaves the SIGINT/SIGTERM listeners exactly as it found them', async () => {
    await withTmpDir('e4', async (dir) => {
      await writePolicy(dir, WORKSPACE_YAML);
      const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      const result = await runCli(['verify'], { cwd: dir, home: dir });
      expect(result.exitCode).toBe(0);
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    });
  });

  it('E4 installAbortOnSignals aborts on the first signal and removes both handlers', () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const signal = installAbortOnSignals();
    try {
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before.map((count) => count + 1));
      expect(signal.aborted).toBe(false);
      process.emit('SIGTERM');
      expect(signal.aborted).toBe(true);
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    } finally {
      // A failing assertion above must not leave handlers that would swallow a real Ctrl-C.
      for (const name of ['SIGINT', 'SIGTERM'] as const) {
        for (const listener of process.listeners(name).slice(before[name === 'SIGINT' ? 0 : 1])) process.off(name, listener);
      }
    }
  });
});

describe('Decision D-06 - attribute precedence, never merged, files re-read on every call', () => {
  it('D-06 the flag wins over ADHD_POLICY_ATTRIBUTES and the two are never merged', async () => {
    const source = await attributesFromFlags({ attributes: '{"role":"flag"}' }, { cwd: process.cwd(), env: { [ATTRIBUTES_ENV_VAR]: '{"role":"env","extra":"x"}' } });
    expect(source.origin).toBe('flag');
    expect(await source.read()).toEqual({ role: 'flag' });
  });

  it('D-06 the environment value is used when there is no flag', async () => {
    const source = await attributesFromFlags({}, { cwd: process.cwd(), env: { [ATTRIBUTES_ENV_VAR]: '{"role":"env"}' } });
    expect(source.origin).toBe('env');
    expect(await source.read()).toEqual({ role: 'env' });
  });

  it('D-06 with neither there are no attributes (undefined, not an empty object)', async () => {
    const source = await attributesFromFlags({}, { cwd: process.cwd(), env: {} });
    expect(source.origin).toBe('none');
    expect(await source.read()).toBeUndefined();
  });

  it('D-06 an empty flag or empty environment value counts as not set', async () => {
    const source = await attributesFromFlags({ attributes: '' }, { cwd: process.cwd(), env: { [ATTRIBUTES_ENV_VAR]: '' } });
    expect(source.origin).toBe('none');
  });

  it('D-06 an @file is read from disk on every call, so a rotating identity file is honoured', async () => {
    await withTmpDir('d06', async (dir) => {
      const file = join(dir, 'who.json');
      await writeFile(file, '{"role":"first"}');
      const source = await attributesFromFlags({ attributes: '@who.json' }, { cwd: dir, env: {} });
      expect(await source.read()).toEqual({ role: 'first' });
      await writeFile(file, '{"role":"second","n":2}');
      expect(await source.read()).toEqual({ role: 'second', n: 2 });
      await rm(file);
      const error = await thrown(() => source.read());
      expect(hasCode(error, 'invalid_argument')).toBe(true);
      expect((error as Error).message).toContain('attributes: cannot read');
    });
  });

  it('D-06 a bad value refuses to start: attributesFromFlags rejects before any gate is built', async () => {
    const error = await thrown(() => attributesFromFlags({ attributes: '[]' }, { cwd: process.cwd(), env: {} }));
    expect(hasCode(error, 'invalid_argument')).toBe(true);
  });

  /** Runs the attributes layer once against `envelope` and returns the envelope afterwards. */
  async function runLayer(source: IAttributesSource, envelope: Record<string, unknown>): Promise<Record<string, unknown>> {
    const plugin = createAttributesLayerPlugin(source);
    const layer = plugin.capabilities?.layer?.layer as unknown as (call: unknown, next: () => Promise<unknown>) => Promise<unknown>;
    await layer({ envelope }, async () => 'next');
    return envelope;
  }

  it('D-06 the attributes layer overwrites whatever a caller put on the envelope, and deletes it when there are none', async () => {
    const configured = createAttributesSource({ flag: '{"role":"dev"}', cwd: process.cwd() });
    expect(await runLayer(configured, { attributes: { role: 'admin' } })).toEqual({ attributes: { role: 'dev' } });
    const none = createAttributesSource({ cwd: process.cwd() });
    expect(await runLayer(none, { attributes: { role: 'admin' }, other: 1 })).toEqual({ other: 1 });
  });

  it('D-06 a read failure on a call is permission_denied, never a call that proceeds', async () => {
    await withTmpDir('d06-layer', async (dir) => {
      const source = createAttributesSource({ flag: '@who.json', cwd: dir });
      const plugin = createAttributesLayerPlugin(source);
      const layer = plugin.capabilities?.layer?.layer as unknown as (call: unknown, next: () => Promise<unknown>) => Promise<unknown>;
      let proceeded = false;
      const error = await thrown(() => layer({ envelope: {} }, async () => void (proceeded = true)));
      expect(hasCode(error, 'permission_denied')).toBe(true);
      expect(proceeded).toBe(false);
    });
  });
});

describe('Review fix E6 - strict HTTP port parsing', () => {
  it('E6 absent or empty is 0 and plain decimal digits in 0..65535 are accepted', () => {
    expect(parseHttpPort(undefined)).toBe(0);
    expect(parseHttpPort('')).toBe(0);
    expect(parseHttpPort('0')).toBe(0);
    expect(parseHttpPort('8080')).toBe(8080);
    expect(parseHttpPort('65535')).toBe(65535);
    expect(parseHttpPort('007')).toBe(7);
  });

  for (const bad of ['abc', '-1', '1e3', '80.5', '0x50', ' 80', '80 ', '+80', '65536', '70000', '99999999999999999999']) {
    it(`E6 "${bad}" is invalid_argument (exit 2), never NaN or a coercion`, () => {
      const error = (() => {
        try {
          parseHttpPort(bad);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(hasCode(error, 'invalid_argument')).toBe(true);
      expect((error as Error).message).toContain(HTTP_PORT_ENV_VAR);
    });
  }

  it('E6 the HTTP start refuses a bad port and a non-loopback host before binding anything', async () => {
    const signal = new AbortController().signal;
    const badPort = await thrown(() => startPolicyHttp({ signal, host: '127.0.0.1', env: { [HTTP_PORT_ENV_VAR]: 'abc' } }));
    expect(hasCode(badPort, 'invalid_argument')).toBe(true);
    const badHost = await thrown(() => startPolicyHttp({ signal, host: '0.0.0.0', port: 0 }));
    expect(hasCode(badHost, 'invalid_argument')).toBe(true);
    expect((badHost as Error).message).toContain('loopback');
  });
});

describe('Review fix E12 - log level, doctor exit code, README exit-code table', () => {
  it('E12 the command line defaults to warn so the -> command info line never prints; the documented levels resolve', () => {
    expect(resolveLogLevel(undefined)).toBe('warn');
    expect(resolveLogLevel('')).toBe('warn');
    for (const level of ['debug', 'info', 'warn', 'error', 'silent']) expect(resolveLogLevel(level)).toBe(level);
  });

  it('E12 an unknown level is invalid_argument naming the variable', () => {
    const error = (() => {
      try {
        resolveLogLevel('loud');
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(hasCode(error, 'invalid_argument')).toBe(true);
    expect((error as Error).message).toContain(LOG_LEVEL_ENV_VAR);
  });

  it('E12 an unknown ADHD_POLICY_LOG_LEVEL through the command line exits 2 with the variable named, before any command runs', async () => {
    await withTmpDir('e12-level', async (dir) => {
      await writePolicy(dir, WORKSPACE_YAML);
      const result = await runCli(['verify'], { cwd: dir, home: dir, env: { [LOG_LEVEL_ENV_VAR]: 'loud' } });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(LOG_LEVEL_ENV_VAR);
    });
  });

  it('E12 doctor on a good policy exits 0 with every check ok', async () => {
    await withTmpDir('e12-doctor-ok', async (dir) => {
      await writePolicy(dir, WORKSPACE_YAML);
      const result = await runCli(['doctor'], { cwd: dir, home: dir });
      expect(result.exitCode).toBe(0);
      const report = parseJson<{ ok: boolean; checks: { name: string; ok: boolean }[] }>(result.stdout);
      expect(report.ok).toBe(true);
      expect(report.checks.every((check) => check.ok)).toBe(true);
    });
  });

  it('E12 doctor with a failed check is ok:false and exits 2 (not 0)', async () => {
    await withTmpDir('e12-doctor-bad', async (dir) => {
      await writePolicy(dir, BROKEN_YAML);
      const result = await runCli(['doctor'], { cwd: dir, home: dir });
      const report = parseJson<{ ok: boolean; checks: { name: string; ok: boolean }[] }>(result.stdout);
      expect(report.ok).toBe(false);
      expect(report.checks.some((check) => !check.ok)).toBe(true);
      expect(result.exitCode).toBe(2);
    });
  });

  it('E12 the README exit-code table documents exactly the codes the CLI uses', () => {
    const readme = readFileSync(resolve(import.meta.dirname, '../../../README.md'), 'utf8');
    const table = readme.slice(readme.indexOf('## Exit codes'), readme.indexOf('## Settings'));
    const codes = [...table.matchAll(/^\| (\d) \|/gm)].map((match) => match[1]);
    expect(codes).toEqual(['0', '1', '2', '3', '4']);
  });
});

describe('Review fix E10 - the hidden ir-artifact subcommand', () => {
  async function run(argv: string[], cwd: string) {
    const err: string[] = [];
    const code = await runIrArtifact(argv, { cwd, stderr: (t) => void err.push(t) });
    return { code, stderr: err.join('') };
  }

  it('E10 a missing or valueless --out is invalid_argument: exit 2, one clean line, no stack trace', async () => {
    await withTmpDir('e10', async (dir) => {
      for (const argv of [[], ['--out'], ['--out', ''], ['--out', '--other']]) {
        const { code, stderr } = await run(argv, dir);
        expect(code, argv.join(' ')).toBe(2);
        expect(stderr).toBe('ir-artifact requires --out <file>\n');
        expect(stderr).not.toContain('    at ');
      }
    });
  });

  it('E10 --out outside the package dist/ is refused with exit 2 and nothing is written', async () => {
    // Every rejected target stays inside this scratch directory, so even a regression that stops refusing writes only here.
    await withTmpDir('e10-out', async (dir) => {
      const cwd = join(dir, 'inner');
      await mkdir(cwd);
      for (const out of [join(dir, 'escape.json'), 'escape.json', '../escape.json']) {
        const { code, stderr } = await run(['--out', out], cwd);
        expect(code, out).toBe(2);
        expect(stderr).toContain('ir-artifact --out must be a file under');
        expect(stderr).not.toContain('    at ');
      }
      expect(await readdir(dir, { recursive: true })).toEqual(['inner']);
    });
  });

  it('E10 --out under dist/ bakes an artifact that is then usable, and the file is removed afterwards', async () => {
    const target = join(policyDistDir(), `.ir-artifact-spec-${process.pid}.json`);
    try {
      const { code, stderr } = await run(['--out', target], process.cwd());
      expect(stderr).toBe('');
      expect(code).toBe(0);
      const baked = JSON.parse(await readFile(target, 'utf8')) as { formatVersion: number; operations: { kind: string }[] };
      expect(baked.formatVersion).toBe(POLICY_IR_FORMAT_VERSION);
      expect(baked.operations.length).toBeGreaterThan(0);
    } finally {
      await rm(target, { force: true });
    }
    expect(existsSync(target)).toBe(false);
  });
});

describe('Review fixes E1 / E13 - dist layout lookup, stale artifact warning, loadable version', () => {
  it('E1 policyDistDir finds the bundle directory in each of the shipped and source layouts', async () => {
    await withTmpDir('e1-layout', async (root) => {
      const touch = async (path: string, name: string) => {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, name), '');
      };
      // Installed package: the bundle itself sits in the package root.
      await touch(join(root, 'installed'), 'cli.js');
      expect(policyDistDir(join(root, 'installed'))).toBe(join(root, 'installed'));
      // Repo bundle layout: a dist/ beside the starting directory.
      await touch(join(root, 'beside', 'dist'), 'api.ir.json');
      expect(policyDistDir(join(root, 'beside'))).toBe(join(root, 'beside', 'dist'));
      // A dist/ one level up (a chunk in dist/chunks next to dist/).
      await touch(join(root, 'up', 'dist'), 'cli.js');
      await mkdir(join(root, 'up', 'bundle'), { recursive: true });
      expect(policyDistDir(join(root, 'up', 'bundle'))).toBe(join(root, 'up', 'dist'));
      // Source layout: src/wrapper under the package whose dist/ holds the build.
      await touch(join(root, 'source', 'dist'), 'cli.js');
      await mkdir(join(root, 'source', 'src', 'wrapper'), { recursive: true });
      expect(policyDistDir(join(root, 'source', 'src', 'wrapper'))).toBe(join(root, 'source', 'dist'));
      // Nothing found: the starting directory.
      await mkdir(join(root, 'empty'), { recursive: true });
      expect(policyDistDir(join(root, 'empty'))).toBe(join(root, 'empty'));
    });
  });

  it('E1 the starting directory wins over a dist/ beside it when both hold the markers', async () => {
    await withTmpDir('e1-order', async (root) => {
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'dist', 'cli.js'), '');
      await writeFile(join(root, 'cli.js'), '');
      expect(policyDistDir(root)).toBe(root);
    });
  });

  it('E13 the extractor version and the package version are readable (nothing falls back to unknown / 0.0.0)', () => {
    expect(expectedExtractorVersion()).not.toBe('unknown');
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as { version: string };
    expect(readPolicyVersion()).toBe(manifest.version);
  });

  describe('a baked artifact is used only when it is current', () => {
    /** Bakes a real artifact into `dir`, applies `change` to its JSON, and returns the inspection. */
    async function inspectChanged(dir: string, change: (artifact: Record<string, unknown>) => void) {
      const file = join(dir, 'api.ir.json');
      await writeBakedIr(file);
      const artifact = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      change(artifact);
      await writeFile(file, JSON.stringify(artifact));
      return await inspectBakedIr(dir);
    }

    it('E1 a freshly baked artifact is accepted', async () => {
      await withTmpDir('e1-fresh', async (dir) => {
        const inspected = await inspectChanged(dir, () => undefined);
        expect('operations' in inspected && inspected.operations.length > 0).toBe(true);
      });
    });

    const stale: { name: string; change: (artifact: Record<string, unknown>) => void; reason: RegExp }[] = [
      { name: 'a different artifact format', change: (a) => void (a['formatVersion'] = 0), reason: /artifact format 0 is not 1/ },
      { name: 'a different extractor version', change: (a) => void (a['extractorVersion'] = '0.0.0-other'), reason: /baked by extractor 0\.0\.0-other/ },
      { name: 'no operations', change: (a) => void (a['operations'] = []), reason: /holds no operations/ },
      { name: 'a changed client surface', change: (a) => void ((a['artifactSource'] as { deps: Record<string, string> }).deps = { 'service/api.d.ts': 'deadbeef' }), reason: /declarations changed since the artifact was baked/ },
    ];
    for (const row of stale) {
      it(`E1 ${row.name} is rejected with a reason`, async () => {
        await withTmpDir('e1-stale', async (dir) => {
          const inspected = await inspectChanged(dir, row.change);
          expect('reason' in inspected && inspected.reason).toMatch(row.reason);
        });
      });
    }

    it('E1 a missing artifact is reported as missing and a corrupt one as unreadable', async () => {
      await withTmpDir('e1-missing', async (dir) => {
        expect(await inspectBakedIr(dir)).toEqual({ reason: 'missing' });
        await writeFile(join(dir, 'api.ir.json'), '{not json');
        const corrupt = await inspectBakedIr(dir);
        expect('reason' in corrupt && corrupt.reason).toMatch(/artifact is unreadable/);
      });
    });

    it('E1 a stale artifact writes exactly ONE warning line and falls back to live extraction that still yields the operations', async () => {
      await withTmpDir('e1-warn', async (dir) => {
        await writeFile(join(dir, 'api.ir.json'), JSON.stringify({ formatVersion: 0 }));
        const lines: string[] = [];
        const operations = await extractPolicyOperations((line) => void lines.push(line), dir);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^@adhd\/policy: ignoring the baked operation surface \(.+\); extracting live$/);
        expect(operations.length).toBeGreaterThan(0);
        expect(operations.some((op) => op.path[op.path.length - 1]?.raw === 'check')).toBe(true);
      });
    });

    it('E1 no artifact shipped is not a warning, and a current one is used silently', async () => {
      await withTmpDir('e1-quiet', async (dir) => {
        const lines: string[] = [];
        const live = await extractPolicyOperations((line) => void lines.push(line), dir);
        expect(lines).toEqual([]);
        await writeBakedIr(join(dir, 'api.ir.json'));
        const baked = await extractPolicyOperations((line) => void lines.push(line), dir);
        expect(lines).toEqual([]);
        expect(baked).toEqual(live);
      });
    });
  });
});
