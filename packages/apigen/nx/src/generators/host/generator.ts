import {
  addProjectConfiguration,
  formatFiles,
  generateFiles,
  names,
  offsetFromRoot,
  Tree,
  updateJson,
} from '@nx/devkit'
import * as path from 'node:path'

export interface HostGeneratorSchema {
  host: string
  directory?: string
  logicalTypeVersion?: string
}

/**
 * Scaffolds the golden-path obligations for adding a NEW host language to the
 * apigen logical-types system (DESIGN §16 runbook).
 *
 * Emits:
 *  - `host-manifest.json` — empty/red-by-construction (`supportedIds: []`)
 *  - `src/conformance/harness.spec.ts` — conformance harness that loads shared
 *    vectors, encodes each `seed` byte-equal to `wire`, decodes + checks
 *    `invariants`, and asserts every `negativeControl` turns red
 *
 * The manifest starts with `supportedIds: []` so the host is non-conformant
 * until the implementer fills in the codec column and re-runs the harness.
 */
export async function hostGenerator(tree: Tree, options: HostGeneratorSchema) {
  const hostName = names(options.host).fileName                    // "typescript"
  const projectName = `apigen-host-${hostName}`                   // "apigen-host-typescript"
  const projectDir = options.directory ?? `packages/apigen/hosts/${hostName}`
  const packageScope = '@adhd'
  const logicalTypeVersion = options.logicalTypeVersion ?? '1.0.0'

  // 1. Create project.json via addProjectConfiguration
  addProjectConfiguration(tree, projectName, {
    root: projectDir,
    projectType: 'library',
    tags: ['layer:logic', 'platform:node'],
    targets: {
      build: {
        executor: '@nx/vite:build',
        options: { outputPath: `dist/${projectDir}`, emptyOutDir: true },
      },
      test: {
        executor: '@nx/vite:test',
        options: { configFile: `${projectDir}/vite.config.ts` },
      },
      conformance: {
        executor: '@nx/vite:test',
        options: {
          configFile: `${projectDir}/vite.config.ts`,
          testNamePattern: 'conformance harness',
        },
      },
      'nx-release-publish': {
        dependsOn: ['build', 'test'],
        executor: '@nx/js:release-publish',
        options: { packageRoot: 'dist/{projectRoot}' },
      },
    },
    release: {
      version: { generatorOptions: { packageRoot: projectDir } },
    },
  })

  // 2. Write source files from __files__ templates
  const n = names(options.host)
  generateFiles(tree, path.join(__dirname, '__files__'), projectDir, {
    ...options,
    hostName,
    projectName,
    packageScope,
    logicalTypeVersion,
    className: n.className,                                        // "Typescript"
    propertyName: n.propertyName,                                  // "typescript"
    offsetFromRoot: offsetFromRoot(projectDir),
    tmpl: '',
  })

  // 3. Wire tsconfig.base.json path
  updateJson(tree, 'tsconfig.base.json', (json) => {
    const paths = json.compilerOptions?.paths ?? {}
    paths[`${packageScope}/${projectName}`] = [`./${projectDir}/src/index.ts`]
    return {
      ...json,
      compilerOptions: { ...json.compilerOptions, paths },
    }
  })

  await formatFiles(tree)
}

export default hostGenerator
