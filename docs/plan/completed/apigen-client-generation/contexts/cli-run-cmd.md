# cli-run-cmd — IMPLEMENT run + run-registry COMMANDS IN @adhd/apigen-cli

**Phase:** cli · **Depends on:** audit-plugins · **Parallel with:** cli-generate-cmd, nx-generator · **Guard:** `npx --yes nx test apigen-cli --testFile=packages/apigen/cli/src/test/run.spec.ts`

---

## Goal

Implement the `run` and `run-registry` commands. In run mode, the source module is loaded via `import()` at startup, the live function table is passed to `plugin.run()`, and the process stays alive until SIGINT. No watch/hot-reload. After this state, `apigen-cli run --source ./api.ts --type mcp` starts an MCP server.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/apigen/cli/src/lib/commands/run.ts` + `run-registry.ts` — additive to `index.ts`.
- **Reference Pattern:** SCOPE.md §4.4 "Run mode" describes the pipeline. `import()` the source module, pass live fns + createClient to `plugin.run()`. AbortSignal wired to SIGINT. The `run` / `run-registry` subcommands are registered via the vendored Commander contract `[iface:commander]` (see `interfaces.json`), using `parseAsync()` so the live import resolves before dispatch.
- **Delta Spec:**

**MERGE PROTOCOL:** `cli-generate-cmd` creates `index.ts`. This state adds `run` + `run-registry` commands to it. Whichever completes second merges both command registrations into `index.ts`.

### `commands/run.ts`

```typescript
import { Command } from 'commander'
import * as path from 'node:path'
import { runPipeline } from '../pipeline'
import type { ExportMode, OutputPlugin, RunInput } from '@adhd/apigen-core'

export function registerRunCommand(program: Command, plugins: Record<string, OutputPlugin>): void {
  program
    .command('run')
    .requiredOption('--source <path>', 'Path to TypeScript source file')
    .requiredOption('--type <plugin-id>', 'Output target')
    .option('--export <mode>', 'Export mode')
    .option('--opt <key=value>', 'Plugin option (repeatable)', (val, prev: string[]) => [...prev, val], [] as string[])
    .action(async (opts) => {
      const plugin = plugins[opts.type]
      if (!plugin?.run) throw new Error(`Plugin ${opts.type} does not support run mode`)

      const exportMode: ExportMode = opts.export === 'default'
        ? { type: 'default' }
        : opts.export ? { type: 'named-object', name: opts.export }
        : { type: 'named' }

      const options = Object.fromEntries(
        (opts.opt as string[]).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] })
      )

      const sourceFile = path.resolve(opts.source)
      const { schemas, createClient } = await runPipeline({ sourceFile, exportMode })

      // Import the source module to get live function table
      const module = await import(sourceFile)
      const fns = { ...module } as Record<string, (...args: unknown[]) => unknown>

      const controller = new AbortController()
      process.on('SIGINT', () => controller.abort())
      process.on('SIGTERM', () => controller.abort())

      const packageId = path.basename(path.dirname(sourceFile))
      const input: RunInput = {
        packages: [{ id: packageId, schemas, importPath: sourceFile, fns, createClient }],
        outputDir: '',
        options,
        signal: controller.signal,
      }

      await plugin.run(input)
    })
}
```

### `commands/run-registry.ts`

```typescript
// Same as run, but uses discoverPackages() to load multiple packages
// For each discovered package: import(pkg.dir + '/index.ts') to get fns
// All packages passed as input.packages array to plugin.run()
// --packages-dir, --tag, --exclude-tag, --type, --opt
```

### Update `index.ts`

Add `registerRunCommand` and `registerRunRegistryCommand` to `index.ts` (merge with cli-generate-cmd's content):

```typescript
import { registerRunCommand } from './lib/commands/run'
import { registerRunRegistryCommand } from './lib/commands/run-registry'
// ...
registerRunCommand(program, plugins)
registerRunRegistryCommand(program, plugins)
```

### Test `run.spec.ts`

```typescript
// Test: run with jsonschema plugin (no run() method) throws helpful error
// Test: run with mcp plugin imports source module and calls plugin.run()
// Test: AbortController.abort() causes run() to resolve (clean shutdown)
// Test: run-registry discovers both fixture packages and passes both to plugin.run()
//       Use a mock plugin.run() that records what packages array it received
```

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["packages/apigen/cli/src/lib/commands/run.ts",
            "packages/apigen/cli/src/lib/commands/run-registry.ts",
            "packages/apigen/cli/src/test/run.spec.ts"]
read_only:  ["packages/apigen/cli/src/lib/pipeline.ts",
            "registry.ts"]
```

---

## Acceptance criteria

- `[cli-run-cmd.1]` `run` command imports the source module via `import()` and passes live fns to `plugin.run()`.
- `[cli-run-cmd.2]` SIGINT triggers `AbortController.abort()` which causes `plugin.run()` to resolve.
- `[cli-run-cmd.3]` Plugin with no `run()` method: throws error `does not support run mode`.
- `[cli-run-cmd.4]` `run-registry` passes multiple packages array to `plugin.run()` (not called once per package).
- `[cli-run-cmd.5]` `--output` flag does NOT exist (only `--type`):
  ```bash
  grep -n "'--output'" packages/apigen/cli/src/lib/commands/run.ts packages/apigen/cli/src/lib/commands/run-registry.ts
  # must produce no output
  ```

---

## Commit points

1. After tests pass: `feat(apigen-cli): implement run + run-registry commands`
