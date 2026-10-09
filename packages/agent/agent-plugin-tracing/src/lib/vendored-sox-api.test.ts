import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BodyCapture,
  DEFAULT_REDACTION_RULES,
  captureBody,
  createLogChannel,
  createRedactor,
  currentLogContext,
  identityRedactor,
  withLogContext,
} from '../index.js';

/**
 * c536ce29 TRC-AC21-a: the vendored (unpublished) @adhd/sox-telemetry log-channel API is reachable
 * through this package's public index, and the channel really redacts what it writes.
 */
describe('c536ce29 TRC-AC21 vendored sox-telemetry log-channel API via the package index', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trc-ac21-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes the 8 runtime symbols', () => {
    const fns = { createLogChannel, createRedactor, captureBody, withLogContext, currentLogContext };
    for (const [name, fn] of Object.entries(fns)) expect(typeof fn, name).toBe('function');
    expect(typeof BodyCapture).toBe('function'); // class
    expect(typeof identityRedactor.redactLine).toBe('function');
    expect(Array.isArray(DEFAULT_REDACTION_RULES)).toBe(true);
    expect(DEFAULT_REDACTION_RULES.length).toBeGreaterThan(0);
  });

  it('createLogChannel writes one redacted record (canary secret absent)', async () => {
    const canary = 'sk-canary-AC21-0123456789abcdef';
    const channel = createLogChannel({ dir, component: 'trc.ac21' });
    channel.registerSecret(canary);
    channel.logEvent('trc.ac21.event', { note: `token=${canary}`, authorization: `Bearer ${canary}` });
    await channel.close();

    const files = readdirSync(dir).filter((f) => f.startsWith('trc.ac21'));
    expect(files.length).toBe(1);
    const lines = readFileSync(join(dir, files[0]), 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain(canary);
    expect(lines[0]).toContain('trc.ac21.event');
  });

  it('withLogContext/currentLogContext round-trip', () => {
    expect(currentLogContext()).toEqual({});
    withLogContext({ session_id: 's1' } as never, () => {
      expect(currentLogContext()).toMatchObject({ session_id: 's1' });
    });
  });
});
