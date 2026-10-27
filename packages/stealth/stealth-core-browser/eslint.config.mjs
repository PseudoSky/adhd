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
          // pnpm installs two service-proxy lines (0.5.0 hoisted for sox-embedding-provider,
          // 0.6.0 for this package); the rule compares against the hoisted one.
          ignoredDependencies: ['@adhd/sox-service-proxy'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
