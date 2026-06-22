import { Command } from 'commander'
import * as path from 'node:path'
import { runPipeline } from '../pipeline'
import { importSource } from '../import-source'
import { buildFnTable } from '@adhd/apigen-runtime'
import { resolveTsconfig, resolveNamespace } from '../resolve-tsconfig'
import { buildCliLogger } from '../logging'
import type { ExportMode, OutputPlugin, RunInput } from '@adhd/apigen-core'

/** Parse --opt key=value pairs into an options record. */
function parseOptPairs(pairs: string[]): Record<string, unknown> {
  return Object.fromEntries(
    pairs.map(s => {
      const i = s.indexOf('=')
      return [s.slice(0, i), s.slice(i + 1)]
    })
  )
}

export function registerRunCommand(
  program: Command,
  plugins: Record<string, OutputPlugin>
): void {
  program
    .command('run')
    .requiredOption('--source <path>', 'Path to TypeScript source file')
    .requiredOption('--type <plugin-id>', 'Output target')
    .option('--export <mode>', 'Export mode: "default" | "<named-object-name>" | omit for named exports')
    .option('--tsconfig <path>', 'Explicit tsconfig.json; default resolves the nearest config or a builtin one')
    .option('--namespace <name>', 'Package namespace/id (default: tsconfig folder name, else source folder)')
    .option('--opt <key=value>', 'Plugin option (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .action(async (opts: { source: string; type: string; export?: string; tsconfig?: string; namespace?: string; opt: string[] }) => {
      const plugin = plugins[opts.type]
      if (!plugin?.run) throw new Error(`Plugin ${opts.type} does not support run mode`)

      let exportMode: ExportMode
      if (opts.export === 'default') {
        exportMode = { type: 'default' }
      } else if (opts.export) {
        exportMode = { type: 'named-object', name: opts.export }
      } else {
        exportMode = { type: 'named' }
      }

      const logger = buildCliLogger(program)
      const options = parseOptPairs(opts.opt)
      const sourceFile = path.resolve(opts.source)
      const tsconfig = resolveTsconfig(sourceFile, opts.tsconfig)
      const { schemas, createClient } = await runPipeline({ sourceFile, exportMode, tsconfig, logger })

      // Import the source module to get live function table (tsx loader handles .ts).
      // buildFnTable keys default-exported functions by their declaration name so
      // they match the extracted schema/route names (otherwise dispatch can't find them).
      const mod = await importSource(sourceFile, tsconfig)
      const fns = buildFnTable(mod)

      const controller = new AbortController()
      process.on('SIGINT', () => controller.abort())
      process.on('SIGTERM', () => controller.abort())

      const packageId = resolveNamespace(sourceFile, { namespace: opts.namespace, tsconfig: opts.tsconfig })
      const input: RunInput = {
        packages: [{ id: packageId, schemas, importPath: sourceFile, fns, createClient }],
        outputDir: '',
        options,
        signal: controller.signal,
        logger,
      }

      await plugin.run(input)
    })
}
