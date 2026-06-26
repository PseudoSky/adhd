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
import type { ExportMode, OutputPlugin, PluginInput, ComposedSchemas } from '@adhd/apigen-core'
import { emitResolutionScaffolding } from '../scaffold'
// DEBT-LT-005: replaced the inline TS_LOGICAL_TYPE_DEP_MAP duplicate with the
// authoritative source from @adhd/apigen-logical. tsDepMap() derives the map
// from the same TemplateCell.dep fields that are the single source of truth
// (hints.ts §14.1), so future type additions stay consistent automatically.
import { tsDepMap } from '@adhd/apigen-logical'

// ---------------------------------------------------------------------------
// Per-surface minimal dependency manifest (DESIGN §14.1, BUG-APIGEN-002)
// ---------------------------------------------------------------------------

/**
 * Recursively walk a JSON-Schema node (any depth) and collect every
 * unique `format` string value found anywhere in the tree.
 *
 * Pure function: no I/O, no mutation of the input.
 *
 * @param node  Any JSON value (Schema node, array, primitive).
 * @param seen  Cycle guard — the set of objects already visited (prevents
 *              infinite loops on schemas with `definitions` back-refs).
 * @returns     A `Set<string>` of all format strings found.
 */
export function collectFormats(
  node: unknown,
  seen: WeakSet<object> = new WeakSet(),
): Set<string> {
  const out = new Set<string>()

  if (node === null || typeof node !== 'object') return out
  if (seen.has(node as object)) return out
  seen.add(node as object)

  if (Array.isArray(node)) {
    for (const item of node) {
      for (const f of collectFormats(item, seen)) out.add(f)
    }
    return out
  }

  const rec = node as Record<string, unknown>

  // Collect the `format` at this node.
  if (typeof rec['format'] === 'string') {
    out.add(rec['format'])
  }

  // Recurse into every value.
  for (const val of Object.values(rec)) {
    for (const f of collectFormats(val, seen)) out.add(f)
  }

  return out
}

/**
 * Given a surface's `ComposedSchemas`, return the npm dependency entries
 * required to support the logical types actually used by its operations.
 *
 * Walks every input + output schema, unions their `format` annotations,
 * looks each up in the authoritative {@link tsDepMap} from `@adhd/apigen-logical`,
 * and returns a `Record<name, version>` suitable for merging into `package.json`
 * `dependencies`.
 *
 * A surface with NO rich types returns an empty record (no `decimal.js`,
 * etc.). A surface using `Decimal` returns `{ 'decimal.js': '^10' }`.
 *
 * @param schemas The surface's composed schema map (fn-name → {input, output}).
 */
export function collectLogicalTypeDeps(
  schemas: ComposedSchemas | Record<string, { input: Record<string, unknown>; output: Record<string, unknown> }>,
): Record<string, string> {
  const formats = new Set<string>()

  for (const entry of Object.values(schemas)) {
    for (const f of collectFormats(entry.input)) formats.add(f)
    for (const f of collectFormats(entry.output)) formats.add(f)
  }

  const depMap = tsDepMap()
  const deps: Record<string, string> = {}
  for (const fmt of formats) {
    const dep = depMap[fmt]
    if (dep) deps[dep.name] = dep.version
  }
  return deps
}

/**
 * Collect logical-type deps across ALL packages in a multi-source
 * `orchestrateGenerate` result and return the union dep map.
 */
function collectDepsFromPackageSchemas(
  packageSchemas: Map<string, { id: string; schemas: ComposedSchemas; importPath: string }>,
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const { schemas } of packageSchemas.values()) {
    Object.assign(merged, collectLogicalTypeDeps(schemas))
  }
  return merged
}

/**
 * Patch the generated `package.json` in `outputDir` by merging in
 * `logicalTypeDeps`. When the `package.json` has no deps or the dep
 * map is empty this is a no-op (safe to call unconditionally).
 *
 * Called AFTER {@link emitResolutionScaffolding} so the base deps
 * (apigen-runtime, sdk) are already present.
 *
 * Exported for testing; the generate command is the normal caller.
 */
export function patchPackageJsonDeps(outputDir: string, logicalTypeDeps: Record<string, string>): void {
  if (Object.keys(logicalTypeDeps).length === 0) return

  const pkgPath = path.join(outputDir, 'package.json')
  if (!fs.existsSync(pkgPath)) return

  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
  } catch {
    return // malformed package.json — leave it alone
  }

  const existing = (pkg['dependencies'] as Record<string, string> | undefined) ?? {}
  pkg['dependencies'] = { ...existing, ...logicalTypeDeps }

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
}

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
        const { pluginOutput, descriptor } = await orchestrateGenerate(
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
        // Patch package.json with per-surface logical-type deps (DESIGN §14.1).
        patchPackageJsonDeps(outputDir, collectDepsFromPackageSchemas(descriptor.packageSchemas))
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
      // Patch package.json with per-surface logical-type deps (DESIGN §14.1).
      patchPackageJsonDeps(outputDir, collectLogicalTypeDeps(schemas))
      logger.info(`wrote ${output.files.length} files to ${outputDir}`)
    })
}
