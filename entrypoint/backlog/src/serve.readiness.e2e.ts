/**
 * serve.readiness.e2e.ts — ⟦U1⟧ the readiness probe, driven through the REAL
 * BUILT bin (`node dist/index.js serve --probe …`) against a minted sandbox
 * store. Proves the command exits 0 and reports `state:"ready"` — i.e. the
 * SERVING path answered, not merely that a port was bound.
 *
 * Default-running (the `e2e` lane is wired into `test.dependsOn`); no env gate.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  mintBacklogSandbox,
  runBacklogBin,
  type SandboxHandle,
} from './test/helpers/spawn-backlog-bin.js';

describe('backlog serve --probe — readiness on the real spawned bin', () => {
  let sandbox: SandboxHandle | undefined;
  afterAll(() => {
    if (sandbox) rmSync(sandbox.adhdRoot, { recursive: true, force: true });
    sandbox = undefined;
  });

  it('prints a ready report and exits 0 once the serving path answers', () => {
    sandbox = mintBacklogSandbox();
    const res = runBacklogBin(
      ['serve', '--probe', '--transport', 'http', '--port', '0'],
      { ADHD_ROOT: sandbox.adhdRoot }
    );
    expect(res.status).toBe(0);
    const lastLine = res.stdout.trim().split('\n').pop() ?? '{}';
    const report = JSON.parse(lastLine) as {
      state: string;
      degraded: boolean;
    };
    expect(report.state).toBe('ready');
    expect(report.degraded).toBe(false);
  });
});
