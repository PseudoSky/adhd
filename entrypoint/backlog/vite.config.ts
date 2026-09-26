/// <reference types='vitest' />
import { defineConfig, type Plugin } from 'vite';
import dts from 'vite-plugin-dts';
import * as fs from 'fs';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { importMetaUrlCjs } from '../../tools/vite-plugins/import-meta-url-cjs.mjs';
import { nxViteTsPathsPre } from '../../tools/vite-plugins/source-resolution.mjs';
import { projectCacheDir, projectCoverage } from '../../packages/workspace/workspace-base-vite-paths/src/index';
import { externalizeRealDeps } from '../../tools/vite-plugins/externalize.mjs';

const repoRoot = path.resolve(__dirname, '../..');

/**
 * BUG-013 FIX A: ship `skill/SKILL.md` INTO this package's own `dist/`, so
 * `install-skill.ts`'s `packagedSkillMdPath()` finds it in BOTH the
 * published (`npm publish <distDir>` rebased-to-root) layout and the local
 * dev-built layout. `@nx/vite:build`'s `options.assets` is NOT honoured by
 * this executor version — confirmed directly against `build.impl.js`, which
 * never reads `options.assets` at all (an unrecognized top-level vite key
 * that rollup silently drops); a fresh `nx build backlog` with that option
 * set copies zero files. Mirrors `packages/apigen/python-env/vite.config.ts`'s
 * proven `writeBundle`-hook copy plugin for the identical reason (its own
 * `apigen_python` sources), so `dist/skill/SKILL.md` exists after a BARE
 * `nx build backlog` alone — no separate `nx run backlog:assets` step
 * required for this file specifically (that target still separately ships
 * README.md/CHANGELOG.md via `package.json`'s own `"assets"` array, which
 * ALSO lists `"skill"` as a belt-and-suspenders duplicate — harmless,
 * idempotent re-copy — in case a future refactor of this plugin regresses).
 */
function copySkillDirPlugin(): Plugin {
  const srcDir = path.join(__dirname, 'skill');
  const destDir = path.join(__dirname, 'dist', 'skill');
  let copied = false;

  function copyRecursive(from: string, to: string): void {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(toPath, { recursive: true });
        copyRecursive(fromPath, toPath);
      } else if (entry.isFile()) {
        fs.mkdirSync(to, { recursive: true });
        fs.copyFileSync(fromPath, toPath);
      }
    }
  }

  return {
    name: 'copy-backlog-skill-dir',
    writeBundle() {
      if (copied) return; // rendered twice (es + cjs formats) — copy once
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.mkdirSync(destDir, { recursive: true });
      copyRecursive(srcDir, destDir);
      copied = true;
    },
  };
}

export default defineConfig({
  root: __dirname,
  cacheDir: projectCacheDir(__dirname),

  plugins: [
    importMetaUrlCjs(),
    nxViteTsPaths(),
    nxViteTsPathsPre(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
      // src/test/** holds test-support (fixtures + the real-server-spawn
      // harness) that lacks a .spec/.test suffix, so tsconfig.lib.json's
      // *.spec/*.test excludes miss them — never ship test .d.ts.
      // `*.e2e.ts` is excluded too: those are the resource-consuming specs
      // extracted out of the default `test` target (see the sibling `*.spec.ts`
      // stubs) and must never reach dist/ or its declarations.
      exclude: ['src/test/**', 'src/**/*.e2e.ts'],
    }),
    copySkillDirPlugin(),
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
      name: 'backlog',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      // Bundle only @adhd/* workspace source (no workspace node_modules
      // symlinks in this repo — see externalize.mjs's doc comment);
      // externalize every real npm dependency (@tursodatabase/database —
      // the turso store substrate's native module, which must never be
      // bundled — plus fastify, the MCP SDK,
      // ts-morph/typescript transitively via apigen-core-client, and
      // `@adhd/sox-graph-store`, the first externally-published npm package
      // in this monorepo to also carry the `@adhd/` scope) + every Node
      // builtin. See BACKLOG.md INVESTIGATION-BUILD-TOOL-001 and this
      // package's DESIGN.md §10.
      external: externalizeRealDeps(__dirname),
      output: {
        // Real executable: node shebang on the built entry, matching
        // `entrypoint/apigen-cli`'s proven `bin` mechanism (its
        // `vite.config.ts` uses the identical banner). Harmless for the
        // library-import path (`require('@adhd/backlog')` /
        // `require(distIndexPath)`, e.g. `src/test/fixtures/mcp-stdio-
        // entry.js`) — Node's module loader strips a leading `#!` line for
        // ANY `.js`/`.mjs` file it compiles, not only the process's main
        // module.
        banner: '#!/usr/bin/env node',
        // BAKE-AT-BUILD (design doc Revision 3): `src/index.ts` now contains a
        // DYNAMIC `import('./extract-live.js')` (the fallback path). Left
        // alone, rollup CODE-SPLITS the entry into a facade `index.js` that
        // merely re-exports a shared `index-<hash>.js` chunk — and the bin
        // entry-guard (`import.meta.url === pathToFileURL(realpathSync(
        // process.argv[1])).href`) lands in that CHUNK, where `import.meta.url`
        // resolves to `index-<hash>.js`, never the invoked `index.js`, so the
        // guard stops matching and the CLI silently does nothing (measured:
        // `node dist/index.js ir-artifact …` exited 0 and wrote no artifact).
        // `inlineDynamicImports` keeps every format a SINGLE file — the shape
        // this package already shipped — so the guard lives in `index.js`. The
        // dynamic import still defers `extract-live`'s module evaluation until
        // the fallback actually runs; ts-morph stays lazily required, so the
        // baked startup path never loads it.
        inlineDynamicImports: true,
      },
    },
  },

  test: {
    globals: true,
    cache: {
      dir: path.join(repoRoot, 'node_modules/.vitest'),
    },
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    // `*.spec.ts` ONLY — never `*.e2e.ts`. The resource-consuming suites (real
    // subprocess spawns, the real fastembed embedding model, real HTTP servers
    // bound to ports) were extracted out of this default target into sibling
    // `*.e2e.ts` files (see their `*.spec.ts` stubs); those must never run
    // under `nx affected -t test` or the pre-commit/pre-push hooks. This project
    // has exclusively `*.spec.ts` test files, so narrowing the glob is
    // behaviour-preserving and makes the `.e2e.ts` exclusion structural rather
    // than an emergent property of glob semantics.
    include: ['src/**/*.spec.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,

    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
