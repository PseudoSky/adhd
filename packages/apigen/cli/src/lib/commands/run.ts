import { Command } from 'commander'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
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
import type { ExportMode, OutputPlugin, RunInput, ComposedSchemas, Plugin } from '@adhd/apigen-core'
import { effectiveLanguage } from '@adhd/apigen-core'
// Built-in `--use` plugins. Statically imported so the vite-bundled CLI inlines
// them (a runtime dynamic `import('@adhd/apigen-plugin-health')` would NOT be in
// the standalone bundle). A bare slug (`--use health`) resolves here; an
// arbitrary package specifier or local path falls through to a dynamic import.
import healthPlugin from '@adhd/apigen-plugin-health'
import loggerPlugin from '@adhd/apigen-plugin-logger'

/** Parse --opt key=value pairs into an options record. */
function parseOptPairs(pairs: string[]): Record<string, unknown> {
  return Object.fromEntries(
    pairs.map(s => {
      const i = s.indexOf('=')
      return [s.slice(0, i), s.slice(i + 1)]
    })
  )
}

// ---------------------------------------------------------------------------
// Precondition guards (fail-fast — BUG-APIGEN-004 / dod.fail-fast)
// ---------------------------------------------------------------------------

/**
 * Assert that the function table built from the source module is non-empty.
 *
 * A source that yields 0 functions is almost certainly generated output, a
 * type-only file, or the wrong path — not a callable apigen surface.  Failing
 * here with an actionable message avoids the cryptic `ERR_MODULE_NOT_FOUND`
 * crash that occurs later when the server tries to dispatch to a non-existent
 * route.
 *
 * @param fns        - Function table produced by `buildFnTable`.
 * @param sourceFile - Absolute path to the source, for the error message.
 * @throws if `fns` contains no entries.
 */
export function assertFnsNonEmpty(
  fns: Record<string, (...args: unknown[]) => unknown>,
  sourceFile: string,
): void {
  if (Object.keys(fns).length === 0) {
    throw new Error(
      `0 functions found in --source ${sourceFile} — ` +
      `looks like generated output or the wrong source file. ` +
      `Point --source at the original TypeScript source that exports your API functions.`,
    )
  }
}

/**
 * Walk a JSON schema object recursively and return `true` if any node carries
 * `{ "format": "decimal" }`.
 *
 * Bounded to a depth of 20 to guard against pathological schemas; in practice
 * API schemas are shallow.
 */
function schemaUsesDecimal(node: unknown, depth = 0): boolean {
  if (depth > 20 || !node || typeof node !== 'object') return false
  const obj = node as Record<string, unknown>

  if (obj['format'] === 'decimal') return true

  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        if (schemaUsesDecimal(item, depth + 1)) return true
      }
    } else if (schemaUsesDecimal(val, depth + 1)) {
      return true
    }
  }
  return false
}

/**
 * Collect the names of functions in `schemas` whose input or output schemas
 * reference `format:'decimal'`.
 */
function collectDecimalFunctions(schemas: ComposedSchemas): string[] {
  const names: string[] = []
  for (const [name, entry] of Object.entries(schemas)) {
    if (schemaUsesDecimal(entry.input) || schemaUsesDecimal(entry.output)) {
      names.push(name)
    }
  }
  return names
}

/**
 * A resolver function that mimics `require.resolve` for a package name.
 * Injected in tests to simulate absence without actually removing packages.
 */
export type LibResolver = (pkg: string) => string

/** The default resolver: delegates to Node's `require.resolve`. */
const defaultResolver: LibResolver = (pkg) => require.resolve(pkg)

/**
 * Assert that `decimal.js` is resolvable when any function in `schemas`
 * uses a `format:'decimal'` parameter or return value.
 *
 * @param schemas  - The composed schemas for the surface.
 * @param resolver - Optional resolver; defaults to `require.resolve`.
 *                   Injected in tests to simulate the lib being absent.
 * @throws if decimal-using functions are found but `decimal.js` cannot resolve.
 */
export function assertDecimalLibPresent(
  schemas: ComposedSchemas,
  resolver: LibResolver = defaultResolver,
): void {
  const decimalFns = collectDecimalFunctions(schemas)
  if (decimalFns.length === 0) return

  try {
    resolver('decimal.js')
  } catch {
    const fnList = decimalFns.join(', ')
    throw new Error(
      `function ${decimalFns[0]} takes a Decimal; install \`decimal.js\` ` +
      `(affected functions: ${fnList})`,
    )
  }
}

// ---------------------------------------------------------------------------
// `--use` plugin loading (BUG-APIGEN-009 / -010)
// ---------------------------------------------------------------------------

/**
 * The built-in `--use` plugin registry keyed by bare slug.  These are the
 * plugins shipped with apigen that callers reference by short name
 * (`--use health`, `--use logger`).  Statically imported so the bundled CLI
 * inlines them.
 */
const BUILTIN_USE_PLUGINS: Record<string, Plugin> = {
  health: healthPlugin as Plugin,
  logger: loggerPlugin as Plugin,
}

/**
 * Resolve `--use` specifiers into loaded {@link Plugin} objects.
 *
 * Resolution order per specifier:
 *   1. Built-in slug (`health`, `logger`) → the statically-imported plugin.
 *   2. Otherwise treat the specifier as a package name or local path and
 *      dynamically `import()` it (default or named `plugin`/`<id>Plugin` export).
 *
 * The loaded plugins are threaded to the run plugin via `options.usePlugins`
 * so the transport adapter can compose their `layer`/`mount` capabilities
 * (RunInput carries no dedicated field).
 *
 * @param specifiers - The raw `--use` values (slugs, package names, or paths).
 * @returns The loaded plugin objects, in declaration order.
 */
export async function loadUsePlugins(specifiers: string[]): Promise<Plugin[]> {
  const loaded: Plugin[] = []
  for (const spec of specifiers) {
    const builtin = BUILTIN_USE_PLUGINS[spec]
    if (builtin) {
      loaded.push(builtin)
      continue
    }
    // Package specifier or local path — resolve a local path to a file URL so
    // dynamic import works cross-platform.
    const target = spec.startsWith('.') || path.isAbsolute(spec)
      ? pathToFileURL(path.resolve(spec)).href
      : spec
    const mod = (await import(target)) as Record<string, unknown>
    const candidate =
      (mod['default'] as Plugin | undefined) ??
      (mod['plugin'] as Plugin | undefined) ??
      (Object.values(mod).find(
        (v): v is Plugin =>
          !!v && typeof v === 'object' && 'capabilities' in (v as object),
      ))
    if (!candidate) {
      throw new Error(
        `--use ${spec}: module exported no plugin (expected a default export, ` +
        `a \`plugin\` export, or an object with a \`capabilities\` field)`,
      )
    }
    loaded.push(candidate)
  }
  return loaded
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
      // BUG-APIGEN-009 / -010: load `--use` plugins and thread the live plugin
      // objects to the run plugin via options.usePlugins so it can compose their
      // layer (validation, logging) + mount (health) capabilities into the
      // served HTTP path. RunInput has no dedicated field, so they ride here.
      const usePlugins = await loadUsePlugins(opts.use)
      if (usePlugins.length > 0) {
        options['usePlugins'] = usePlugins
      }
      const sourceFile = path.resolve(opts.source)

      const controller = new AbortController()
      process.on('SIGINT', () => controller.abort())
      process.on('SIGTERM', () => controller.abort())

      const pluginLang = effectiveLanguage(plugin)

      if (opts.v2) {
        // --- v2 unified path: detect → extract → merge → collision-check → run ---

        // Non-TS plugins (e.g. py-flask) do not go through the TS extraction
        // pipeline — the plugin's run() consumes the source file directly.
        if (pluginLang !== 'ts') {
          const namespace = opts.namespace ?? path.basename(path.dirname(sourceFile))
          const nonTsInput: RunInput = {
            packages: [{ id: namespace, schemas: {}, importPath: sourceFile }],
            outputDir: '',
            options,
            signal: controller.signal,
            logger,
          }
          await plugin.run(nonTsInput)
          return
        }

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

            // [dod.fail-fast] Guard (a): 0 functions
            assertFnsNonEmpty(fns, entry.file)

            const createClient = async (envelope: Record<string, unknown>): Promise<object> => envelope
            return { fns, createClient }
          },
          controller.signal,
          options,
        )
        return
      }

      // --- v1 path (kept for backward compatibility) -----------------------

      // Non-TS plugins bypass the TS pipeline entirely (e.g. py-flask spawns
      // python3 directly; trying to tsx-import a .py file throws ERR_UNKNOWN_FILE_EXTENSION).
      if (pluginLang !== 'ts') {
        const namespace = opts.namespace ?? path.basename(path.dirname(sourceFile))
        const nonTsInput: RunInput = {
          packages: [{ id: namespace, schemas: {}, importPath: sourceFile }],
          outputDir: '',
          options,
          signal: controller.signal,
          logger,
        }
        await plugin.run(nonTsInput)
        return
      }

      const tsconfig = resolveTsconfig(sourceFile, opts.tsconfig)
      const { schemas, createClient } = await runPipeline({ sourceFile, exportMode, tsconfig, logger })

      // [dod.fail-fast] Guard (b): decimal.js optional peer dep
      assertDecimalLibPresent(schemas)

      // Import the source module to get live function table (tsx loader handles .ts).
      // buildFnTable keys default-exported functions by their declaration name so
      // they match the extracted schema/route names (otherwise dispatch can't find them).
      const mod = await importSource(sourceFile, tsconfig)
      const fns = buildFnTable(mod)

      // [dod.fail-fast] Guard (a): 0 functions
      assertFnsNonEmpty(fns, sourceFile)

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
