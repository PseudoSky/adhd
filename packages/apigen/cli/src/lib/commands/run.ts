import { Command } from 'commander'
import * as path from 'node:path'
import { runPipeline } from '../pipeline'
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
    .option('--opt <key=value>', 'Plugin option (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .action(async (opts: { source: string; type: string; export?: string; opt: string[] }) => {
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

      const options = parseOptPairs(opts.opt)
      const sourceFile = path.resolve(opts.source)
      const { schemas, createClient } = await runPipeline({ sourceFile, exportMode })

      // Import the source module to get live function table
      const mod = await import(sourceFile) as Record<string, unknown>
      const fns: Record<string, (...args: unknown[]) => unknown> = {}
      for (const [key, val] of Object.entries(mod)) {
        if (typeof val === 'function') {
          fns[key] = val as (...args: unknown[]) => unknown
        }
      }

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
