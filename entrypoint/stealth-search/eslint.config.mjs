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
          // Declared but never imported here: @adhd/apigen-plugin-mcp loads the SDK at run time (its own dependency),
          // and a consumer of stealth-search installs it next to the plugin. Every other dependency is checked.
          ignoredDependencies: ['@modelcontextprotocol/sdk'],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
