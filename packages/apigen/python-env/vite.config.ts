/// <reference types='vitest' />
import { defineConfig, type Plugin } from 'vite';
import dts from 'vite-plugin-dts';
import * as fs from 'fs';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';

/**
 * Ship the ENTIRE `packages/apigen/python/` dir (not just the `apigen_python/`
 * subpackage) INTO this package's own dist, at `dist/python/`, so published
 * (npm) consumers of py-grpc/py-flask/conformance resolve everything the
 * runtime actually reads from `resolvePythonPkgDir()`'s co-located candidate:
 *   - `apigen_python/**`      — the importable package (grpc_server.py etc.)
 *   - `pyproject.toml`        — read directly by `ensurePythonEnv()`
 *     (`pyprojectHash()`) AND by the `pip wheel`/`pip install` build step —
 *     BUG-015-REGRESSION: an earlier version of this plugin copied only
 *     `apigen_python/**`, which satisfied a narrow test asserting just
 *     `apigen_python/__init__.py` but broke every real downstream consumer
 *     with `ENOENT …/dist/python/pyproject.toml` (py-flask, py-grpc,
 *     apigen-cli serve.live, apigen-engine-conformance's [Python-pass] gate).
 *   - `apigen_logical.py`, `conformance_vectors.json` — read by the
 *     conformance suite via the same resolved dir.
 *   - `run_tests.py`          — shipped for parity with the source tree.
 * `@nx/vite:build`'s `options.assets` is NOT honoured by this executor
 * version (verified: unrecognized `assets` keys fall through
 * `getBuildExtraArgs` into a bare top-level vite config key that vite/rollup
 * silently ignores — a fresh `nx build` of any sibling package using it
 * confirms zero files land in dist), so the copy is done directly here via a
 * `writeBundle` hook (fires once dist exists, after each output format).
 */
function copyPythonPackagePlugin(): Plugin {
  const srcDir = path.join(__dirname, '..', 'python')
  const destDir = path.join(__dirname, 'dist', 'python')
  const EXCLUDE_DIRS = new Set(['__pycache__', '.pytest_cache', 'build', '.venv'])
  let copied = false

  function shouldSkip(name: string, isDir: boolean): boolean {
    if (isDir) return EXCLUDE_DIRS.has(name) || name.endsWith('.egg-info')
    return name.endsWith('.pyc')
  }

  function copyRecursive(from: string, to: string): void {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (shouldSkip(entry.name, entry.isDirectory())) continue
      const fromPath = path.join(from, entry.name)
      const toPath = path.join(to, entry.name)
      if (entry.isDirectory()) {
        fs.mkdirSync(toPath, { recursive: true })
        copyRecursive(fromPath, toPath)
      } else if (entry.isFile()) {
        fs.mkdirSync(to, { recursive: true })
        fs.copyFileSync(fromPath, toPath)
      }
    }
  }

  return {
    name: 'copy-apigen-python-package',
    writeBundle() {
      if (copied) return // rendered twice (es + cjs formats) — copy once
      fs.rmSync(destDir, { recursive: true, force: true })
      fs.mkdirSync(destDir, { recursive: true })
      copyRecursive(srcDir, destDir)
      copied = true
    },
  }
}

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/apigen/python-env',

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
    copyPythonPackagePlugin(),
  ],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'apigen-python-env',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Node-only package: never bundle node builtins.
      external: [/^node:/],
    },
  },

  test: {
    poolOptions: vitestPoolOptions,
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/apigen/python-env',
      provider: 'v8',
    },
  },
});
