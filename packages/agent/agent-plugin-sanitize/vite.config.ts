/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { copyDocFiles } from '../../../tools/vite-plugins/copy-readme.mjs';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/packages/agent/agent-plugin-sanitize',

  plugins: [
    nxViteTsPaths(),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(__dirname, 'tsconfig.lib.json'),
    }),
    // @nx/vite:build ignores project.json `assets` — copy README/CHANGELOG
    // into dist ourselves so they ship on npm (BUG-AGENTMCP-003).
    copyDocFiles(__dirname),
  ],

  build: {
    outDir: '../../../dist/packages/agent/agent-plugin-sanitize',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: 'src/index.ts',
      name: 'agent-mcp-sanitize',
      fileName: 'index',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['@adhd/agent-base-types', 'better-sqlite3', 'zod', /^node:/],
    },
  },

  test: {
    globals: true,
    cache: {
      dir: '../../../node_modules/.vitest',
    },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/packages/agent/agent-plugin-sanitize',
      provider: 'v8',
    },
  },
});
