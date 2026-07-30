/**
 * server.published-layout.spec.ts — regression test for the real,
 * npm-registry-reproduced publish bug: `@adhd/backlog@0.1.0` installed from
 * npm crashed at mount with
 *   `Error: @adhd/backlog: cannot mount — .../node_modules/@adhd/dist/client.d.ts
 *   does not exist. Run "nx build backlog" first …`
 *
 * ROOT CAUSE: `@adhd/nx-build`'s `dist-manifest`/`publish` executors run
 * `npm publish <distDir>` (`tools/nx-plugins/build/executors/publish/impl.js`)
 * — the CONTENTS of `{projectRoot}/dist` are packed as the package ROOT, not
 * as a `dist/` subdirectory. So once installed, `index.js` and `client.d.ts`
 * are SIBLINGS at the package root (`node_modules/@adhd/backlog/index.js`,
 * `.../client.d.ts`) — there is no `dist/` folder at all. `server.ts`'s old
 * `backlogDistDir()` unconditionally computed `join(dirname(import.meta.url),
 * '..', 'dist')`, which is correct for the in-repo dev-built layout
 * (`dist/index.js` -> `../dist` round-trips to `dist/`) and for vitest
 * (`src/server.ts` -> `../dist` reaches the real `dist/`), but for the
 * PUBLISHED layout it escapes one level too far past the package root into
 * a nonexistent `node_modules/@adhd/dist`.
 *
 * This test reproduces exactly that published, rebased-to-root layout in a
 * throwaway directory (flattening `dist/*` to the directory root — the same
 * transform `npm publish <distDir>` performs) and spawns the real built bin
 * from inside it, proving `extractClientOperations()` (via
 * `buildBacklogApigenPackage` <- `runBacklogCli`'s `--help` path) finds
 * `client.d.ts` and mounts successfully instead of crashing.
 *
 * `--help` is used as the invocation because `runBacklogCli` (`cli.ts`) only
 * special-cases `install-skill`/`serve` BEFORE calling
 * `buildBacklogApigenPackage()` — every other argv, including `--help` and
 * no-args, still goes through `buildBacklogApigenPackage()` ->
 * `extractClientOperations()` -> `backlogDistDir()`, so `--help` genuinely
 * exercises the exact mount path that crashed on the real npm install.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const DIST_DIR = join(PKG_ROOT, 'dist');

// Per-repo convention (AGENTS.md §10): ephemeral test artifacts live under
// `tmp/<package>/…`, never scattered or repo-root, and are cleaned up on
// teardown.
const TMP_ROOT = join(PKG_ROOT, 'tmp', 'backlog');

describe('backlog published (rebased-to-root) layout — real npm-install-shape mount', () => {
  let publishedRoot: string | undefined;

  afterEach(() => {
    if (publishedRoot) rmSync(publishedRoot, { recursive: true, force: true });
    publishedRoot = undefined;
  });

  it('mounts via the built bin when index.js and client.d.ts are siblings at the package root (npm publish <distDir> shape)', () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    publishedRoot = mkdtempSync(join(TMP_ROOT, 'published-layout-'));

    // Reproduce EXACTLY what `npm publish <distDir>` ships: the CONTENTS of
    // `dist/` flattened directly into the package root — no `dist/`
    // subdirectory survives. `writeDistManifest` (generate-manifest.js)
    // additionally rebases `dist/package.json`'s own `main`/`bin` paths
    // (`./dist/index.js` -> `./index.js`), but this test only needs the
    // REAL failure mode reproduced: `client.d.ts` sitting next to `index.js`
    // at the directory `server.ts`'s mount code resolves from — the rebased
    // manifest's `main`/`bin` fields are irrelevant here since the bin is
    // invoked by explicit path (`node <root>/index.js`), not via `require()`
    // of the package name.
    for (const entry of readdirSync(DIST_DIR)) {
      cpSync(join(DIST_DIR, entry), join(publishedRoot, entry), { recursive: true });
    }

    const indexJs = join(publishedRoot, 'index.js');
    const result = spawnSync(process.execPath, [indexJs, '--help'], {
      cwd: publishedRoot,
      env: { ...process.env, ADHD_BACKLOG_SCOPE: 'project' },
      encoding: 'utf8',
      timeout: 30_000,
    });

    if (result.error) {
      throw new Error(`spawn failed for ${indexJs} --help: ${String(result.error)}`);
    }

    // The real, reproduced bug: a "cannot mount" error naming the WRONG,
    // escaped-past-root path. Assert it is categorically absent — not just
    // that SOME output happened — so a regression that mounts to the wrong
    // (but still-existing) path can't slip past a weaker substring check.
    expect(result.stderr).not.toMatch(/cannot mount/);
    expect(result.stderr).not.toMatch(/client\.d\.ts does not exist/);
    // Reaches the cli-output plugin's usage listing (mount + extraction
    // succeeded) and exits cleanly.
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/backlog create-item/);
    expect(result.stdout).toMatch(/backlog get-item/);
  }, 30_000);
});
