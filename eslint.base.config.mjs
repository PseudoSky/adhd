import nx from '@nx/eslint-plugin';
import jsoncEslintParser from 'jsonc-eslint-parser';

/**
 * Shared flat ESLint config for every project in the workspace.
 *
 * This is the flat-config equivalent of the legacy `.eslintrc.base.json` PLUS the
 * workspace rules the legacy root `.eslintrc.json` declared (dependency checks and
 * the module-boundary constraints). Per-project `eslint.config.mjs` files import
 * this config, so the workspace rules apply to project files.
 *
 * ORDERING MATTERS. The legacy base extended `plugin:@nx/typescript` in a *later*
 * override, so the preset's `eslint-config-prettier`-style disables (indent,
 * key-spacing, comma-dangle, max-len, …) won over the user's formatting rules. The
 * flat presets are therefore spread AFTER the explicit rule block to preserve that
 * exact precedence — putting them first re-enables formatting rules the pre-migration
 * baseline had off. The one block that must come after the presets is the type-aware
 * one: the preset's `parserOptions` would otherwise clobber `projectService`.
 */
export default [
  ...nx.configs['flat/base'],
  {
    // `**/` prefix: a bare `{package,project}.json` only matches at the config's
    // own directory, so no project's package.json/project.json was matched and
    // `@nx/dependency-checks` silently stopped running (reported as "File
    // ignored because no matching configuration was supplied").
    files: ['**/{package,project}.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          buildTargets: ['build'],
          checkMissingDependencies: true,
          checkObsoleteDependencies: true,
          checkVersionMismatches: true,
          ignoredDependencies: [],
          ignoredFiles: [
            '{projectRoot}/vite.config.{js,ts,mjs,mts}',
            '{projectRoot}/drizzle.config.{js,ts,mjs,mts}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: jsoncEslintParser,
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          buildTargets: ['build'],
          checkMissingDependencies: true,
          checkObsoleteDependencies: true,
          checkVersionMismatches: true,
          ignoredDependencies: ['lodash'],
          ignoredFiles: [
            'webpack.config.js',
            'eslint.config.js',
            'vite.config.js',
            'vite.config.ts',
            'vite.config.mjs',
            'vite.config.mts',
          ],
          includeTransitiveDependencies: true,
          useLocalPathsForWorkspaceDependencies: true,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': [
        'error',
        {
          ignoreRestArgs: true,
        },
      ],
      indent: [
        'error',
        2,
        {
          CallExpression: {
            arguments: 2,
          },
          FunctionDeclaration: {
            body: 1,
            parameters: 2,
          },
          FunctionExpression: {
            body: 1,
            parameters: 2,
          },
          MemberExpression: 2,
          ObjectExpression: 1,
          SwitchCase: 1,
          ignoredNodes: ['ConditionalExpression'],
        },
      ],
      'max-len': [
        'error',
        {
          code: 80,
          tabWidth: 2,
          ignoreUrls: true,
        },
      ],
      'object-property-newline': 'error',
      'comma-dangle': ['error', 'always-multiline'],
      'key-spacing': [
        'error',
        {
          align: {
            beforeColon: false,
            afterColon: false,
            on: 'value',
          },
        },
      ],
      'comma-spacing': [
        'error',
        {
          before: false,
          after: true,
        },
      ],
      'operator-linebreak': ['error', 'after'],
      'no-multiple-empty-lines': [
        'error',
        {
          max: 2,
        },
      ],
      'no-tabs': 'error',
      'no-nested-ternary': 'error',
      'no-array-constructor': 'error',
      'no-trailing-spaces': 'error',
      'no-unneeded-ternary': 'warn',
      'no-var': 'error',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      quotes: [
        'error',
        'single',
        {
          allowTemplateLiterals: true,
        },
      ],
      'rest-spread-spacing': 'error',
      semi: ['error', 'always'],
      'space-before-blocks': 'error',
      'space-before-function-paren': [
        'error',
        {
          asyncArrow: 'always',
          anonymous: 'never',
          named: 'never',
        },
      ],
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.jsx'],
    rules: {},
  },
  // Presets AFTER the explicit rules — see the ordering note above. The legacy
  // base extended `plugin:@nx/typescript` last, so its disables win.
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // Type-aware linting for `@typescript-eslint/prefer-optional-chain`.
    //
    // The eslintrc setup got its TS parser from `plugin:@nx/typescript`, but that
    // preset never set `parserOptions.project`, and `prefer-optional-chain`
    // requires type information — so the rule threw at load once it was applied
    // to project files. `projectService` resolves each linted file to the tsconfig
    // that includes it, which is what the root-run `@nx/eslint:lint` executor
    // needs across the workspace's ~60 projects.
    //
    // Scoped away from files no tsconfig includes (test fixtures, `__tests__/`
    // and `test/` helpers, storybook stories and standalone `*.config.ts`), which
    // the project service cannot type-check; those keep the non-type-aware preset
    // config and simply don't get this one rule.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: [
      '**/__tests__/**',
      '**/test/**',
      '**/tests/**',
      '**/fixtures/**',
      '**/*.stories.ts',
      '**/*.stories.tsx',
      '**/*.config.ts',
      '**/*.config.mts',
      '**/*.config.cts',
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/prefer-optional-chain': [
        'error',
        {
          allowPotentiallyUnsafeFixesThatModifyTheReturnTypeIKnowWhatImDoing: true,
        },
      ],
    },
  },
  {
    // Newly enabled by typescript-eslint v8's `recommended` set; the
    // pre-migration baseline (typescript-eslint v7) did not enable it, and it was
    // not in the user's explicit rule list. Disabled to restore the baseline
    // rather than rewrite source to satisfy a preset default.
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    // Recursive patterns: a bare `dist` only matches the workspace-root `dist`,
    // so every project's built `dist/**` was being linted once flat config
    // stopped honoring `.eslintignore` (removed in ESLint v9). Patterns are also
    // matched relative to the process CWD (the workspace root under the
    // `@nx/eslint:lint` executor), so they must be `**/`-prefixed to reach a
    // project's own files.
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/tmp/**',
      '**/.nx/**',
      '**/*.timestamp-*.mjs',
      // Build tooling, not shipped library source. Every project's legacy
      // `.eslintrc.json` ignored `vite.config.*`; the migration dropped those
      // ignores, so the configs were newly linted. Restored here rather than
      // "fixed": these files wire the vite test/build pipeline and legitimately
      // import the `platform:node` `workspace-base-vite-paths` helper, which the
      // `platform:shared` tag constraints forbid for runtime source but not for
      // build config. The relative-path import they use is tracked separately.
      '**/vite.config.*',
    ],
  },
];
