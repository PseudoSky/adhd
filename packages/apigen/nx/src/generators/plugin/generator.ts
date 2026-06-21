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

export interface PluginGeneratorSchema {
  name: string
  directory?: string
  description?: string
  hasRun?: boolean
}

export async function pluginGenerator(tree: Tree, options: PluginGeneratorSchema) {
  const pluginName = names(options.name).fileName          // "api-fastify"
  const projectName = `apigen-plugin-${pluginName}`        // "apigen-plugin-api-fastify"
  const projectDir = options.directory ?? `packages/apigen/plugins/${pluginName}`
  const packageScope = '@adhd'

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
      'nx-release-publish': {
        dependsOn: ['build', 'test'],
        executor: '@nx/js:release-publish',
      },
    },
    release: {
      version: { generatorOptions: { packageRoot: projectDir } },
    },
  })

  // 2. Write source files from __files__ templates
  const n = names(options.name)
  generateFiles(tree, path.join(__dirname, '__files__'), projectDir, {
    ...options,
    pluginName,
    projectName,
    packageScope,
    className: n.className,                               // "ApiFastify"
    propertyName: n.propertyName,                         // "apiFastify" — valid JS identifier for exports
    description: options.description ?? `OutputPlugin for ${pluginName}`,
    hasRun: options.hasRun ?? false,
    offsetFromRoot: offsetFromRoot(projectDir),
    tmpl: '',
  })

  // 3. Wire tsconfig.base.json path — generator does this automatically
  //    so scaffold-plugins doesn't need a manual patch step
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

export default pluginGenerator
