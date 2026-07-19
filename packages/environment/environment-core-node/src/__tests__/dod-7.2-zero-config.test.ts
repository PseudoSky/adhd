/**
 * DoD §7.2 — Zero-config proof (ARCHITECTURE.md).
 *
 * `new Environment('t', { config: { 'a.port': { type:'integer', default: 8787 } } })`
 * → `env.config.a.port === 8787`, with an empty temp `adhdRoot` and no cwd
 * markers. A downstream consumer must NEVER have to write a file or export
 * a var just to make things run.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '../environment';
import { cleanupFixtures, mkAdhdRoot, mkCwdFixture } from '../test/fixtures';

afterEach(() => {
  cleanupFixtures();
});

describe('DoD §7.2 — zero-config', () => {
  it('resolves entirely from the spec default: no files on disk, no env var set, no cwd markers', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture(); // genuinely marker-free (outside this repo's git tree — see test/fixtures.ts)

    const env = new Environment<{ a: { port: number } }>(
      't',
      { config: { 'a.port': { type: 'integer', default: 8787 } } },
      { scope: 'global', adhdRoot, cwd },
    );

    expect(env.config.a.port).toBe(8787);
    expect(env.get('config.a.port')).toBe(8787);
    expect(env.get('provenance.a.port')).toEqual({ source: 'default', scope: 'global' });
  });

  it('negative control: if the default-fallback breaks (field omits `default`), the value is NOT silently 8787 — proves the assertion above has teeth', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();

    const env = new Environment<{ a: { port: number | undefined } }>(
      't',
      { config: { 'a.port': { type: 'integer' } } }, // no default supplied — this is the deliberately-broken variant
      { scope: 'global', adhdRoot, cwd },
    );

    expect(env.config.a.port).toBeUndefined();
    expect(env.config.a.port).not.toBe(8787);
  });

  it('a spec with zero declared config fields still constructs successfully (an empty project is valid, zero-config)', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const env = new Environment('t', { config: {} }, { scope: 'global', adhdRoot, cwd });
    expect(env.project).toBe('t');
    expect(env.config).toEqual({});
  });

  it('multiple declared defaults resolve simultaneously with no cross-talk', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const env = new Environment<{ a: { port: number }; b: { name: string; enabled: boolean } }>(
      't',
      {
        config: {
          'a.port': { type: 'integer', default: 1234 },
          'b.name': { type: 'string', default: 'hello' },
          'b.enabled': { type: 'boolean', default: true },
        },
      },
      { scope: 'global', adhdRoot, cwd },
    );
    expect(env.config.a.port).toBe(1234);
    expect(env.config.b.name).toBe('hello');
    expect(env.config.b.enabled).toBe(true);
  });
});
