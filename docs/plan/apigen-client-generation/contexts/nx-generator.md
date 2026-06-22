# nx-generator — IMPLEMENT @adhd/apigen-nx

**Phase:** foundation · **Depends on:** core-types · **Parallel with:** schema-extraction, schema-composition · **Guard:** `npx --yes nx build apigen-nx`

---

## Goal

Implement `@adhd/apigen-nx` with two capabilities:
1. **Generator** (`nx g @adhd/apigen-nx:plugin`) — scaffolds a new `OutputPlugin` package with correct Nx tags, `tsconfig.base.json` path entry, and TypeScript boilerplate.
2. **Executor** (`npx nx run <project>:generate`) — wraps `@adhd/apigen-cli generate` as an Nx cache-aware target.

**This state is moved before the plugin phase intentionally.** The generator is used in `scaffold-plugins` to create all 5 plugin packages — proving it works on real targets before any plugin implementation begins. This is the correct order: build the tool, use it, then fill in implementations.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/nx/src/generators/plugin/` + `packages/apigen/nx/src/executors/generate/`.
- **Reference Pattern:** Read `~/dev/projects/reverse-apis/tools/generators/api-package/generator.ts` for the reference generator implementation — how it calls `addProjectConfiguration`, `generateFiles`, `updateJson` (for tsconfig paths), and `formatFiles`. See `[ref:nx-generator-pattern]` in `references.json`. The `@nx/devkit` surface used here is the vendored contract `[iface:nx-devkit]` (see `interfaces.json`).
- **Delta Spec:**

### Install dependency

Add to `packages/apigen/nx/package.json`:
```json
{
  "dependencies": {
    "@nx/devkit": "*",
    "@adhd/apigen-core": "*"
  }
}
```

Tags: `layer:logic,platform:node`.

### Generator schema — `generators/plugin/schema.json`

```json
{
  "$schema": "http://json-schema.org/schema",
  "title": "Plugin generator",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Plugin name in kebab-case (e.g. 'python-grpc', 'api-fastify')"
    },
    "directory": {
      "type": "string",
      "description": "Target directory (default: packages/apigen/plugins/<name>)"
    },
    "description": {
      "type": "string",
      "description": "Human-readable plugin description"
    },
    "hasRun": {
      "type": "boolean",
      "default": false,
      "description": "Include a run() stub. Set true for server plugins (mcp, api-fastify, api-express) that start a long-running process."
    }
  },
  "required": ["name"]
}
```

### Generator implementation — `generators/plugin/generator.ts`

```typescript
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
  generateFiles(tree, path.join(__dirname, '__files__'), projectDir, {
    ...options,
    pluginName,
    projectName,
    packageScope,
    className: names(options.name).className,             // "ApiFastify"
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
```

### Generator templates — `generators/plugin/__files__/`

**`src/lib/plugin.ts__tmpl__`:**
```typescript
import type { OutputPlugin, PluginInput, PluginOutput<% if (hasRun) { %>, RunInput<% } %> } from '@adhd/apigen-core'

export const <%= pluginName %>Plugin: OutputPlugin = {
  id: '<%= pluginName %>',
  description: '<%= description %>',
  optionsSchema: {
    type: 'object',
    properties: {},
  },
  generate(input: PluginInput): PluginOutput {
    // TODO: implement — return { files: [{ path: '...', content: '...' }] }
    return { files: [] }
  },<% if (hasRun) { %>

  async run(input: RunInput): Promise<void> {
    // TODO: start server, register handlers, listen for input.signal
    return new Promise<void>((resolve) => {
      if (input.signal) input.signal.addEventListener('abort', () => resolve())
    })
  },<% } %>
}

export default <%= pluginName %>Plugin
```

**`src/index.ts__tmpl__`:**
```typescript
export { <%= pluginName %>Plugin } from './lib/plugin'
export default <%= pluginName %>Plugin
```

**`src/test/plugin.spec.ts__tmpl__`:**
```typescript
import { describe, it, expect } from 'vitest'
import { <%= pluginName %>Plugin } from '../lib/plugin'

describe('<%= pluginName %> plugin', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(typeof <%= pluginName %>Plugin.id).toBe('string')
    expect(<%= pluginName %>Plugin.id).toBe('<%= pluginName %>')
    expect(typeof <%= pluginName %>Plugin.generate).toBe('function')
  })
<% if (hasRun) { %>
  it('has run() method', () => {
    expect(typeof <%= pluginName %>Plugin.run).toBe('function')
  })
<% } else { %>
  it('has no run() method (generate-only plugin)', () => {
    expect(<%= pluginName %>Plugin.run).toBeUndefined()
  })
<% } %>
})
```

**`package.json__tmpl__`:**
```json
{
  "name": "<%= packageScope %>/<%= projectName %>",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "dependencies": {
    "@adhd/apigen-core": "*",
    "@adhd/apigen-runtime": "*"
  }
}
```

> **Note on plugin-specific deps:** The generator only adds `@adhd/apigen-core` + `@adhd/apigen-runtime`. Each plugin implementation state adds its own dep (fastify, @modelcontextprotocol/sdk, express). This is correct — the generator creates the shell; the implementer adds the substance.

### `generators.json`

```json
{
  "generators": {
    "plugin": {
      "factory": "./src/generators/plugin/generator",
      "schema": "./src/generators/plugin/schema.json",
      "description": "Scaffold a new @adhd/apigen-plugin-* package with correct Nx tags and tsconfig wiring"
    }
  }
}
```

### Executor — `executors/generate/executor.ts`

```typescript
import { ExecutorContext } from '@nx/devkit'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

export interface GenerateExecutorSchema {
  source: string
  type: string
  outDir: string
  exportMode?: string
  options?: Record<string, string>
}

export default async function generateExecutor(
  schema: GenerateExecutorSchema,
  context: ExecutorContext
): Promise<{ success: boolean }> {
  const projectRoot = context.workspace?.projects[context.projectName!]?.root ?? ''
  const sourceFile = path.resolve(context.root, projectRoot, schema.source)
  const outDir = path.resolve(context.root, schema.outDir)

  // 'npx @adhd/apigen-cli' resolves via workspace node_modules/.bin in the monorepo,
  // and via the published binary when used as a standalone consumer.
  const args = [
    '@adhd/apigen-cli', 'generate',
    '--source', sourceFile,
    '--type', schema.type,
    '--out-dir', outDir,
  ]

  if (schema.exportMode) args.push('--export', schema.exportMode)
  for (const [k, v] of Object.entries(schema.options ?? {})) {
    args.push('--opt', `${k}=${v}`)
  }

  try {
    execFileSync('npx', args, { stdio: 'inherit', cwd: context.root })
    return { success: true }
  } catch {
    return { success: false }
  }
}
```

**`executors.json`:**
```json
{
  "executors": {
    "generate": {
      "implementation": "./src/executors/generate/executor",
      "schema": "./src/executors/generate/schema.json",
      "description": "Run @adhd/apigen-cli generate as an Nx cache-aware target",
      "inputs": ["default", "^default"]
    }
  }
}
```

### Tests — `src/test/`

**`generator.spec.ts`:** Uses `@nx/devkit/testing` `createTreeWithEmptyWorkspace`:
```typescript
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing'
import { readProjectConfiguration, readJson } from '@nx/devkit'
import { pluginGenerator } from '../generators/plugin/generator'

describe('plugin generator', () => {
  it('creates project.json with correct tags', async () => {
    const tree = createTreeWithEmptyWorkspace()
    // seed tsconfig.base.json so updateJson has something to update
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'python-grpc' })
    const config = readProjectConfiguration(tree, 'apigen-plugin-python-grpc')
    expect(config.tags).toEqual(['layer:logic', 'platform:node'])
  })

  it('writes plugin.ts without run() when hasRun is false', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'no-run' })
    const content = tree.read('packages/apigen/plugins/no-run/src/lib/plugin.ts', 'utf-8')!
    expect(content).not.toContain('run(')
  })

  it('writes plugin.ts WITH run() when hasRun is true', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'with-run', hasRun: true })
    const content = tree.read('packages/apigen/plugins/with-run/src/lib/plugin.ts', 'utf-8')!
    expect(content).toContain('run(')
    expect(content).toContain('RunInput')
  })

  it('updates tsconfig.base.json with the new plugin path', async () => {
    const tree = createTreeWithEmptyWorkspace()
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }))
    await pluginGenerator(tree, { name: 'tsconfig-test' })
    const tsconfig = readJson(tree, 'tsconfig.base.json')
    expect(tsconfig.compilerOptions.paths['@adhd/apigen-plugin-tsconfig-test'])
      .toEqual(['./packages/apigen/plugins/tsconfig-test/src/index.ts'])
  })
})
```

**`executor.spec.ts`:** Mocks `execFileSync` and verifies arg construction.

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/nx/src/generators/plugin/generator.ts",
            "packages/apigen/nx/src/generators/plugin/schema.json",
            "packages/apigen/nx/src/generators/plugin/__files__/src/lib/plugin.ts__tmpl__",
            "packages/apigen/nx/src/generators/plugin/__files__/src/index.ts__tmpl__",
            "packages/apigen/nx/src/generators/plugin/__files__/src/test/plugin.spec.ts__tmpl__",
            "packages/apigen/nx/src/generators/plugin/__files__/package.json__tmpl__",
            "packages/apigen/nx/src/executors/generate/executor.ts",
            "packages/apigen/nx/src/executors/generate/schema.json",
            "packages/apigen/nx/generators.json",
            "packages/apigen/nx/executors.json",
            "packages/apigen/nx/src/index.ts",
            "packages/apigen/nx/src/test/generator.spec.ts",
            "packages/apigen/nx/src/test/executor.spec.ts"]
read_only:  ["packages/apigen/core/src/lib/types.ts"]
```

---

## Acceptance criteria

- `[nx-generator.1]` `pluginGenerator(tree, { name: 'python-grpc' })` creates `packages/apigen/plugins/python-grpc/` with `project.json`, `src/lib/plugin.ts`, `src/index.ts`, `src/test/plugin.spec.ts`, `package.json`.
- `[nx-generator.2]` Generated `project.json` has `"tags": ["layer:logic", "platform:node"]` and `nx-release-publish.dependsOn: ["build", "test"]`.
- `[nx-generator.3]` Generated `src/lib/plugin.ts` exports `pythonGrpcPlugin` typed as `OutputPlugin` with `generate()` returning `{ files: [] }`.
- `[nx-generator.4]` `pluginGenerator(tree, { name: 'x', hasRun: false })` produces a `plugin.ts` with NO `run()` method and NO `RunInput` import.
- `[nx-generator.5]` `pluginGenerator(tree, { name: 'x', hasRun: true })` produces a `plugin.ts` WITH `run(input: RunInput)` stub and `RunInput` in the import.
- `[nx-generator.6]` Generator updates `tsconfig.base.json` with `@adhd/apigen-plugin-<name>` path entry pointing to `./packages/apigen/plugins/<name>/src/index.ts`.
- `[nx-generator.7]` Executor calls `npx @adhd/apigen-cli generate` with `--source`, `--type`, `--out-dir` args and returns `{ success: true }`.
- `[nx-generator.8]` Executor returns `{ success: false }` when CLI exits non-zero.
- `[nx-generator.9]` `npx --yes nx build apigen-nx` exits 0.

---

## Commit points

1. After generator tests pass: `feat(apigen-nx): implement plugin generator with hasRun option and tsconfig wiring`
2. After executor tests pass: `feat(apigen-nx): implement Nx executor wrapping @adhd/apigen-cli generate`
