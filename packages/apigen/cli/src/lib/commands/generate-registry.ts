import { Command } from 'commander'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { discoverPackages } from '../registry'
import { runPipeline } from '../pipeline'
import { buildCliLogger } from '../logging'
import type { OutputPlugin, PluginInput } from '@adhd/apigen-core'

/** Parse --opt key=value pairs into an options record. */
function parseOptPairs(pairs: string[]): Record<string, unknown> {
  return Object.fromEntries(
    pairs.map(s => {
      const i = s.indexOf('=')
      return [s.slice(0, i), s.slice(i + 1)]
    })
  )
}

export function registerGenerateRegistryCommand(
  program: Command,
  plugins: Record<string, OutputPlugin>
): void {
  program
    .command('generate-registry')
    .requiredOption('--packages-dir <path>', 'Directory containing package subdirectories')
    .requiredOption('--type <plugin-id>', 'Output target: mcp | api-fastify | api-express | cli | jsonschema')
    .requiredOption('--out-dir <path>', 'Output directory')
    .option('--tag <tag>', 'Include only packages with this tag (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--exclude-tag <tag>', 'Exclude packages with this tag (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--tsconfig <path>', 'Explicit tsconfig.json; default resolves the nearest config or a builtin one')
    .option('--opt <key=value>', 'Plugin option (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .action(async (opts: {
      packagesDir: string
      type: string
      outDir: string
      tag: string[]
      excludeTag: string[]
      tsconfig?: string
      opt: string[]
    }) => {
      const plugin = plugins[opts.type]
      if (!plugin) {
        throw new Error(`Unknown --type: ${opts.type}. Available: ${Object.keys(plugins).join(', ')}`)
      }

      const logger = buildCliLogger(program)
      const options = parseOptPairs(opts.opt)
      const packagesDir = path.resolve(opts.packagesDir)
      const outputDir = path.resolve(opts.outDir)

      const discovered = discoverPackages({
        packagesDir,
        includeTags: opts.tag,
        excludeTags: opts.excludeTag,
      })

      const pkgEntries: PluginInput['packages'] = []
      for (const meta of discovered) {
        // Find the main entry file for the package
        const entryFile = findEntryFile(meta.dir)
        if (!entryFile) continue

        const { schemas } = await runPipeline({ sourceFile: entryFile, tsconfig: opts.tsconfig, logger })
        pkgEntries.push({ id: meta.id, schemas, importPath: meta.importPath })
      }

      const input: PluginInput = {
        packages: pkgEntries,
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
      logger.info(`wrote ${output.files.length} files to ${outputDir}`)
    })
}

/** Find the TypeScript entry file within a package directory. */
function findEntryFile(dir: string): string | undefined {
  const candidates = ['index.ts', 'src/index.ts', 'lib/index.ts']
  for (const candidate of candidates) {
    const full = path.join(dir, candidate)
    if (fs.existsSync(full)) return full
  }
  return undefined
}
