import baseConfig from '../../../eslint.base.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/vite.config.{js,ts,mjs,mts}',
          ],
          // `@anthropic-ai/sandbox-runtime` is the adopted `srt` OS-enforcement
          // layer (ADR-0008 D7). The resolver SPAWNS its `srt` bin to wrap the
          // fs/shell servers; it is never `import`ed, so `@nx/dependency-checks`
          // cannot see the use by static analysis. Declared here (not removed)
          // so the dependency is genuinely installed and pinned.
          //
          // `@modelcontextprotocol/server-filesystem` is the adopted fs server,
          // launched as `node <its bin>` (c9f0a791). Its bin is ESM and is
          // executed, never imported; the catalog locates it with
          // `createRequire(...).resolve('<pkg>/package.json')` on a computed
          // specifier, which static analysis cannot see. Declared (exact-pinned)
          // so it ships in the published closure instead of being fetched by `npx`.
          ignoredDependencies: [
            '@anthropic-ai/sandbox-runtime',
            '@modelcontextprotocol/server-filesystem',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
