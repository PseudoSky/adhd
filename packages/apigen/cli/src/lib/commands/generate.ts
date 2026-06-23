import { Command } from 'commander'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runPipeline } from '../pipeline'
import { resolveNamespace } from '../resolve-tsconfig'
import { buildCliLogger } from '../logging'
import {
  orchestrateGenerate,
  parseOverrides,
  loadOverrideConfig,
} from '../orchestrator'
import type { ExportMode, OutputPlugin, PluginInput } from '@adhd/apigen-core'
import { emitResolutionScaffolding } from '../scaffold'

/** Parse --opt key=value pairs into an options record. */
function parseOptPairs(pairs: string[]): Record<string, unknown> {
  return Object.fromEntries(
    pairs.map(s => {
      const i = s.indexOf('=')
      return [s.slice(0, i), s.slice(i + 1)]
    })
  )
}

/** Resolve the --export flag value to an ExportMode. */
export function resolveExportMode(exportFlag: string | undefined): ExportMode {
  if (exportFlag === 'default') return { type: 'default' }
  if (exportFlag) return { type: 'named-object', name: exportFlag }
  return { type: 'named' }
}

export function registerGenerateCommand(
  program: Command,
  plugins: Record<string, OutputPlugin>
): void {
  program
    .command('generate')
    .requiredOption('--source <path>', 'Path to TypeScript source file')
    .requiredOption('--type <plugin-id>', 'Output target: mcp | api-fastify | api-express | cli | jsonschema')
    .requiredOption('--out-dir <path>', 'Output directory')
    .option('--export <mode>', 'Export mode: "default" | "<named-object-name>" | omit for named exports')
    .option('--tsconfig <path>', 'Explicit tsconfig.json; default resolves the nearest config or a builtin one')
    .option('--namespace <name>', 'Package namespace/id (default: tsconfig folder name, else source folder)')
    .option('--opt <key=value>', 'Plugin option (repeatable). Projection overrides: http.verb.<id>=GET', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--use <plugin>', 'Layer/mount/envelope plugin to activate (repeatable; accepts package specifier or local path)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--config <path>', 'Path to apigen.config.json projection-override file (Tenet 1)')
    .option('--link-workspace', 'PRE-PUBLISH ONLY: also emit a workspace-linked node_modules + tsconfig paths so the output runs in place before @adhd/apigen-* are published (a published consumer runs `npm install` instead)')
    .option('--v2', 'Use the v2 unified orchestrator path (detect→extract→merge→gen)')
    .action(async (opts: {
      source: string
      type: string
      outDir: string
      export?: string
      tsconfig?: string
      namespace?: string
      opt: string[]
      use: string[]
      config?: string
      linkWorkspace?: boolean
      v2?: boolean
    }) => {
      const plugin = plugins[opts.type]
      if (!plugin) {
        throw new Error(`Unknown --type: ${opts.type}. Available: ${Object.keys(plugins).join(', ')}`)
      }

      const logger = buildCliLogger(program)
      const exportMode = resolveExportMode(opts.export)
      const sourceFile = path.resolve(opts.source)
      const outputDir = path.resolve(opts.outDir)

      // Separate plugin opts from projection overrides (http.verb.* keys).
      // All --opt pairs feed plugin options; override keys additionally update
      // the projection config (Tenet 1 — source never touched).
      const allOpts = opts.opt
      const cliOverrides = parseOverrides(allOpts)
      const overrides = loadOverrideConfig(opts.config, cliOverrides)
      const options = parseOptPairs(allOpts)

      if (opts.v2) {
        // --- v2 unified path: detect → extract → merge → collision-check → gen ---
        const { pluginOutput } = await orchestrateGenerate(
          {
            sources: [{ file: sourceFile, exportMode, namespace: opts.namespace, tsconfig: opts.tsconfig }],
            usePlugins: opts.use,
            overrides,
            logger,
          },
          plugin,
          outputDir,
          options,
        )

        fs.mkdirSync(outputDir, { recursive: true })
        for (const file of pluginOutput.files) {
          const dest = path.join(outputDir, file.path)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.writeFileSync(dest, file.content)
        }
        const scaffolded = emitResolutionScaffolding(outputDir, plugin.id, { linkWorkspace: opts.linkWorkspace })
        if (scaffolded.length > 0) {
          logger.info(`scaffolded ${scaffolded.join(', ')} in ${outputDir}`)
        }
        logger.info(`wrote ${pluginOutput.files.length} files to ${outputDir}`)
        return
      }

      // --- v1 path (kept for backward compatibility) -----------------------
      const { schemas } = await runPipeline({ sourceFile, exportMode, tsconfig: opts.tsconfig, logger })

      const packageId = resolveNamespace(sourceFile, { namespace: opts.namespace, tsconfig: opts.tsconfig })
      const input: PluginInput = {
        packages: [{ id: packageId, schemas, importPath: sourceFile }],
        outputDir,
        options,
        logger,
      }

      const output = await plugin.generate(input)
      fs.mkdirSync(outputDir, { recursive: true })
      for (const file of output.files) {
        const dest = path.join(outputDir, file.path)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, file.content)
      }
      const scaffolded = emitResolutionScaffolding(outputDir, plugin.id, { linkWorkspace: opts.linkWorkspace })
      if (scaffolded.length > 0) {
        logger.info(`scaffolded ${scaffolded.join(', ')} in ${outputDir}`)
      }
      logger.info(`wrote ${output.files.length} files to ${outputDir}`)
    })
}
