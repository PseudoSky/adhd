/**
 * audit-tracing-healthy.e2e.test.ts — c536ce29 FIX-M1.
 *
 * `scripts/audit_tracing.py` is a Python subprocess, so it is driven from the e2e lane
 * (docs/decisions/0009-test-lanes-unit-vs-e2e.md). A HEALTHY sink — a run that completed normally —
 * never contains provider-failure / budget / HITL / permission spans; the default audit must exit 0
 * on it. `--require-all` is the strict mode that still demands every declared path.
 *
 * a2a9c6db AC4: the engine emits `agent.task.startup` exactly once per task, so it is an always-expected
 * path: a sink of a completed run without it fails the default audit.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'audit_tracing.py');

const rec = (event: string, duration_ms?: number): string =>
  JSON.stringify(duration_ms === undefined ? { event } : { event, duration_ms });

describe('audit_tracing.py on a healthy run (c536ce29 FIX-M1)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-healthy-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: string[]) => spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
  const writeSink = (name: string, events: string[]): string => {
    const d = path.join(dir, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'sink.jsonl'), events.join('\n') + '\n');
    return d;
  };

  const healthy = [
    rec('agent.session.start'),
    rec('agent.task.start'),
    rec('agent.task.startup.start'),
    rec('agent.task.startup.finish', 0),
    rec('agent.model_call.start'),
    rec('agent.model_call.finish', 12),
    rec('agent.task.finish', 20),
    rec('agent.session.finish', 30),
  ];

  it('exits 0 with default args when only conditional paths have zero samples', () => {
    const sink = writeSink('healthy', healthy);
    const r = run(sink);
    expect(r.status, r.stderr).toBe(0);
  });

  it('--require-all still fails on the same sink and names a conditional path', () => {
    const sink = writeSink('healthy-strict', healthy);
    const r = run(sink, '--require-all');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('agent.provider.attempt_failed');
  });

  it('still fails (teeth) when an always-expected path is missing', () => {
    const sink = writeSink('dead-model-call', healthy.filter((l) => !l.includes('model_call')));
    const r = run(sink);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('agent.model_call');
  });

  it('a2a9c6db AC4: fails (teeth) by default when agent.task.startup never fired, naming it', () => {
    const sink = writeSink('no-startup', healthy.filter((l) => !l.includes('agent.task.startup')));
    const r = run(sink);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('agent.task.startup');
  });

  it('a2a9c6db AC4: the same sink passes once agent.task.startup is present (the control for the case above)', () => {
    const sink = writeSink('with-startup', healthy);
    const r = run(sink);
    expect(r.status, r.stderr).toBe(0);
  });
});
