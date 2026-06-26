// v2 unified orchestrator (SPEC §1, §13, Tenet 1).
//
// Flow: detect lang per source → extract canonical Operation[] (v2 extract) →
//       merge into one Descriptor → collision-check (naming §5) → gen or run
//       via the selected plugin(s).
//
// Tenet 1 invariant: projection-override config is consumed HERE at
// generate/run time. Overrides are never written back to source. They are
// expressed via:
//   --opt http.verb.<id>=GET  (CLI key=value pairs)
//   apigen.config file        ({ http: { verb: { [id]: HttpVerb } } })
//
// Design notes:
//   - Language detection is currently a heuristic (extension match); the
//     architecture is wired to pass `host` per-operation in the Descriptor, so
//     adding a real extractor subprocess later (SPEC §13) is a drop-in.
//   - Only the 'ts' host is implemented in v1/v2; other hosts will extend this.
//   - `--use` plugins are accepted and stored but not dispatched in v1 (the
//     runtime layer is a v2.x concern); the orchestrator validates the flag and
//     passes the ids through so callers can prepare for it.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { extract, composeSchemas, generateSchemas } from '@adhd/apigen-core'
import type {
  Operation,
  Descriptor,
  ComposedSchemas,
  ExportMode,
  Logger,
  PluginInput,
  RunInput,
  OutputPlugin,
} from '@adhd/apigen-core'
import {
  checkCollisions,
  CollisionDetectedError,
} from '@adhd/apigen-naming'
import type { ProjectionConfig } from '@adhd/apigen-naming'
import { resolveTsconfig, resolveNamespace } from './resolve-tsconfig'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single source entry passed to the orchestrator.
 *
 * `file` is an absolute path.  Language detection is performed here — for now
 * `.ts` / `.tsx` / `.mts` / `.cts` → `'ts'`; everything else is unsupported
 * and will throw.
 */
export interface SourceEntry {
  /** Absolute path to the source file. */
  file: string
  /**
   * Export mode for this source. Defaults to `{ type: 'named' }` when omitted.
   * Per-source because a single `run` may compose multiple differently-shaped
   * sources.
   */
  exportMode?: ExportMode
  /**
   * Namespace override for this source.  When omitted, namespace is resolved
   * from the nearest tsconfig folder (same logic as v1).
   */
  namespace?: string
  /** Explicit tsconfig.json path.  Resolved per source file when omitted. */
  tsconfig?: string
}

/**
 * Projection-override config (Tenet 1).
 *
 * Accepted from `--opt http.verb.<id>=GET` pairs or an `apigen.config` file.
 * Overrides are NEVER written to source.
 * Extend here as other projection dimensions are added (route, name, …).
 */
export type OverrideConfig = ProjectionConfig

/** Options passed to the v2 orchestrator. */
export interface OrchestratorOptions {
  /** Source files to extract and merge.  Must be non-empty. */
  sources: SourceEntry[]
  /**
   * Plugin ids supplied via `--use <plugin>` (layer / mount / envelope
   * plugins).  Validated but not dispatched in v1 — wired through for v2.x.
   */
  usePlugins?: string[]
  /** Projection-override config (Tenet 1). */
  overrides?: OverrideConfig
  /** Shared logger. */
  logger?: Logger
}

/** The unified canonical descriptor built by the orchestrator. */
export interface OrchestratorDescriptor {
  /** All extracted + merged operations (tagged by `host`). */
  operations: Operation[]
  /**
   * Per-source composed schemas, keyed by the source's resolved namespace.
   * The v1 `PluginInput.packages` is built from these.
   */
  packageSchemas: Map<string, { id: string; schemas: ComposedSchemas; importPath: string }>
}

/** Result returned by `orchestrateGenerate`. */
export interface GenerateResult {
  descriptor: OrchestratorDescriptor
  pluginOutput: Awaited<ReturnType<OutputPlugin['generate']>>
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/** Supported host languages (only 'ts' in v1). */
export type HostLang = 'ts'

/**
 * Detects the host language from a file path extension.
 *
 * @throws if the extension is not a recognised TypeScript extension.
 */
export function detectLang(filePath: string): HostLang {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
    return 'ts'
  }
  throw new Error(
    `apigen-orchestrator: unsupported source extension "${ext}" for file "${filePath}". ` +
    `Currently supported: .ts .tsx .mts .cts`
  )
}

// ---------------------------------------------------------------------------
// Projection-override config parsing (Tenet 1)
// ---------------------------------------------------------------------------

/**
 * Parses `--opt` key=value pairs into an {@link OverrideConfig}.
 *
 * Recognises:
 *   `http.verb.<operationId>=GET`  → config.http.verb[operationId] = 'GET'
 *
 * Unknown keys are silently ignored (forward-compatible).
 *
 * @param pairs - Raw `key=value` strings from `--opt`.
 */
export function parseOverrides(pairs: string[]): OverrideConfig {
  const config: OverrideConfig = {}

  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const key = pair.slice(0, eqIdx)
    const value = pair.slice(eqIdx + 1)

    // http.verb.<id>=<VERB>
    const verbMatch = /^http\.verb\.(.+)$/.exec(key)
    if (verbMatch) {
      const opId = verbMatch[1]
      config.http ??= {}
      config.http.verb ??= {}
      config.http.verb[opId] = value as import('@adhd/apigen-naming').HttpVerb
    }
  }

  return config
}

/**
 * Loads an `apigen.config` JSON file and merges it with CLI overrides.
 *
 * CLI overrides win over the file.  The file is optional; when absent this is
 * a no-op.
 *
 * @param configPath - Optional explicit path.  When omitted, looks for
 *   `apigen.config.json` in the current working directory.
 * @param cliOverrides - Already-parsed CLI overrides (win over file).
 */
export function loadOverrideConfig(
  configPath: string | undefined,
  cliOverrides: OverrideConfig,
): OverrideConfig {
  const candidate = configPath ?? path.join(process.cwd(), 'apigen.config.json')
  let fileConfig: OverrideConfig = {}

  if (fs.existsSync(candidate)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(candidate, 'utf8')) as OverrideConfig
    } catch {
      // Malformed config — ignore and proceed with CLI overrides only.
    }
  }

  // Merge: CLI wins for verb overrides; file provides the baseline.
  const merged: OverrideConfig = { ...fileConfig }
  if (cliOverrides.http?.verb) {
    merged.http = {
      ...merged.http,
      verb: { ...merged.http?.verb, ...cliOverrides.http.verb },
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

/**
 * Extract canonical `Operation[]` from a single source file.
 *
 * Uses `@adhd/apigen-core`'s v2 `extract()` function.
 *
 * @param entry  - The source entry describing the file and extraction options.
 * @param logger - Optional logger.
 */
async function extractSource(
  entry: SourceEntry,
  logger?: Logger,
): Promise<Operation[]> {
  const lang = detectLang(entry.file)

  if (lang === 'ts') {
    const tsconfig = resolveTsconfig(entry.file, entry.tsconfig)
    const namespace = entry.namespace ??
      resolveNamespace(entry.file, { tsconfig: entry.tsconfig })

    logger?.info(`extracting ${entry.file} (host: ts, ns: ${namespace})`)
    const ops = await extract({ sourceFile: entry.file, namespace, tsconfig })
    logger?.info(`extracted ${ops.length} operations from ${path.basename(entry.file)}`)
    logger?.debug({ ops: ops.map(o => o.id) }, 'operation ids')
    return ops
  }

  // Future hosts: shell to apigen-<lang>-extractor subprocess → parse JSON.
  throw new Error(`apigen-orchestrator: host "${lang}" extractor not implemented`)
}

/**
 * Merge multiple per-source `Operation[]` arrays into one unified list.
 *
 * Operations are tagged by `host` from the extractor.  No deduplication — two
 * distinct sources may export the same name in different namespaces; the
 * collision check enforces uniqueness across transports.
 *
 * @param perSourceOps - Arrays produced by {@link extractSource} per file.
 */
export function mergeOperations(perSourceOps: Operation[][]): Operation[] {
  return perSourceOps.flat()
}

/**
 * Build the unified `OrchestratorDescriptor` from a set of source entries.
 *
 * Steps:
 *   1. Detect language per source.
 *   2. Extract canonical `Operation[]` per source (v2 extract).
 *   3. Merge into one list.
 *   4. Run the collision check (SPEC §5 uniqueness invariant).
 *   5. Build per-source `ComposedSchemas` for the v1 plugin surface.
 *
 * @param opts - Orchestrator options.
 */
export async function buildDescriptor(
  opts: OrchestratorOptions,
): Promise<OrchestratorDescriptor> {
  const { sources, overrides = {}, logger } = opts

  if (sources.length === 0) {
    throw new Error('apigen-orchestrator: at least one source must be provided')
  }

  // --- Step 1+2: detect + extract per source -------------------------------
  const perSourceOps: Operation[][] = await Promise.all(
    sources.map(entry => extractSource(entry, logger))
  )

  // --- Step 3: merge -------------------------------------------------------
  const operations = mergeOperations(perSourceOps)
  logger?.info(`merged ${operations.length} total operations from ${sources.length} source(s)`)

  // --- Step 4: collision check (hard error per SPEC §5) --------------------
  // Pass the override config so verb overrides are honoured in projection.
  try {
    checkCollisions(operations, overrides)
  } catch (err) {
    if (err instanceof CollisionDetectedError) {
      logger?.error({ collisions: err.collisions }, err.message)
    }
    throw err
  }

  // --- Step 5: build per-source ComposedSchemas for v1 plugin surface ------
  // We use the existing v1 pipeline (generateSchemas → composeSchemas) because
  // the v1 OutputPlugin interface speaks ComposedSchemas, not Operation[].
  // The v2 Descriptor (Operation[]) is the canonical form; ComposedSchemas is a
  // derived v1-compat projection.
  const packageSchemas = new Map<string, {
    id: string
    schemas: ComposedSchemas
    importPath: string
  }>()

  for (const entry of sources) {
    const namespace = entry.namespace ??
      resolveNamespace(entry.file, { tsconfig: entry.tsconfig })
    const tsconfig = resolveTsconfig(entry.file, entry.tsconfig)

    logger?.info(`composing schemas for ${path.basename(entry.file)}`)
    const generated = await generateSchemas({
      sourceFile: entry.file,
      exportMode: entry.exportMode ?? { type: 'named' },
      namespace,
      tsconfig,
    })
    const schemas = composeSchemas(generated, [], {})

    packageSchemas.set(namespace, {
      id: namespace,
      schemas,
      importPath: entry.file,
    })
  }

  return { operations, packageSchemas }
}

// ---------------------------------------------------------------------------
// Generate path
// ---------------------------------------------------------------------------

/**
 * Run the v2 orchestrator in **generate** mode.
 *
 * Builds the unified descriptor, then invokes the selected plugin's `generate`
 * method with the merged package set.
 *
 * @param opts      - Orchestrator options.
 * @param plugin    - The selected output plugin (`--type`).
 * @param outputDir - Absolute path to the output directory.
 * @param pluginOpts - Plugin-level options (`--opt` key=value pairs, already parsed).
 */
export async function orchestrateGenerate(
  opts: OrchestratorOptions,
  plugin: OutputPlugin,
  outputDir: string,
  pluginOpts: Record<string, unknown> = {},
): Promise<GenerateResult> {
  const descriptor = await buildDescriptor(opts)

  const packages: PluginInput['packages'] = Array.from(descriptor.packageSchemas.values()).map(
    p => ({ id: p.id, schemas: p.schemas, importPath: p.importPath })
  )

  const input: PluginInput = {
    packages,
    outputDir,
    options: pluginOpts,
    logger: opts.logger,
  }

  const pluginOutput = await plugin.generate(input)
  return { descriptor, pluginOutput }
}

// ---------------------------------------------------------------------------
// Run path
// ---------------------------------------------------------------------------

/**
 * Run the v2 orchestrator in **run** (server) mode.
 *
 * Builds the unified descriptor, then invokes the selected plugin's `run`
 * method with the merged package set + live function tables.
 *
 * @param opts          - Orchestrator options.
 * @param plugin        - The selected output plugin (`--type`).
 * @param buildFnTables - Async function that imports each source and returns
 *                        `(fns, createClient)` for that source.  Injected by
 *                        the command layer so the orchestrator stays testable
 *                        without live imports.
 * @param signal        - Abort signal forwarded from the process SIGINT handler.
 * @param pluginOpts    - Plugin-level options.
 */
export async function orchestrateRun(
  opts: OrchestratorOptions,
  plugin: OutputPlugin,
  buildFnTables: (entry: SourceEntry) => Promise<{
    fns: Record<string, (...args: unknown[]) => unknown>
    createClient: (envelope: Record<string, unknown>) => Promise<object>
  }>,
  signal: AbortSignal,
  pluginOpts: Record<string, unknown> = {},
): Promise<void> {
  if (!plugin.run) {
    throw new Error(`Plugin "${plugin.id}" does not support run mode`)
  }

  const descriptor = await buildDescriptor(opts)

  const packages: RunInput['packages'] = await Promise.all(
    Array.from(descriptor.packageSchemas.values()).map(async p => {
      const entry = opts.sources.find(s => s.file === p.importPath)
      if (!entry) {
        throw new Error(`apigen-orchestrator: internal error — no source entry for ${p.importPath}`)
      }
      const { fns, createClient } = await buildFnTables(entry)
      return { id: p.id, schemas: p.schemas, importPath: p.importPath, fns, createClient }
    })
  )

  const input: RunInput = {
    packages,
    outputDir: '',
    options: pluginOpts,
    signal,
    logger: opts.logger,
  }

  await plugin.run(input)
}

// ---------------------------------------------------------------------------
// v2 Descriptor type alias (re-export for consumers that want the SPEC §4 shape)
// ---------------------------------------------------------------------------
// `Descriptor` from @adhd/apigen-core is the full SPEC §4 Descriptor.  The
// `OrchestratorDescriptor` above is the *intermediate* form the orchestrator
// builds; it carries both the neutral Operation[] and the v1-compat
// ComposedSchemas.  Consumers that need only the neutral descriptor can work
// with `descriptor.operations` directly.
export type { Descriptor }
