/**
 * dist-artifact-smoke.spec.ts — review 663d463c /
 * BUG-APIGEN-CORE-CLIENT-ESM-REQUIRE-001.
 *
 * The S-20 lazy-load refactor left bare `require(...)` calls in the source
 * that Rollup emitted verbatim into `dist/index.mjs`. ESM has no `require`
 * binding, so every newly-gated path (`collectLocalImportPaths` →
 * `syntacticResolverProject` → `getProjectCtor`, and the `getScopeEnum` /
 * `getSyntaxKindEnum` / `getTsjsg` getters) threw
 * `ReferenceError: require is not defined` for a real ESM consumer — while
 * every in-repo test stayed green, because tests resolve SOURCE through the
 * CJS/tsconfig-paths loader and never load the shipped `.mjs`.
 *
 * This spec closes that hole: it loads the REAL built artifact in a fresh
 * `node` child process (native ESM loader — see `DRIVER_SOURCE` for why not
 * in-process) and CALLS public exports through it. The `test` target depends
 * on `build`, so `dist/` is always present and fresh when this runs.
 *
 * Teeth: a negative-control case runs the same driver against a synthetic
 * `.mjs` containing a bare top-level `require('ts-morph')` and asserts the
 * driver reports a `ReferenceError` — proving the harness would go red if the
 * defect were reintroduced. (This is the exact failure the reviewer observed
 * on the pre-fix artifact.)
 *
 * Cleanup: the generated driver + negative-control scratch live under
 * `tmp/apigen-core-client/` and are removed in `afterAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const DIST_ESM_ENTRY = path.resolve(HERE, '..', '..', 'dist', 'index.mjs');
const FIXTURE = path.resolve(HERE, 'fixtures', 'extract-named-fn.ts');
const RESULT_MARKER = '__SMOKE_RESULT__';

/**
 * The child-process driver, written to `tmp/` at run time rather than
 * committed: it is ESM (top-level `await`), and this package's ESLint config
 * maps no override to `*.mjs`, so a committed `.mjs` would be parsed as a
 * script and fail lint. Keeping it as a string here also keeps it in lockstep
 * with the assertions below.
 *
 * WHY A CHILD PROCESS: the whole point is to load the SHIPPED `dist/index.mjs`
 * the way a real ESM consumer does — through Node's native ESM loader. Loading
 * it inside vitest would go through vite-node's transform pipeline (which
 * rewrites `import.meta.url` and can mask exactly this bug class). The child is
 * the same honest observer `verify-dist-load` and the reviewer's live check
 * use.
 */
const DRIVER_SOURCE = String.raw`
import { pathToFileURL } from 'node:url';
const MARKER = '__SMOKE_RESULT__';
const entry = process.env.SMOKE_ENTRY;
const fixture = process.env.SMOKE_FIXTURE;
function emit(payload) {
  process.stdout.write('\n' + MARKER + JSON.stringify(payload) + '\n');
  process.exit(0);
}
try {
  const mod = await import(pathToFileURL(entry).href);
  const paths = mod.collectLocalImportPaths(fixture);
  const ops = await mod.extract({ sourceFile: fixture });
  emit({
    ok: true,
    hasCollectLocalImportPaths: typeof mod.collectLocalImportPaths === 'function',
    paths,
    opIds: ops.map((op) => op.id),
  });
} catch (err) {
  emit({ ok: false, error: { name: err && err.name, message: err && err.message } });
}
`;

interface SmokeReport {
  ok: boolean;
  hasCollectLocalImportPaths?: boolean;
  paths?: string[];
  opIds?: string[];
  error?: { name?: string; message?: string };
}

describe('dist ESM artifact: public exports are callable through dist/index.mjs', () => {
  let scratchDir: string;
  let driverPath: string;

  function runDriver(entry: string): { status: number | null; report: SmokeReport } {
    const result = spawnSync(process.execPath, [driverPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        SMOKE_ENTRY: entry,
        SMOKE_FIXTURE: FIXTURE,
      },
    });

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const markerIndex = stdout.lastIndexOf(RESULT_MARKER);
    if (markerIndex === -1) {
      throw new Error(
        'dist-esm-smoke-driver produced no result marker ' +
          `(status=${String(result.status)}, signal=${String(result.signal)}).\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }
    const jsonLine = stdout
      .slice(markerIndex + RESULT_MARKER.length)
      .split('\n', 1)[0];
    return {
      status: result.status,
      report: JSON.parse(jsonLine) as SmokeReport,
    };
  }

  beforeAll(() => {
    if (!fs.existsSync(DIST_ESM_ENTRY)) {
      throw new Error(
        `built ESM entry missing: ${DIST_ESM_ENTRY} — the test target must depend on "build" ` +
          '(see packages/apigen/apigen-core-client/project.json)'
      );
    }
    const scratchParent = path.join(REPO_ROOT, 'tmp', 'apigen-core-client');
    fs.mkdirSync(scratchParent, { recursive: true });
    scratchDir = fs.mkdtempSync(path.join(scratchParent, 'dist-esm-smoke-'));
    driverPath = path.join(scratchDir, 'driver.mjs');
    fs.writeFileSync(driverPath, DRIVER_SOURCE);
  });

  afterAll(() => {
    if (scratchDir) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('calls collectLocalImportPaths (getProjectCtor) + extract (getTsjsg) through dist/index.mjs', () => {
    const { status, report } = runDriver(DIST_ESM_ENTRY);

    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(status).toBe(0);
    expect(report.hasCollectLocalImportPaths).toBe(true);
    expect(report.paths).toContain(FIXTURE);
    expect(report.opIds).toContain('extract-named-fn/get-user');
  });

  it('teeth: a bare `require` in an ESM artifact throws ReferenceError (the pre-fix failure)', () => {
    const brokenEntry = path.join(scratchDir, 'broken-require.mjs');
    fs.writeFileSync(
      brokenEntry,
      "const { Project } = require('ts-morph');\n" +
        'export function make() { return new Project({}); }\n'
    );

    const { report } = runDriver(brokenEntry);

    expect(report.ok).toBe(false);
    expect(report.error?.name).toBe('ReferenceError');
  });
});
