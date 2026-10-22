/**
 * guards: `adhd-policy run` dispatches the argv operation outside the traced Layer stack (no span for an allowed command, or none for a refusal), loses the exit-code contract on the new createPackageInvoker/dispatchForPlan path (refusal 3, invalid argument 2, the child's own code otherwise), or starts a refused command.
 * tier: S
 * cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R9 (scenario "policy run refuses a denied command"), §3 R9 behaviour change 1 ("same exit codes; now traced")
 * red-run: 2026-10-21 control: gate.ts without tracingPlugin -> 2 failed (allowed span test, refusal span test).
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeLauncher } from '../helpers/fake-launcher';
import { capturedDeps } from '../helpers/run-deps';
import { withTmpDir } from '../helpers/tmp';

vi.setConfig({ testTimeout: 60_000 });

const POLICY = `version: 1
permissions:
  - tool: bin/touch
  - tool: bin/rm
    effect: deny
`;

interface ISpanRecord {
  readonly event: string;
  readonly 'adhd-policy.op'?: string;
  readonly 'adhd-policy.transport'?: string;
  readonly level?: string;
}

describe('adhd-policy run - traced, same exit codes', () => {
  const previous = process.env['SOX_ECOSYSTEM_HOME'];
  let tracedRun: typeof import('../../wrapper/verbs/run').runVerb;
  let scratch: string | undefined;
  let release: (() => void) | undefined;
  let finished: Promise<void> | undefined;
  let logsDir = '';

  // One telemetry init for the file (it is per process); the directory lives as long as the describe block.
  beforeAll(async () => {
    const held = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve, reject) => {
      finished = withTmpDir('t-r9-trace', async (dir) => {
        scratch = dir;
        process.env['SOX_ECOSYSTEM_HOME'] = join(dir, 'sox');
        logsDir = join(dir, 'sox', 'policy', 'logs');
        await writeFile(join(dir, 'policy.yaml'), POLICY);
        const { initPolicyTelemetry } = await import('../../wrapper/telemetry');
        initPolicyTelemetry('cli');
        tracedRun = (await import('../../wrapper/verbs/run')).runVerb;
        resolve();
        await held;
      });
      finished.catch(reject);
    });
    await ready;
  });
  afterAll(async () => {
    release?.();
    await finished; // the scratch directory is removed before the worker ends
    if (previous === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
    else process.env['SOX_ECOSYSTEM_HOME'] = previous;
  });

  async function spans(): Promise<ISpanRecord[]> {
    const files = (await readdir(logsDir).catch(() => [] as string[])).filter((name) => name.endsWith('.jsonl') && !name.includes('metrics'));
    const lines = (await Promise.all(files.map((name) => readFile(join(logsDir, name), 'utf8')))).join('\n').split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line) as ISpanRecord).filter((record) => record.event.startsWith('adhd-policy.'));
  }

  async function run(argv: string[]): Promise<{ code: number; stderr: string; started: number }> {
    const launcher = createFakeLauncher();
    const captured = capturedDeps({ cwd: scratch as string, launcher });
    const split = argv.indexOf('--') < 0 ? argv.length : argv.indexOf('--');
    const code = await tracedRun([...argv.slice(0, split), '--spec', join(scratch as string, 'policy.yaml'), ...argv.slice(split)], captured.deps);
    return { code, stderr: captured.stderr.join(''), started: launcher.started.length };
  }

  it('an allowed command runs with the child exit code and leaves a start and a finish span for bin/touch on the cli transport', async () => {
    const before = (await spans()).length;
    const result = await run(['bin:touch', '--', 'file']);
    expect(result).toMatchObject({ code: 0, started: 1 });
    const added = (await spans()).slice(before);
    expect(added.map((record) => record.event)).toEqual(['adhd-policy.bin/touch.start', 'adhd-policy.bin/touch.finish']);
    expect(added.every((record) => record['adhd-policy.op'] === 'bin/touch' && record['adhd-policy.transport'] === 'cli')).toBe(true);
  });

  it('a refused command exits 3 with the reason on stderr, never starts, and is still traced (the tracing Layer is outermost)', async () => {
    const before = (await spans()).length;
    const result = await run(['bin:rm', '--', '-rf', 'tmp']);
    expect(result.code).toBe(3);
    expect(result.started).toBe(0);
    expect(result.stderr).toContain('denied by permission');
    const added = (await spans()).slice(before);
    expect(added.some((record) => record['adhd-policy.op'] === 'bin/rm')).toBe(true);
  });

  it('a bad invocation is exit 2 and traces nothing for it', async () => {
    const before = (await spans()).length;
    const result = await run(['bin:touch', '--name', 'x']);
    expect(result.code).toBe(2);
    expect(result.started).toBe(0);
    expect((await spans()).length).toBe(before);
  });
});
