/**
 * THE key proof for ENV-ADOPT-CLUSTERS(1) / `agent-core-env` migration:
 * merely IMPORTING this package's public barrel must never open or create
 * a database file as a side effect. Before this migration, `db/client.ts`
 * opened `new Database(...)` at MODULE TOP LEVEL and `index.ts` re-exported
 * it — so `import`ing the package (which `entrypoint/agent-mcp` does at
 * boot) silently materialized `<cwd>/data/registry.db` on disk.
 *
 * Uses `vi.resetModules()` + a fresh scratch `process.cwd()` so the dynamic
 * `import()` below genuinely re-executes every module-top-level statement
 * (including any transitively-imported `./db/client.js`, if one were ever
 * reintroduced) rather than hitting vitest's module cache.
 *
 * Red→green proof performed manually during implementation (not committed):
 * temporarily restoring the deleted `db/client.ts`'s module-scope
 * `new Database(...)` + its `index.ts` re-export reproduces the file and
 * turns this exact test RED; deleting it again (the shipped state) turns
 * it GREEN. See DESIGN.md Decision 5/Decision 6.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('import-time side effect — @adhd/agent-store-prompts', () => {
  const originalCwd = process.cwd();
  let scratchCwd: string | undefined;

  afterEach(() => {
    process.chdir(originalCwd);
    if (scratchCwd) {
      rmSync(scratchCwd, { recursive: true, force: true });
      scratchCwd = undefined;
    }
    delete process.env['DATABASE_PATH'];
    delete process.env['REGISTRY_DATABASE_PATH'];
  });

  it('importing the package barrel does not create ./data/registry.db (or ./data/ at all) in the invoking cwd', async () => {
    scratchCwd = mkdtempSync(join(tmpdir(), 'agent-store-prompts-import-'));
    process.chdir(scratchCwd);
    delete process.env['DATABASE_PATH'];
    delete process.env['REGISTRY_DATABASE_PATH'];

    vi.resetModules();
    await import('../index.js');

    expect(existsSync(join(scratchCwd, 'data'))).toBe(false);
    expect(existsSync(join(scratchCwd, 'data', 'registry.db'))).toBe(false);
  });
});
