# cli-generate-cmd — IMPLEMENT generate + generate-registry COMMANDS IN @adhd/apigen-cli

**Phase:** cli · **Depends on:** audit-plugins · **Parallel with:** cli-run-cmd, nx-generator · **Guard:** `npx --yes nx test apigen-cli --testFile=packages/apigen/cli/src/test/generate.spec.ts`

---

## Goal

Implement the `generate` and `generate-registry` commands in `@adhd/apigen-cli`. After this state, the CLI can generate files to disk from a single source file or from a directory of tagged packages. The shared `pipeline.ts` and `registry.ts` modules are established here and reused by `cli-run-cmd`.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/cli/src/lib/pipeline.ts`, `registry.ts`, `commands/generate.ts`, `commands/generate-registry.ts`.
- **Reference Pattern:** Read `~/dev/projects/reverse-apis/tools/executors/generate-api-registry/executor.ts` for the registry discovery algorithm (filesystem walk, tag filter, sort). The CLI version replaces `project.json` tags with `package.json` `tags` or `keywords` field. See `[ref:reference-codebase]` in `_shared.md`. The command surface (`--type`, `--out-dir`, repeatable `--opt key=value`) is built with the vendored Commander contract `[iface:commander]` (see `interfaces.json`).
- **Delta Spec:**

### Install dependencies

```json
{
  "dependencies": {
    "commander": "^12.0.0",
    "@adhd/apigen-core": "*",
    "@adhd/apigen-runtime": "*",
    "@adhd/apigen-plugin-mcp": "*",
    "@adhd/apigen-plugin-jsonschema": "*",
    "@adhd/apigen-plugin-api-fastify": "*",
    "@adhd/apigen-plugin-api-express": "*",
    "@adhd/apigen-plugin-cli-output": "*"
  }
}
```

Set `bin` in `package.json`:
```json
{ "bin": { "apigen-cli": "./src/index.ts" } }
```

### `pipeline.ts` — shared generate/run pipeline

```typescript
import { generateSchemas, composeSchemas } from '@adhd/apigen-core'
import { createApiPackage } from '@adhd/apigen-runtime'
import type { ComposedSchemas, ExportMode, GenerateSchemasOptions } from '@adhd/apigen-core'

export interface PipelineOptions {
  sourceFile: string           // absolute path
  exportMode?: ExportMode      // default: { type: 'named' }
  middlewares?: Array<{ id: string; envelope?: Record<string, unknown> }>
  overrides?: Record<string, Record<string, boolean>>
  namespace?: string
}

export interface PipelineResult {
  schemas: ComposedSchemas
  createClient: (envelope: Record<string, unknown>) => Promise<object>
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const domainSchemas = await generateSchemas({
    sourceFile: opts.sourceFile,
    exportMode: opts.exportMode ?? { type: 'named' },
    namespace: opts.namespace,
  })
  const { schemas, createClient } = createApiPackage({
    domainSchemas,
    middlewares: opts.middlewares ?? [],
    overrides: opts.overrides,
  })
  return { schemas, createClient }
}
```

### `registry.ts` — package discovery

```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface PackageMeta {
  id: string
  dir: string
  importPath: string
  tags: string[]
}

/** Discover packages in a directory, filtered by tag. Reads package.json for tags/keywords. */
export function discoverPackages(opts: {
  packagesDir: string
  includeTags?: string[]
  excludeTags?: string[]
}): PackageMeta[] {
  const { packagesDir, includeTags = [], excludeTags = [] } = opts
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())

  const results: PackageMeta[] = []
  for (const entry of entries) {
    const pkgPath = path.join(packagesDir, entry.name, 'package.json')
    if (!fs.existsSync(pkgPath)) continue

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const tags: string[] = pkg.tags ?? pkg.keywords ?? []

    if (includeTags.length && !includeTags.every(t => tags.includes(t))) continue
    if (excludeTags.some(t => tags.includes(t))) continue

    results.push({
      id: entry.name,
      dir: path.join(packagesDir, entry.name),
      importPath: pkg.name ?? entry.name,
      tags,
    })
  }

  return results.sort((a, b) => a.id.localeCompare(b.id))
}
```

### `commands/generate.ts`

```typescript
import { Command } from 'commander'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runPipeline } from '../pipeline'
import type { ExportMode, OutputPlugin, PluginInput } from '@adhd/apigen-core'

export function registerGenerateCommand(program: Command, plugins: Record<string, OutputPlugin>): void {
  program
    .command('generate')
    .requiredOption('--source <path>', 'Path to TypeScript source file')
    .requiredOption('--type <plugin-id>', 'Output target: mcp | api-fastify | api-express | cli | jsonschema')
    .requiredOption('--out-dir <path>', 'Output directory')
    .option('--export <mode>', 'Export mode: "default" | "<named-object-name>" | omit for named exports')
    .option('--opt <key=value>', 'Plugin option (repeatable)', (val, prev: string[]) => [...prev, val], [] as string[])
    .action(async (opts) => {
      const plugin = plugins[opts.type]
      if (!plugin) throw new Error(`Unknown --type: ${opts.type}. Available: ${Object.keys(plugins).join(', ')}`)

      const exportMode: ExportMode = opts.export === 'default'
        ? { type: 'default' }
        : opts.export ? { type: 'named-object', name: opts.export }
        : { type: 'named' }

      const options: Record<string, unknown> = Object.fromEntries(
        (opts.opt as string[]).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] })
      )

      const sourceFile = path.resolve(opts.source)
      const { schemas } = await runPipeline({ sourceFile, exportMode })

      const packageId = path.basename(path.dirname(sourceFile))
      const input: PluginInput = {
        packages: [{ id: packageId, schemas, importPath: sourceFile }],
        outputDir: path.resolve(opts.outDir),
        options,
      }

      const output = await plugin.generate(input)
      fs.mkdirSync(input.outputDir, { recursive: true })
      for (const file of output.files) {
        const dest = path.join(input.outputDir, file.path)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, file.content)
      }
    })
}
```

### `commands/generate-registry.ts`

```typescript
// Same as generate but discovers multiple packages and calls plugin.generate() with all of them
// Uses discoverPackages() from registry.ts
// --packages-dir, --tag (includeTags), --exclude-tag (excludeTags), --type, --out-dir, --opt
```

### `index.ts` (entry point)

```typescript
#!/usr/bin/env node
import { Command } from 'commander'
import { registerGenerateCommand } from './lib/commands/generate'
import { registerGenerateRegistryCommand } from './lib/commands/generate-registry'
// run and run-registry registered by cli-run-cmd state
import mcpPlugin from '@adhd/apigen-plugin-mcp'
import jsonschemaPlugin from '@adhd/apigen-plugin-jsonschema'
import fastifyPlugin from '@adhd/apigen-plugin-api-fastify'
import expressPlugin from '@adhd/apigen-plugin-api-express'
import cliOutputPlugin from '@adhd/apigen-plugin-cli-output'

const plugins = { mcp: mcpPlugin, jsonschema: jsonschemaPlugin, 'api-fastify': fastifyPlugin, 'api-express': expressPlugin, cli: cliOutputPlugin }

const program = new Command().name('apigen-cli').version('0.1.0')
registerGenerateCommand(program, plugins)
registerGenerateRegistryCommand(program, plugins)
// run + run-registry stubs registered here (throws 'not implemented')
program.parseAsync()
```

### Test fixtures

**`src/test/fixtures/api.ts`** — canonical end-to-end fixture:
```typescript
export async function getUser(userId: string): Promise<{ id: string }> {
  return { id: userId }
}
export async function sendEmail(to: string, subject: string): Promise<void> {}
```

**`src/test/fixtures/registry/pkg-a/package.json`**: `{ "name": "@test/pkg-a", "tags": ["api"] }`
**`src/test/fixtures/registry/pkg-a/index.ts`**: `export function hello() { return 'a' }` plus `export const __samples__ = { hello: {} }`

**`src/test/fixtures/registry/pkg-b/package.json`**: `{ "name": "@test/pkg-b", "tags": ["api"] }`
**`src/test/fixtures/registry/pkg-b/index.ts`**: `export function world() { return 'b' }` plus `export const __samples__ = { world: {} }`

> Each `pkg-*/index.ts` carries a `__samples__` map per `[conv:fixture-samples]` (`_shared.md`) so `scripts/probe_mcp.mjs registry` derives the expected tools (`hello`, `world`) and their ground-truth outputs (`'a'`, `'b'`) from the packages themselves — never from a literal in the audit.

### Test `generate.spec.ts`

```typescript
// Test: generate --source fixture/api.ts --type jsonschema --out-dir /tmp → files written
// Test: --export default → ExportMode { type: 'default' }
// Test: --opt transport=sse → options.transport === 'sse'
// Test: unknown --type throws with helpful message
// Test: generate-registry discovers pkg-a and pkg-b by tag, excludes non-api
```

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/cli/src/lib/pipeline.ts",
            "packages/apigen/cli/src/lib/registry.ts",
            "packages/apigen/cli/src/lib/commands/generate.ts",
            "packages/apigen/cli/src/lib/commands/generate-registry.ts",
            "packages/apigen/cli/src/index.ts",
            "packages/apigen/cli/src/test/generate.spec.ts",
            "packages/apigen/cli/src/test/fixtures/api.ts",
            "packages/apigen/cli/src/test/fixtures/registry/pkg-a/index.ts",
            "packages/apigen/cli/src/test/fixtures/registry/pkg-a/package.json",
            "packages/apigen/cli/src/test/fixtures/registry/pkg-b/index.ts",
            "packages/apigen/cli/src/test/fixtures/registry/pkg-b/package.json"]
read_only:  ["packages/apigen/plugins/*/"]
```

---

## Acceptance criteria

- `[cli-generate-cmd.1]` `generate --source fixtures/api.ts --type jsonschema --out-dir /tmp/test` writes JSON files.
- `[cli-generate-cmd.2]` `--export default` resolves to `ExportMode { type: 'default' }`.
- `[cli-generate-cmd.3]` `--opt key=value` populates `PluginInput.options.key === 'value'`.
- `[cli-generate-cmd.4]` `--type` flag is required; `--output` is NOT a registered flag:
  ```bash
  grep -rn '\"output\"' packages/apigen/cli/src/lib/commands/
  # must produce no output (as a Commander flag name)
  ```
- `[cli-generate-cmd.5]` `generate-registry` with `--packages-dir` discovers pkg-a and pkg-b; produces output for both.

---

## Commit points

1. After tests pass: `feat(apigen-cli): implement generate + generate-registry commands with pipeline and registry discovery`
