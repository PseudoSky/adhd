import baseConfig from '../../eslint.base.config.mjs';

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
          // Dependencies the later search states import; declared up front so no
          // later state edits package.json or the lockfile (search-scaffold.4).
          ignoredDependencies: [
            '@adhd/stealth-core-browser',
            '@adhd/resilience-core-tripwire',
            '@adhd/sox-telemetry',
            '@adhd/apigen-core-client',
            '@adhd/apigen-engine-naming',
            '@adhd/apigen-engine-runtime',
            '@adhd/apigen-plugin-mcp',
            '@adhd/apigen-plugin-cli-output',
            '@adhd/apigen-plugin-ir-cache',
            '@adhd/apigen-plugin-tracing',
            '@modelcontextprotocol/sdk',
            'commander',
            'turndown',
            'pdfjs-dist',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
