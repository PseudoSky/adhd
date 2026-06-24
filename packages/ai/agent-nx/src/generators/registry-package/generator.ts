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

export interface RegistryPackageGeneratorSchema {
  /** kebab-case name WITHOUT the `agent-` prefix, e.g. `budget`, `tool-registry`. */
  name: string
  /** Override target directory (default `packages/ai/agent-<name>`). */
  directory?: string
  /** Human-readable description for package.json. */
  description?: string
  /** SQLite table-name prefix (default `<name>_` with hyphens → underscores). */
  tablePrefix?: string
}

export async function registryPackageGenerator(
  tree: Tree,
  options: RegistryPackageGeneratorSchema,
) {
  const baseName = names(options.name).fileName // "tool-registry"
  const projectName = `agent-${baseName}` // "agent-tool-registry"
  const packageName = `@adhd/${projectName}` // "@adhd/agent-tool-registry"
  const projectDir = options.directory ?? `packages/ai/${projectName}`
  // Table prefix: hyphens → underscores, trailing underscore. The cross-package
  // collision guard ([inv:table-prefix] in REGISTRY-PACKAGE-RULES.md).
  const tablePrefix = options.tablePrefix ?? `${baseName.replace(/-/g, '_')}_`
  const description =
    options.description ??
    `Registry-family store for ${projectName}: drizzle-backed SQLite tables sharing the one registry database.`

  const outputPath = `dist/${projectDir}`

  // 1. project.json. Targets are named `build`/`test`/`typecheck` so they
  //    INHERIT cache + `^build` from nx.json targetDefaults (@nx/js:tsc, test).
  //    We never redefine `cache`/`dependsOn` locally — that is the contract.
  addProjectConfiguration(tree, projectName, {
    root: projectDir,
    sourceRoot: `${projectDir}/src`,
    projectType: 'library',
    tags: ['layer:ai', 'platform:node'],
    release: {
      version: {
        generatorOptions: {
          packageRoot: `dist/{projectRoot}`,
          currentVersionResolver: 'git-tag',
        },
      },
    },
    targets: {
      build: {
        executor: '@nx/js:tsc',
        outputs: ['{options.outputPath}'],
        options: {
          outputPath,
          main: `${projectDir}/src/index.ts`,
          tsConfig: `${projectDir}/tsconfig.lib.json`,
          clean: true,
          // Drizzle migrations must ship in the published package so
          // runMigrations() finds them at runtime.
          assets: [
            {
              input: projectDir,
              glob: 'drizzle/**/*',
              output: '.',
            },
          ],
        },
      },
      test: {
        executor: '@nx/vite:test',
        outputs: ['{options.reportsDirectory}'],
        options: {
          configFile: `${projectDir}/vite.config.ts`,
          reportsDirectory: `../../../coverage/${projectDir}`,
        },
      },
      typecheck: {
        executor: 'nx:run-commands',
        options: {
          command: `tsc -p ${projectDir}/tsconfig.json --noEmit`,
        },
      },
      'db:generate': {
        executor: 'nx:run-commands',
        options: {
          command: 'drizzle-kit generate',
          cwd: projectDir,
        },
      },
      'db:migrate': {
        executor: 'nx:run-commands',
        options: {
          command: 'drizzle-kit migrate',
          cwd: projectDir,
        },
      },
      clean: {
        executor: 'nx:run-commands',
        options: {
          command: `rm -rf ${outputPath}`,
        },
      },
      'nx-release-publish': {
        dependsOn: ['build', 'test'],
        options: {
          packageRoot: 'dist/{projectRoot}',
        },
      },
    },
  })

  // 2. Write source + config files from the __files__ templates.
  const n = names(baseName)
  generateFiles(tree, path.join(__dirname, '__files__'), projectDir, {
    ...options,
    baseName,
    projectName,
    projectDir,
    packageName,
    description,
    tablePrefix,
    className: n.className, // "ToolRegistry"
    propertyName: n.propertyName, // "toolRegistry"
    constantName: n.constantName, // "TOOL_REGISTRY"
    offsetFromRoot: offsetFromRoot(projectDir),
    tmpl: '',
  })

  // 3. Register the package path in tsconfig.base.json (ADDITIVE — only the
  //    new line; mirrors how every shipped registry package is wired).
  updateJson(tree, 'tsconfig.base.json', (json) => {
    const paths = json.compilerOptions?.paths ?? {}
    paths[packageName] = [`./${projectDir}/src/index.ts`]
    return {
      ...json,
      compilerOptions: { ...json.compilerOptions, paths },
    }
  })

  await formatFiles(tree)
}

export default registryPackageGenerator
