/**
 * Multi-root / portable-hint / caller-cwd resolution (ADR-0008 D4/D7/D8).
 *
 * The fs analogue of the D-G welded-`provider` bug: a definition must carry NO
 * absolute host path — only portable HINTS (a cwd-relative subpath, or a named
 * alias into the GLOBAL allowed-root map). Resolution at task time turns a hint
 * into the concrete directory, so the SAME stored definition fires correctly
 * from any cwd while its JSON stays byte-identical.
 *
 * Every assertion is revert-failing: reverting the multi-root argv, the alias
 * map, or the absolute-path rejection turns the matching AC RED.
 */
import { describe, it, expect } from 'vitest';
import type { McpServerConfig, NativeToolingConfig } from '@adhd/agent-base-types';
import { NativeToolingRootError, resolveFsRoots, resolveNativeTooling } from './resolver.js';

type Stdio = Extract<McpServerConfig, { transport: 'stdio' }>;
const stdio = (servers: McpServerConfig[]): Stdio[] =>
  servers.filter((s): s is Stdio => s.transport === 'stdio');

/** The final argv entries of the resolved fs server (the allowed dirs). */
const fsRootsOf = (servers: McpServerConfig[]): string[] => {
  const fs = stdio(servers).find((s) => s.args?.some((a) => a.includes('server-filesystem')));
  if (!fs) throw new Error('no fs server resolved');
  const marker = fs.args!.findIndex((a) => a.includes('server-filesystem'));
  return fs.args!.slice(marker + 1);
};

describe('AC1 — multi-root: every hint becomes one argv entry', () => {
  it('{roots:["a","b"]} at caller-cwd /P → allowed dirs /P/a, /P/b', () => {
    const servers = resolveNativeTooling(
      { fs: { roots: ['a', 'b'] }, shell: false, dispatch: false },
      { cwd: '/P' }
    );
    expect(fsRootsOf(servers)).toEqual(['/P/a', '/P/b']);
  });

  it('no roots ⇒ the caller cwd alone', () => {
    const servers = resolveNativeTooling(
      { fs: true, shell: false, dispatch: false },
      { cwd: '/P' }
    );
    expect(fsRootsOf(servers)).toEqual(['/P']);
  });

  it('NEGATIVE CONTROL: dropping the 2nd root yields only /P/a', () => {
    // The exact wrong-variant: a single-root regression would silently drop `b`.
    const servers = resolveNativeTooling(
      { fs: { roots: ['a'] }, shell: false, dispatch: false },
      { cwd: '/P' }
    );
    expect(fsRootsOf(servers)).toEqual(['/P/a']);
    expect(fsRootsOf(servers)).not.toEqual(['/P/a', '/P/b']);
  });
});

describe('AC2 — portability: the SAME def fires from /P then /Q; stored JSON byte-identical', () => {
  it('relative hints resolve against each caller cwd, definition unchanged', () => {
    const def: NativeToolingConfig = { fs: { roots: ['a', 'b'] }, shell: false, dispatch: false };
    const snapshot = JSON.stringify(def);

    const atP = resolveNativeTooling(def, { cwd: '/P' });
    const atQ = resolveNativeTooling(def, { cwd: '/Q' });

    expect(fsRootsOf(atP)).toEqual(['/P/a', '/P/b']);
    expect(fsRootsOf(atQ)).toEqual(['/Q/a', '/Q/b']);
    // Normalizing only the cwd makes the two byte-identical — the cwd is the sole
    // source of difference (no definition-time root leaked in).
    const pNormalized = JSON.parse(JSON.stringify(atP).split('/P').join('/Q'));
    expect(pNormalized).toEqual(atQ);
    // Resolution NEVER mutates the stored definition.
    expect(JSON.stringify(def)).toBe(snapshot);
  });
});

describe('AC3 — global allowed-root map: an alias resolves to its absolute path', () => {
  it('the agent references the alias only; the map owns the absolute target', () => {
    const ctx = { cwd: '/P', roots: { project: '/opt/proj', tmp: '/tmp/scratch' } };
    const servers = resolveNativeTooling(
      { fs: { roots: ['project', 'tmp'] }, shell: false, dispatch: false },
      ctx
    );
    expect(fsRootsOf(servers)).toEqual(['/opt/proj', '/tmp/scratch']);
  });

  it('the alias wins over a same-named relative subpath (map is consulted first)', () => {
    const servers = resolveNativeTooling(
      { fs: { roots: ['project'] }, shell: false, dispatch: false },
      { cwd: '/P', roots: { project: '/mapped/project' } }
    );
    expect(fsRootsOf(servers)).toEqual(['/mapped/project']);
  });

  it('NEGATIVE CONTROL: with NO alias map the alias is treated as a relative subpath', () => {
    const servers = resolveNativeTooling(
      { fs: { roots: ['project'] }, shell: false, dispatch: false },
      { cwd: '/P' }
    );
    // RED for AC3: the operator's `/opt/proj` is absent; `/P/project` is used.
    expect(fsRootsOf(servers)).toEqual(['/P/project']);
  });
});

describe('AC5 — an absolute root in the record is REJECTED (typed error)', () => {
  it('a `roots` absolute hint throws ABSOLUTE_ROOT_NOT_PORTABLE', () => {
    expect(() =>
      resolveNativeTooling(
        { fs: { roots: ['/abs'] }, shell: false, dispatch: false },
        { cwd: '/P' }
      )
    ).toThrowError(NativeToolingRootError);
    try {
      resolveNativeTooling(
        { fs: { roots: ['/abs'] }, shell: false, dispatch: false },
        { cwd: '/P' }
      );
    } catch (err) {
      expect((err as NativeToolingRootError).code).toBe('ABSOLUTE_ROOT_NOT_PORTABLE');
    }
  });

  it('a singular `root` absolute hint is rejected too', () => {
    expect(() =>
      resolveNativeTooling(
        { fs: { root: '/abs' }, shell: false, dispatch: false },
        { cwd: '/P' }
      )
    ).toThrowError(NativeToolingRootError);
  });

  it('a `..` subpath that escapes the caller cwd is rejected (ROOT_ESCAPES_CALLER_CWD)', () => {
    try {
      resolveNativeTooling(
        { fs: { roots: ['../escape'] }, shell: false, dispatch: false },
        { cwd: '/P/deep' }
      );
      throw new Error('expected a NativeToolingRootError');
    } catch (err) {
      expect(err).toBeInstanceOf(NativeToolingRootError);
      expect((err as NativeToolingRootError).code).toBe('ROOT_ESCAPES_CALLER_CWD');
    }
  });
});

describe('AC6 — the ONE root-list producer (the host union uses this exact list)', () => {
  it('resolveFsRoots returns EVERY resolved root, in argv order', () => {
    const roots = resolveFsRoots(
      { roots: ['a', 'b'] },
      { cwd: '/P' }
    );
    expect(roots).toEqual(['/P/a', '/P/b']);
    // The resolver argv is derived from this SAME list — one producer.
    const servers = resolveNativeTooling(
      { fs: { roots: ['a', 'b'] }, shell: false, dispatch: false },
      { cwd: '/P' }
    );
    expect(fsRootsOf(servers)).toEqual(roots);
  });

  it('a disabled/custom fs member owns no roots (empty list)', () => {
    expect(resolveFsRoots(false, { cwd: '/P' })).toEqual([]);
    expect(
      resolveFsRoots({ transport: 'stdio', command: 'x' }, { cwd: '/P' })
    ).toEqual([]);
  });
});

/** The resolved cwd of the shell server (srt-wrapped or not). */
const shellCwdOf = (servers: McpServerConfig[]): string | undefined =>
  stdio(servers).find((s) => s.args?.includes('mcp-shell-server'))?.cwd;

describe('#3 — shell.root uses the SAME portable-hint contract as fs.root', () => {
  it('a `..` shell.root that escapes the caller cwd is rejected (ROOT_ESCAPES_CALLER_CWD)', () => {
    try {
      resolveNativeTooling(
        { fs: false, shell: { root: '../escape' }, dispatch: false },
        { cwd: '/P/deep' }
      );
      throw new Error('expected a NativeToolingRootError');
    } catch (err) {
      expect(err).toBeInstanceOf(NativeToolingRootError);
      expect((err as NativeToolingRootError).code).toBe('ROOT_ESCAPES_CALLER_CWD');
    }
  });

  it('an absolute shell.root is rejected (ABSOLUTE_ROOT_NOT_PORTABLE)', () => {
    try {
      resolveNativeTooling(
        { fs: false, shell: { root: '/abs' }, dispatch: false },
        { cwd: '/P' }
      );
      throw new Error('expected a NativeToolingRootError');
    } catch (err) {
      expect(err).toBeInstanceOf(NativeToolingRootError);
      expect((err as NativeToolingRootError).code).toBe('ABSOLUTE_ROOT_NOT_PORTABLE');
    }
  });

  it('a shell.root ALIAS maps to its absolute target (not treated as a relative subpath)', () => {
    const servers = resolveNativeTooling(
      { fs: false, shell: { root: 'project' }, dispatch: false },
      { cwd: '/P', roots: { project: '/opt/proj' } }
    );
    expect(shellCwdOf(servers)).toBe('/opt/proj');
  });

  it('a relative shell.root resolves against the caller cwd', () => {
    const servers = resolveNativeTooling(
      { fs: false, shell: { root: 'work' }, dispatch: false },
      { cwd: '/P' }
    );
    expect(shellCwdOf(servers)).toBe('/P/work');
  });

  it('NEGATIVE CONTROL: no shell.root ⇒ the caller cwd (unchanged default)', () => {
    const servers = resolveNativeTooling(
      { fs: false, shell: true, dispatch: false },
      { cwd: '/P' }
    );
    expect(shellCwdOf(servers)).toBe('/P');
  });
});

describe('#7 — alias lookup cannot leak an inherited or non-string mapping', () => {
  it('a hint named `constructor` with NO own alias is a relative subpath (no inherited leak)', () => {
    // `ctx.roots['constructor']` is `Object.prototype.constructor` (a function)
    // on a non-empty map that lacks the key — the pre-fix lookup returned it,
    // welding a function into the argv. With hasOwnProperty it falls through.
    const servers = resolveNativeTooling(
      { fs: { root: 'constructor' }, shell: false, dispatch: false },
      { cwd: '/P', roots: { project: '/opt/proj' } }
    );
    expect(fsRootsOf(servers)).toEqual(['/P/constructor']);
  });

  it('a hint named `__proto__` with no own alias is a relative subpath', () => {
    const servers = resolveNativeTooling(
      { fs: { root: '__proto__' }, shell: false, dispatch: false },
      { cwd: '/P', roots: { project: '/opt/proj' } }
    );
    expect(fsRootsOf(servers)).toEqual(['/P/__proto__']);
  });

  it('an OWN alias named `constructor` DOES map to its target', () => {
    const servers = resolveNativeTooling(
      { fs: { root: 'constructor' }, shell: false, dispatch: false },
      { cwd: '/P', roots: { constructor: '/opt/ctor' } }
    );
    expect(fsRootsOf(servers)).toEqual(['/opt/ctor']);
  });

  it('a NON-STRING mapping is ignored (falls through to the relative subpath)', () => {
    const servers = resolveNativeTooling(
      { fs: { root: 'project' }, shell: false, dispatch: false },
      { cwd: '/P', roots: { project: 42 } as unknown as Record<string, string> }
    );
    expect(fsRootsOf(servers)).toEqual(['/P/project']);
  });
});
