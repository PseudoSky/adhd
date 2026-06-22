import { Command } from 'commander'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runPipeline } from '../pipeline'
import type { ExportMode, OutputPlugin, PluginInput } from '@adhd/apigen-core'

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
    .option('--opt <key=value>', 'Plugin option (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .action(async (opts: { source: string; type: string; outDir: string; export?: string; tsconfig?: string; opt: string[] }) => {
      const plugin = plugins[opts.type]
      if (!plugin) {
        throw new Error(`Unknown --type: ${opts.type}. Available: ${Object.keys(plugins).join(', ')}`)
      }

      const exportMode = resolveExportMode(opts.export)
      const options = parseOptPairs(opts.opt)
      const sourceFile = path.resolve(opts.source)
      const { schemas } = await runPipeline({ sourceFile, exportMode, tsconfig: opts.tsconfig })

      const packageId = path.basename(path.dirname(sourceFile))
      const outputDir = path.resolve(opts.outDir)
      const input: PluginInput = {
        packages: [{ id: packageId, schemas, importPath: sourceFile }],
        outputDir,
        options,
      }

      const output = await plugin.generate(input)
      fs.mkdirSync(outputDir, { recursive: true })
      for (const file of output.files) {
        const dest = path.join(outputDir, file.path)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, file.content)
      }
    })
}
