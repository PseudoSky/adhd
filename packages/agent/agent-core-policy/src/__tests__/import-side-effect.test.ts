/**
 * THE key proof for ENV-ADOPT-CLUSTERS(1) / `agent-core-env` migration:
 * merely IMPORTING this package's public barrel must never open or create
 * a database file as a side effect. Before this migration, `db/client.ts`
 * opened `new Database(...)` at MODULE TOP LEVEL and `index.ts` re-exported
 * it — so `import`ing the package (which `entrypoint/agent-mcp` does at
 * boot) silently materialized `<cwd>/data/registry.db` on disk.
 *
 * See `agent-store-prompts/src/__tests__/import-side-effect.test.ts` for the
 * full rationale + the manual red→green verification note.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('import-time side effect — @adhd/agent-core-policy', () => {
  const originalCwd = process.cwd();
  let scratchCwd: string | undefined;

  afterEach(() => {
    process.chdir(originalCwd);
    if (scratchCwd) {
      rmSync(scratchCwd, { recursive: true, force: true });
      scratchCwd = undefined;
    }
    delete process.env['DATABASE_PATH'];
  });

  it('importing the package barrel does not create ./data/registry.db (or ./data/ at all) in the invoking cwd', async () => {
    scratchCwd = mkdtempSync(join(tmpdir(), 'agent-core-policy-import-'));
    process.chdir(scratchCwd);
    delete process.env['DATABASE_PATH'];

    vi.resetModules();
    await import('../index.js');

    expect(existsSync(join(scratchCwd, 'data'))).toBe(false);
    expect(existsSync(join(scratchCwd, 'data', 'registry.db'))).toBe(false);
  });
});
