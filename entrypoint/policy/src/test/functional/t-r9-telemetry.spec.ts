/**
 * guards: the D-24 telemetry switch is misparsed (a typo silently leaves telemetry on, or a disabling spelling is ignored), the 100 MB rotation default is lost, telemetry is not written by default, or it is still written when disabled by configuration.
 * tier: S
 * cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R9 (telemetry scenarios), §3 R9 behaviour change 4 (D-24); wrapper/telemetry.ts
 * not-covered: the 14-day retention and the owner-only 0600 file mode are NOT applied by wrapper/telemetry.ts (documented there: @adhd/sox-telemetry 0.4.3 initTelemetry forwards neither knob), so no test asserts them; they are reported as an open gap.
 * red-run: 2026-10-21 control: telemetryConfigFromEnv returning `{ enabled: true }` for disabling spellings -> 8 failed (every disabling spelling and the disabled-writes-nothing test).
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isApiError } from '@adhd/apigen-base-errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TELEMETRY_ENV_VAR,
  TELEMETRY_MAX_FILE_BYTES,
  TELEMETRY_RETENTION_DAYS,
  telemetryConfigFromEnv,
} from '../../wrapper/telemetry';
import { withTmpDir } from '../helpers/tmp';

vi.setConfig({ testTimeout: 60_000 });

describe('telemetryConfigFromEnv - the on/off switch', () => {
  for (const value of ['off', '0', 'false', 'no', 'OFF', 'False', ' no ']) {
    it(`"${value}" disables telemetry`, () => {
      expect(telemetryConfigFromEnv({ [TELEMETRY_ENV_VAR]: value })).toEqual({ enabled: false });
    });
  }

  for (const value of [undefined, '', '   ', 'on', '1', 'true', 'yes', 'ON', 'Yes']) {
    it(`${JSON.stringify(value)} keeps telemetry on`, () => {
      expect(telemetryConfigFromEnv({ [TELEMETRY_ENV_VAR]: value })).toEqual({ enabled: true });
    });
  }

  for (const value of ['maybe', 'of', 'nope', '2', 'disable', 'false!']) {
    it(`${JSON.stringify(value)} is invalid_argument naming the variable, never a silent default`, () => {
      let thrown: unknown;
      try {
        telemetryConfigFromEnv({ [TELEMETRY_ENV_VAR]: value });
      } catch (error) {
        thrown = error;
      }
      expect(isApiError(thrown) && thrown.code).toBe('invalid_argument');
      expect((thrown as Error).message).toContain(TELEMETRY_ENV_VAR);
    });
  }

  it('the defaults are a 100 MB rotation threshold and 14 days of retention (D-24)', () => {
    expect(TELEMETRY_MAX_FILE_BYTES).toBe(100 * 1024 * 1024);
    expect(TELEMETRY_RETENTION_DAYS).toBe(14);
  });
});

describe('telemetry through the command line', () => {
  const previousHome = process.env['SOX_ECOSYSTEM_HOME'];
  afterEach(() => {
    if (previousHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
    else process.env['SOX_ECOSYSTEM_HOME'] = previousHome;
  });

  /** Runs `verify` in a freshly loaded copy of the CLI against a fresh ecosystem home; returns the exit code and the log files it left. */
  async function runVerify(dir: string, env: Record<string, string>): Promise<{ exitCode: number; stderr: string; logs: string[] }> {
    const home = join(dir, `sox-${Object.keys(env).length}-${env[TELEMETRY_ENV_VAR] ?? 'default'}`);
    process.env['SOX_ECOSYSTEM_HOME'] = home;
    vi.resetModules();
    const { runCli } = await import('../helpers/capture');
    const result = await runCli(['verify'], { cwd: dir, home: dir, env });
    const logs = await readdir(join(home, 'policy', 'logs')).catch(() => [] as string[]);
    return { exitCode: result.exitCode, stderr: result.stderr, logs };
  }

  it('by default a telemetry log is written; disabled by configuration, a fresh home gets none', async () => {
    await withTmpDir('t-r9-telemetry', async (dir) => {
      const on = await runVerify(dir, {});
      expect(on.exitCode).toBe(0);
      expect(on.logs.some((name) => name.endsWith('.jsonl'))).toBe(true);
      const off = await runVerify(dir, { [TELEMETRY_ENV_VAR]: 'off' });
      expect(off.exitCode).toBe(0);
      expect(off.logs).toEqual([]);
    });
  });

  it('an invalid switch value stops the command with exit 2 naming the variable and leaves no log behind', async () => {
    await withTmpDir('t-r9-telemetry-bad', async (dir) => {
      const bad = await runVerify(dir, { [TELEMETRY_ENV_VAR]: 'maybe' });
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain(TELEMETRY_ENV_VAR);
      expect(bad.logs).toEqual([]);
    });
  });
});
