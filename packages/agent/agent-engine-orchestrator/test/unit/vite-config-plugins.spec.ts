import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Backlog 50b77657 — `vite.config.ts` declared `plugins:` TWICE in the same
 * object literal. JavaScript keeps only the LAST value for a duplicate object
 * key, so the first array (`importMetaUrlCjs()` + `nxViteTsPaths()`) was
 * silently discarded and `import.meta.url` was never restored in the CJS
 * output. The sibling packages (`agent-base-types/vite.config.ts`) use ONE
 * array; the two-line form was an editing accident.
 *
 * This is the LOCAL, per-config assertion for agent-engine-orchestrator. The
 * REPO-WIDE, affected-INDEPENDENT sweep of EVERY workspace `vite.config.ts` and
 * generator `vite.config.ts__tmpl__` lives in
 * `tools/nx-plugins/test/executors/wiring/check-vite-config-plugins.mjs` and is
 * invoked unconditionally by `check-lane-reachability.mjs` (pre-push hook + both
 * CI workflows). It MOVED there (backlog 47557842): a whole-workspace invariant
 * must not be gated on this one project's nx-affected membership — a duplicate
 * key reintroduced in an unrelated package affected that package and its
 * dependents, never the orchestrator, so `nx affected -t test` never ran the
 * sweep.
 */
const viteConfigSource = readFileSync(
  fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
  'utf8'
);

describe('vite.config.ts — single plugins array (50b77657)', () => {
  it('declares exactly ONE `plugins:` property (a duplicate key silently drops all but the last)', () => {
    const pluginsKeys = viteConfigSource.match(/^\s*plugins\s*:/gm) ?? [];
    expect(pluginsKeys).toHaveLength(1);
  });

  it('keeps all three plugins in that one array: importMetaUrlCjs + nxViteTsPaths + nxViteTsPathsPre', () => {
    const arrayLine = viteConfigSource.match(/^\s*plugins\s*:.*$/m)?.[0] ?? '';
    expect(arrayLine).toContain('importMetaUrlCjs()');
    expect(arrayLine).toContain('nxViteTsPaths()');
    expect(arrayLine).toContain('nxViteTsPathsPre()');
  });
});
