/// <reference types='vitest' />
import { defineConfig, type Plugin } from 'vite';
import dts from 'vite-plugin-dts';
import * as fs from 'fs';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
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
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
      // src/test/** holds test-support (fixtures + the real-server-spawn
      // harness) that lacks a .spec/.test suffix, so tsconfig.lib.json's
      // *.spec/*.test excludes miss them — never ship test .d.ts.
      exclude: ['src/test/**'],
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
      // externalize every real npm dependency (better-sqlite3 — a native
      // module that must never be bundled — plus fastify, the MCP SDK,
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
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    testTimeout: 30000,
    hookTimeout: 30000,

    reporters: ['default'],
    coverage: {
      reportsDirectory: projectCoverage(__dirname),
      provider: 'v8',
    },
  },
});
