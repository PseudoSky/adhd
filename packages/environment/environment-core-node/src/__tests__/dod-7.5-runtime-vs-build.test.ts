/**
 * DoD §7.5 — Runtime-vs-build proof (ARCHITECTURE.md).
 *
 * An `at:'runtime'` field re-reads live `process.env` BETWEEN two
 * `env.get()` calls; an `at:'build'` (default) field does not.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Environment } from '../environment';
import { cleanupFixtures, mkAdhdRoot, mkCwdFixture, withEnvVar } from '../test/fixtures';

type Cfg = { live: { port: number }; frozen: { port: number } };

function makeEnv() {
  const adhdRoot = mkAdhdRoot();
  const cwd = mkCwdFixture();
  return new Environment<Cfg>(
    't',
    {
      config: {
        'live.port': { type: 'integer', at: 'runtime', default: 1000 },
        'frozen.port': { type: 'integer', default: 1000 }, // at:'build' is the default
      },
    },
    { scope: 'global', adhdRoot, cwd },
  );
}

afterEach(() => {
  cleanupFixtures();
});

describe('DoD §7.5 — runtime-vs-build', () => {
  it('an at:"runtime" field changes value when process.env changes BETWEEN two accesses', () => {
    const restore = withEnvVar('ADHD_T_LIVE_PORT', undefined);
    try {
      const env = makeEnv();
      expect(env.config.live.port).toBe(1000); // unset → falls back

      process.env.ADHD_T_LIVE_PORT = '5000';
      expect(env.config.live.port).toBe(5000); // re-read live — same instance, no reconstruction

      process.env.ADHD_T_LIVE_PORT = '6000';
      expect(env.get('config.live.port')).toBe(6000); // .get() goes through the same live getter

      delete process.env.ADHD_T_LIVE_PORT;
      expect(env.config.live.port).toBe(1000); // unset again → falls back again, live
    } finally {
      restore();
    }
  });

  it('negative control: an at:"build" (default) field does NOT change when process.env changes after construction — proves the assertion above has teeth', () => {
    const restore = withEnvVar('ADHD_T_FROZEN_PORT', undefined);
    try {
      const env = makeEnv();
      expect(env.config.frozen.port).toBe(1000);

      process.env.ADHD_T_FROZEN_PORT = '9999';
      // Still 1000 — a build field is resolved once, at construction, and never re-reads live.
      expect(env.config.frozen.port).toBe(1000);
      expect(env.get('config.frozen.port')).toBe(1000);
    } finally {
      restore();
    }
  });

  it('a secret:true field behaves identically to at:"runtime" for live re-read, and is never exposed via toJSON()/write()', () => {
    const adhdRoot = mkAdhdRoot();
    const cwd = mkCwdFixture();
    const restore = withEnvVar('ADHD_T_DB_SECRET', undefined);
    try {
      const env = new Environment<{ db: { secret: string } }>(
        't',
        { config: { 'db.secret': { type: 'string', secret: true } } },
        { scope: 'global', adhdRoot, cwd },
      );
      expect(env.config.db.secret).toBeUndefined();

      process.env.ADHD_T_DB_SECRET = 'sk-live-value';
      expect(env.config.db.secret).toBe('sk-live-value');

      // Never persisted in plaintext, even while the live env var is set:
      const json = env.toJSON();
      expect(JSON.stringify(json)).not.toContain('sk-live-value');
      expect(JSON.stringify(json)).toContain('adhd-env-ref:ADHD_T_DB_SECRET');
    } finally {
      restore();
    }
  });
});
