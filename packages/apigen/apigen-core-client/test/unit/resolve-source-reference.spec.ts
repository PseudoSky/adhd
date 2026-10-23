/**
 * guards: a --source reference is classified into the wrong asset kind, translator or binding (a PATH binary shadowing a code file, a URL ending in .py read as code, an unprobed reference claiming a probe result)
 * tier: S
 * cites: REMEDIATION-PLAN T-R2 (detection order of gap analysis 5.5, PATH fallback last and unguarded, decision O-2); ADR-0017 D4
 * tags: contract
 * teeth: red: move the `probe?.onPath` branch ahead of the `languageOfSource` branch in resolveSourceReference (guarded temporary edit, restored) and run `npx vitest run src/test/resolve-source-reference.spec.ts` in packages/apigen/apigen-core-client -> exit 1; the "./api.ts with a same-named PATH binary" row goes red
 */
import { describe, expect, it } from 'vitest';
import { resolveSourceReference, type ISourceProbe } from '../../src/index';

interface IProbeState {
  files?: string[];
  executables?: string[];
  path?: string[];
  everythingOnPath?: boolean;
}

function probe(state: IProbeState = {}): ISourceProbe {
  return {
    isFile: (p) => (state.files ?? []).includes(p),
    isExecutable: (p) => (state.executables ?? []).includes(p),
    onPath: (c) => state.everythingOnPath === true || (state.path ?? []).includes(c),
  };
}

function ok(reference: string, p?: ISourceProbe) {
  const r = resolveSourceReference(reference, p);
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function fail(reference: string, p?: ISourceProbe) {
  const r = resolveSourceReference(reference, p);
  if (r.ok) throw new Error(`expected failure, got ${JSON.stringify(r.value)}`);
  return r.error;
}

describe('resolveSourceReference (T-R2)', () => {
  describe('step 1: scheme prefix', () => {
    it('bin:<cmd> is an executable with the argv default and no translator', () => {
      const v = ok('bin:git');
      expect(v.asset).toBe('executable');
      expect(v.translator).toBeUndefined();
      expect(v.locator).toEqual({ kind: 'command', command: 'git' });
      expect(v.binding).toEqual({ kind: 'process', command: 'git', protocol: 'argv' });
      expect(v.options).toEqual({});
      expect(v.reference).toBe('bin:git');
    });

    it('bin: with a path keeps the path as the command', () => {
      expect(ok('bin:./tools/run.sh').locator).toEqual({ kind: 'command', command: './tools/run.sh' });
    });

    it('bin: with nothing after it is invalid', () => {
      const e = fail('bin:');
      expect(e.code).toBe('invalid-reference');
      expect(e.message).toContain('needs a command');
    });

    it('bin: with arguments is invalid and says to pass them separately', () => {
      const e = fail('bin:git status');
      expect(e.code).toBe('invalid-reference');
      expect(e.message).toContain('pass arguments separately');
    });

    it('remote: is unsupported', () => {
      expect(fail('remote:host/x').code).toBe('unsupported');
    });
  });

  it('the empty reference is invalid', () => {
    const e = fail('');
    expect(e.code).toBe('invalid-reference');
    expect(e.message).toBe('empty source reference');
  });

  describe('step 2: URL, checked before the extension', () => {
    it.each(['http://x/api', 'https://x/function.py', 'HTTPS://x/y.ts'])('%s is unsupported, never code', (ref) => {
      expect(fail(ref).code).toBe('unsupported');
    });
  });

  describe('step 3: code extension (no probe needed)', () => {
    it.each([
      ['src/api.ts', 'ts', { kind: 'in-process', runtime: 'ts' }],
      ['src/api.MTS', 'ts', { kind: 'in-process', runtime: 'ts' }],
      ['api.py', 'py', { kind: 'local-host', runtime: 'py' }],
      ['lib.rs', 'rust', { kind: 'local-host', runtime: 'rust' }],
      ['main.go', 'go', { kind: 'local-host', runtime: 'go' }],
      ['Api.java', 'java', { kind: 'local-host', runtime: 'java' }],
    ])('%s -> code / %s', (ref, translator, binding) => {
      const v = ok(ref);
      expect(v.asset).toBe('code');
      expect(v.translator).toBe(translator);
      expect(v.binding).toEqual(binding);
      expect(v.locator).toEqual({ kind: 'path', path: ref });
    });

    it('a code file wins even when a same-named binary is on PATH (O-2: PATH is last)', () => {
      const v = ok('./api.ts', probe({ everythingOnPath: true }));
      expect(v.asset).toBe('code');
      expect(v.translator).toBe('ts');
    });
  });

  describe('step 4: schema-document extension', () => {
    it.each(['api.json', 'spec.yaml', 'spec.YML', 'schema.graphql'])('%s is unsupported', (ref) => {
      const e = fail(ref, probe({ everythingOnPath: true }));
      expect(e.code).toBe('unsupported');
      expect(e.message).toContain('schema-document');
    });
  });

  describe('steps 5 and 6: existing executable, then PATH', () => {
    it('a file that exists with an exec bit is an executable', () => {
      const v = ok('./scripts/run', probe({ files: ['./scripts/run'], executables: ['./scripts/run'] }));
      expect(v.asset).toBe('executable');
      expect(v.locator).toEqual({ kind: 'command', command: './scripts/run' });
    });

    it('a file that exists without an exec bit falls through to the not-found error', () => {
      const e = fail('./scripts/run', probe({ files: ['./scripts/run'] }));
      expect(e.code).toBe('invalid-reference');
    });

    it('an exec bit on a path that is not a regular file does not count', () => {
      const e = fail('./dir', probe({ executables: ['./dir'] }));
      expect(e.code).toBe('invalid-reference');
    });

    it('a bare word found on PATH is an executable (unguarded fallback)', () => {
      const v = ok('git', probe({ path: ['git'] }));
      expect(v.asset).toBe('executable');
      expect(v.binding).toEqual({ kind: 'process', command: 'git', protocol: 'argv' });
    });

    it('an existing executable path is preferred over PATH (both map to the same shape)', () => {
      const v = ok('tool', probe({ files: ['tool'], executables: ['tool'], path: ['tool'] }));
      expect(v.asset).toBe('executable');
    });
  });

  describe('step 7: nothing matches', () => {
    const names = [
      'scheme prefix',
      'URL',
      'code extension',
      'schema extension',
      'existing executable path',
      'PATH lookup',
    ];

    it('names every interpretation tried', () => {
      const e = fail('no-such-thing', probe());
      expect(e.code).toBe('invalid-reference');
      for (const name of names) expect(e.message).toContain(name);
      expect(e.message).toContain('"no-such-thing"');
      expect(e.message).not.toContain('not checked');
    });

    it('says the filesystem and PATH steps were not checked when no probe is supplied', () => {
      const e = fail('no-such-thing');
      expect(e.message).toContain('existing executable path (not checked: no probe supplied)');
      expect(e.message).toContain('PATH lookup (not checked: no probe supplied)');
    });

    it('without a probe a bare word is never resolved as an executable', () => {
      expect(fail('git').code).toBe('invalid-reference');
    });
  });
});
