import { Command } from 'commander'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { discoverPackages } from '../registry'
import { runPipeline } from '../pipeline'
import type { OutputPlugin, RunInput } from '@adhd/apigen-core'

/** Parse --opt key=value pairs into an options record. */
function parseOptPairs(pairs: string[]): Record<string, unknown> {
  return Object.fromEntries(
    pairs.map(s => {
      const i = s.indexOf('=')
      return [s.slice(0, i), s.slice(i + 1)]
    })
  )
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

export function registerRunRegistryCommand(
  program: Command,
  plugins: Record<string, OutputPlugin>
): void {
  program
    .command('run-registry')
    .requiredOption('--packages-dir <path>', 'Directory containing package subdirectories')
    .requiredOption('--type <plugin-id>', 'Output target')
    .option('--tag <tag>', 'Include only packages with this tag (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--exclude-tag <tag>', 'Exclude packages with this tag (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--opt <key=value>', 'Plugin option (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .action(async (opts: {
      packagesDir: string
      type: string
      tag: string[]
      excludeTag: string[]
      opt: string[]
    }) => {
      const plugin = plugins[opts.type]
      if (!plugin?.run) throw new Error(`Plugin ${opts.type} does not support run mode`)

      const options = parseOptPairs(opts.opt)
      const packagesDir = path.resolve(opts.packagesDir)

      const discovered = discoverPackages({
        packagesDir,
        includeTags: opts.tag,
        excludeTags: opts.excludeTag,
      })

      const pkgEntries: RunInput['packages'] = []
      for (const meta of discovered) {
        const entryFile = findEntryFile(meta.dir)
        if (!entryFile) continue

        const { schemas, createClient } = await runPipeline({ sourceFile: entryFile })

        // Import the source module to get live function table
        const mod = await import(entryFile) as Record<string, unknown>
        const fns: Record<string, (...args: unknown[]) => unknown> = {}
        for (const [key, val] of Object.entries(mod)) {
          if (typeof val === 'function') {
            fns[key] = val as (...args: unknown[]) => unknown
          }
        }

        pkgEntries.push({
          id: meta.id,
          schemas,
          importPath: meta.importPath,
          fns,
          createClient,
        })
      }

      const controller = new AbortController()
      process.on('SIGINT', () => controller.abort())
      process.on('SIGTERM', () => controller.abort())

      const input: RunInput = {
        packages: pkgEntries,
        outputDir: '',
        options,
        signal: controller.signal,
      }

      await plugin.run(input)
    })
}
