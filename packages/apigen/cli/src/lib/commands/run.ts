import { Command } from 'commander'
import * as path from 'node:path'
import { runPipeline } from '../pipeline'
import { importSource } from '../import-source'
import { buildFnTable } from '@adhd/apigen-runtime'
import { resolveTsconfig, resolveNamespace } from '../resolve-tsconfig'
import { buildCliLogger } from '../logging'
import {
  orchestrateRun,
  parseOverrides,
  loadOverrideConfig,
} from '../orchestrator'
import type { SourceEntry } from '../orchestrator'
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
    .option('--opt <key=value>', 'Plugin option (repeatable). Projection overrides: http.verb.<id>=GET', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--use <plugin>', 'Layer/mount/envelope plugin to activate (repeatable; accepts package specifier or local path)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--config <path>', 'Path to apigen.config.json projection-override file (Tenet 1)')
    .option('--v2', 'Use the v2 unified orchestrator path (detect→extract→merge→run)')
    .action(async (opts: {
      source: string
      type: string
      export?: string
      tsconfig?: string
      namespace?: string
      opt: string[]
      use: string[]
      config?: string
      v2?: boolean
    }) => {
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
      const allOpts = opts.opt
      const options = parseOptPairs(allOpts)
      const sourceFile = path.resolve(opts.source)

      const controller = new AbortController()
      process.on('SIGINT', () => controller.abort())
      process.on('SIGTERM', () => controller.abort())

      if (opts.v2) {
        // --- v2 unified path: detect → extract → merge → collision-check → run ---
        const cliOverrides = parseOverrides(allOpts)
        const overrides = loadOverrideConfig(opts.config, cliOverrides)

        const sourceEntry: SourceEntry = {
          file: sourceFile,
          exportMode,
          namespace: opts.namespace,
          tsconfig: opts.tsconfig,
        }

        await orchestrateRun(
          {
            sources: [sourceEntry],
            usePlugins: opts.use,
            overrides,
            logger,
          },
          plugin,
          async (entry: SourceEntry) => {
            const tsconfig = resolveTsconfig(entry.file, entry.tsconfig)
            const mod = await importSource(entry.file, tsconfig)
            const fns = buildFnTable(mod)
            const createClient = async (envelope: Record<string, unknown>): Promise<object> => envelope
            return { fns, createClient }
          },
          controller.signal,
          options,
        )
        return
      }

      // --- v1 path (kept for backward compatibility) -----------------------
      const tsconfig = resolveTsconfig(sourceFile, opts.tsconfig)
      const { schemas, createClient } = await runPipeline({ sourceFile, exportMode, tsconfig, logger })

      // Import the source module to get live function table (tsx loader handles .ts).
      // buildFnTable keys default-exported functions by their declaration name so
      // they match the extracted schema/route names (otherwise dispatch can't find them).
      const mod = await importSource(sourceFile, tsconfig)
      const fns = buildFnTable(mod)

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
