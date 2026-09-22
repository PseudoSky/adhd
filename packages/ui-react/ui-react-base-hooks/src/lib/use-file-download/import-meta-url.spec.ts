/**
 * Browser bundle acceptance spec — state `browser-cjs-umd-repair`.
 *
 * WHY IT READS `dist/` AND NOT THE SOURCE. The defect is created by the
 * bundler: Rolldown lowers `import.meta.url` to the literal token `{}.url` in a
 * browser-platform cjs/umd chunk. A source-level unit test would exercise the
 * source (where `import.meta.url` is valid) and pass while the shipped artifact
 * is broken. So this spec asserts against the built bundles — the exact bytes a
 * CommonJS/UMD consumer receives.
 *
 * The build must have run first (`nx build ui-react-base-hooks`); if `dist/` is
 * absent the reads below throw ENOENT and the suite fails loudly rather than
 * skipping.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
/** `packages/ui-react/ui-react-base-hooks/dist`. */
const DIST = path.resolve(here, '../../../dist');

/** Repo-relative labels for the three published bundles, greppable in a diff. */
const CJS_BUNDLE = 'dist/index.js';
const UMD_BUNDLE = 'dist/index.umd.js';
const ESM_BUNDLE = 'dist/index.mjs';

const read = (label: string): string =>
  readFileSync(path.join(DIST, path.basename(label)), 'utf8');

/** Rolldown's browser-platform lowering of `import.meta.url`. */
const EMPTY_IMPORT_META_URL = '{}.url';

describe('ui-react-base-hooks browser bundles (built artifacts)', () => {
  it('reads a real build output — absent dist must fail, not skip', () => {
    expect(() => read(CJS_BUNDLE)).not.toThrow();
    expect(() => read(UMD_BUNDLE)).not.toThrow();
    expect(() => read(ESM_BUNDLE)).not.toThrow();
  });

  for (const label of [CJS_BUNDLE, UMD_BUNDLE]) {
    describe(label, () => {
      it('carries no Rolldown empty-import-meta token', () => {
        expect(read(label)).not.toContain(EMPTY_IMPORT_META_URL);
      });

      it('carries no node-only shim (require/__filename are absent in a browser)', () => {
        const code = read(label);
        expect(code).not.toContain('__filename');
        expect(code).not.toContain('node:url');
      });
    });
  }

  it(`${ESM_BUNDLE} keeps native import.meta.url and takes no CJS shim`, () => {
    const code = read(ESM_BUNDLE);
    expect(code).toContain('import.meta.url');
    expect(code).not.toContain('pathToFileURL(__filename)');
    expect(code).not.toContain(EMPTY_IMPORT_META_URL);
  });
});
