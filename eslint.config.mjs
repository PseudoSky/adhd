import baseConfig from './eslint.base.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          buildTargets: ['build', 'custom-build'],
          checkMissingDependencies: true,
          checkObsoleteDependencies: true,
          checkVersionMismatches: true,
          ignoredDependencies: ['lodash'],
          ignoredFiles: ['webpack.config.js', 'eslint.config.js'],
          includeTransitiveDependencies: true,
          useLocalPathsForWorkspaceDependencies: true,
        },
      ],
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            {
              sourceTag: 'platform:node',
              bannedExternalImports: ['react'],
              notDependOnLibsWithTags: ['platform:browser'],
            },
            {
              sourceTag: 'platform:browser',
              notDependOnLibsWithTags: ['platform:node'],
            },
            {
              sourceTag: 'platform:shared',
              bannedExternalImports: ['react'],
              notDependOnLibsWithTags: ['platform:browser', 'platform:node'],
            },
            {
              sourceTag: 'layer:shared',
              onlyDependOnLibsWithTags: ['layer:shared', 'layer:test-logic'],
            },
            {
              sourceTag: 'layer:logic',
              bannedExternalImports: ['react'],
              onlyDependOnLibsWithTags: ['layer:shared', 'layer:test-logic'],
            },
            {
              sourceTag: 'layer:tokens',
              onlyDependOnLibsWithTags: ['layer:shared'],
            },
            {
              sourceTag: 'layer:data',
              bannedExternalImports: ['react'],
              onlyDependOnLibsWithTags: [
                'layer:logic',
                'layer:shared',
                'layer:test-logic',
              ],
            },
            {
              sourceTag: 'layer:ui-primitives',
              onlyDependOnLibsWithTags: [
                'layer:tokens',
                'layer:shared',
                'layer:test-ui',
              ],
            },
            {
              sourceTag: 'layer:ui-composites',
              onlyDependOnLibsWithTags: [
                'layer:ui-primitives',
                'layer:tokens',
                'layer:test-ui',
              ],
            },
            {
              sourceTag: 'layer:components',
              onlyDependOnLibsWithTags: [
                'layer:ui-composites',
                'layer:data',
                'layer:logic',
                'layer:test-ui',
              ],
            },
            {
              sourceTag: 'layer:workflows',
              onlyDependOnLibsWithTags: [
                'layer:components',
                'layer:ui-composites',
                'layer:logic',
                'layer:test-ui',
              ],
            },
            {
              sourceTag: 'layer:ai',
              onlyDependOnLibsWithTags: ['layer:data', 'layer:shared'],
            },
            {
              sourceTag: 'layer:entrypoints',
              onlyDependOnLibsWithTags: [
                'layer:workflows',
                'layer:logic',
                'layer:data',
                'layer:shared',
              ],
            },
            {
              sourceTag: 'layer:test-logic',
              bannedExternalImports: ['react'],
              onlyDependOnLibsWithTags: ['layer:shared'],
            },
            {
              sourceTag: 'layer:test-ui',
              onlyDependOnLibsWithTags: [
                'layer:test-logic',
                'layer:shared',
                'layer:ui-primitives',
              ],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
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
    files: ['**/*.js', '**/*.jsx'],
    // Override or add rules here
    rules: {},
  },
  {
    ignores: ['dist', 'coverage', 'tmp', '.nx', '**/*.timestamp-*.mjs'],
  },
];
