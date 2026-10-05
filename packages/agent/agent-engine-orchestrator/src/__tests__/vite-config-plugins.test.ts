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
 * This asserts the SINGLE-array shape directly. It fails if the duplicate key
 * is reintroduced (two matches) or if any of the three intended plugins is
 * dropped from the array.
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
