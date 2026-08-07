/**
 * THE key proof for ENV-ADOPT-CLUSTERS(1) / `agent-core-env` migration:
 * merely IMPORTING this package's public barrel must never open or create
 * a database file as a side effect. Before this migration, `db/client.ts`
 * opened `new Database(...)` at MODULE TOP LEVEL against
 * `path.join(os.homedir(), '.adhd', 'agent-core-provider', 'agents.db')` and
 * `index.ts` re-exported it — so `import`ing the package silently
 * materialized a real file under the invoking user's home directory.
 *
 * `os.homedir()` reads `process.env.HOME` (POSIX) synchronously on every
 * call, and this suite's `vite.config.ts` uses `pool: 'forks'` (a real
 * child PROCESS, not a `worker_thread`) — so mutating `process.env.HOME`
 * here IS observed by the native `os.homedir()` lookup, letting this test
 * sandbox the home directory without ever touching the real machine's
 * `~/.adhd/agent-core-provider/agents.db`.
 *
 * See `agent-store-prompts/src/__tests__/import-side-effect.test.ts` for the
 * full rationale + the manual red→green verification note.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('import-time side effect — @adhd/agent-core-provider', () => {
  const originalHome = process.env['HOME'];
  let scratchHome: string | undefined;

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    if (scratchHome) {
      rmSync(scratchHome, { recursive: true, force: true });
      scratchHome = undefined;
    }
    delete process.env['DATABASE_PATH'];
  });

  it('importing the package barrel does not create ~/.adhd/agent-core-provider/agents.db under a sandboxed HOME', async () => {
    scratchHome = mkdtempSync(join(tmpdir(), 'agent-core-provider-home-'));
    process.env['HOME'] = scratchHome;
    delete process.env['DATABASE_PATH'];

    vi.resetModules();
    await import('../index.js');

    expect(existsSync(join(scratchHome, '.adhd'))).toBe(false);
    expect(existsSync(join(scratchHome, '.adhd', 'agent-core-provider', 'agents.db'))).toBe(false);
  });
});
