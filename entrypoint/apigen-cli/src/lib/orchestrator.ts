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
//   - `--use` plugin SPECIFIERS (`OrchestratorOptions.usePlugins: string[]`)
//     are accepted and stored but not dispatched here — layer/mount capability
//     composition is a transport-level (`apigen-engine-runtime`) concern.
//     `usePluginObjects` (the LOADED `Plugin[]`, threaded by the command
//     layer) IS dispatched here, though: `buildDescriptor()` reduces each
//     plugin's `envelope`/`layer.envelopeFields` capability into the composed
//     schema's `x-apigen-envelope` §9.1 side-channel via
//     `pluginsToEnvelopeMiddlewares()` (DEBT-APIGEN-ENVELOPE-CAPABILITY-
//     UNWIRED-001) — schema composition has to happen before extraction
//     output reaches any transport, so it can't be deferred like layer/mount.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  extract,
  composeSchemas,
  createExtractionSession,
  pluginsToEnvelopeMiddlewares,
  createExtractInvokerFromPlugins,
} from '@adhd/apigen-core-client';
import type {
  ExtractionSession,
  Operation,
  Descriptor,
  ComposedSchemas,
  GeneratedSchemas,
  ExportMode,
  Logger,
  Plugin,
  PluginInput,
  RunInput,
  OutputPlugin,
} from '@adhd/apigen-core-client';
import { checkCollisions, CollisionDetectedError } from '@adhd/apigen-engine-naming';
import type { ProjectionConfig } from '@adhd/apigen-engine-naming';
import { resolveTsconfig, resolveNamespace } from './resolve-tsconfig';

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
  file: string;
  /**
   * Export mode for this source — scopes which of the fully-extracted
   * operations are actually composed into `packageSchemas` / served
   * (BUG-APIGEN-034 fix). v2's `extract()` walks the FULL export-shape
   * matrix (named, default, named-object, CJS — see extract.ts's header
   * comment) unconditionally in a single pass, unlike v1's three
   * mutually-exclusive extractors (`extractNamed`/`extractDefault`/
   * `extractNamedObject`); `buildDescriptor()`'s Step 5 restores the same
   * effective scoping by reclassifying each `Operation` by its `path` shape
   * (see `opMatchesExportMode()`) rather than by re-running a separate
   * extraction pass. Does NOT affect `descriptor.operations` (collision
   * check, `--use` mount plugins) — only the served surface — matching v1's
   * own behaviour where the collision-check step never respected
   * `exportMode` either. Omitted → no scoping (all extracted operations are
   * served); this is what `generate-registry`/`run-registry` rely on today.
   */
  exportMode?: ExportMode;
  /**
   * Namespace override for this source.  When omitted, namespace is resolved
   * from the nearest tsconfig folder (same logic as v1).
   */
  namespace?: string;
  /** Explicit tsconfig.json path.  Resolved per source file when omitted. */
  tsconfig?: string;
  /**
   * Import specifier written into generated code for this source, e.g. an
   * npm package name (`'@adhd/foo'`) instead of the absolute extraction
   * path. Defaults to `file` when omitted — true for the single-source
   * `generate`/`run` CLI commands, where the resolved source path IS the
   * import path. `generate-registry`/`run-registry` set this explicitly:
   * their package discovery resolves a physical entry file for extraction
   * (`file`) that differs from the package's published import specifier.
   */
  importPath?: string;
}

/**
 * Projection-override config (Tenet 1).
 *
 * Accepted from `--opt http.verb.<id>=GET` pairs or an `apigen.config` file.
 * Overrides are NEVER written to source.
 * Extend here as other projection dimensions are added (route, name, …).
 */
export type OverrideConfig = ProjectionConfig;

/** Options passed to the v2 orchestrator. */
export interface OrchestratorOptions {
  /** Source files to extract and merge.  Must be non-empty. */
  sources: SourceEntry[];
  /**
   * Plugin ids supplied via `--use <plugin>` (layer / mount / envelope
   * plugins).  Validated but not dispatched in v1 — wired through for v2.x.
   */
  usePlugins?: string[];
  /**
   * DEBT-APIGEN-ENVELOPE-CAPABILITY-UNWIRED-001: the LOADED `--use` plugin
   * objects (as resolved by the command layer's `loadUsePlugins()`) — distinct
   * from `usePlugins` above, which only carries the raw specifier strings.
   * `buildDescriptor()` reduces these plugins' `envelope`/`layer.envelopeFields`
   * capabilities into the composed schema's `x-apigen-envelope` §9.1
   * side-channel via `pluginsToEnvelopeMiddlewares()`, so a `--use` plugin
   * declaring `EnvelopeCapability` actually surfaces its field through a real
   * transport instead of only through hand-built test schemas. Optional —
   * omitted (or `[]`) means no `--use` plugin contributes an envelope field.
   */
  usePluginObjects?: Plugin[];
  /**
   * This invocation's flat `--opt key=value` bag, already parsed
   * (`parseOptPairs`) by the command layer — the SAME bag already passed to
   * `orchestrateGenerate`'s `pluginOpts` parameter for the `--type` target
   * plugin. Threaded to {@link extractSource}'s
   * `createExtractInvokerFromPlugins` call so a `--use <id>` plugin's
   * `extractLayer.createLayer` capability can read `--opt` values (e.g.
   * `--use ir-cache --opt cache=<path>` — plugin.ts's `ExtractLayerCapability`
   * doc). Optional/omitted (or `{}`) — no `--use` plugin needing opts-aware
   * behaviour — is a no-op, unchanged from before this field existed.
   */
  extractLayerOptions?: Record<string, unknown>;
  /** Projection-override config (Tenet 1). */
  overrides?: OverrideConfig;
  /** Shared logger. */
  logger?: Logger;
}

/** The unified canonical descriptor built by the orchestrator. */
export interface OrchestratorDescriptor {
  /** All extracted + merged operations (tagged by `host`). */
  operations: Operation[];
  /**
   * Per-source composed schemas, keyed by the source's resolved namespace.
   * The v1 `PluginInput.packages` is built from these.
   */
  packageSchemas: Map<
    string,
    { id: string; schemas: ComposedSchemas; importPath: string }
  >;
}

/** Result returned by `orchestrateGenerate`. */
export interface GenerateResult {
  descriptor: OrchestratorDescriptor;
  pluginOutput: Awaited<ReturnType<OutputPlugin['generate']>>;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/** Supported host languages (only 'ts' in v1). */
export type HostLang = 'ts';

/**
 * Detects the host language from a file path extension.
 *
 * @throws if the extension is not a recognised TypeScript extension.
 */
export function detectLang(filePath: string): HostLang {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
    return 'ts';
  }
  throw new Error(
    `apigen-orchestrator: unsupported source extension "${ext}" for file "${filePath}". ` +
      `Currently supported: .ts .tsx .mts .cts`
  );
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
  const config: OverrideConfig = {};

  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);

    // http.verb.<id>=<VERB>
    const verbMatch = /^http\.verb\.(.+)$/.exec(key);
    if (verbMatch) {
      const opId = verbMatch[1];
      config.http ??= {};
      config.http.verb ??= {};
      config.http.verb[opId] = value as import('@adhd/apigen-engine-naming').HttpVerb;
    }
  }

  return config;
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
  cliOverrides: OverrideConfig
): OverrideConfig {
  const candidate =
    configPath ?? path.join(process.cwd(), 'apigen.config.json');
  let fileConfig: OverrideConfig = {};

  if (fs.existsSync(candidate)) {
    try {
      fileConfig = JSON.parse(
        fs.readFileSync(candidate, 'utf8')
      ) as OverrideConfig;
    } catch {
      // Malformed config — ignore and proceed with CLI overrides only.
    }
  }

  // Merge: CLI wins for verb overrides; file provides the baseline.
  const merged: OverrideConfig = { ...fileConfig };
  if (cliOverrides.http?.verb) {
    merged.http = {
      ...merged.http,
      verb: { ...merged.http?.verb, ...cliOverrides.http.verb },
    };
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

/** Per-source extraction result: the resolved namespace + its operations. */
interface SourceExtraction {
  namespace: string;
  ops: Operation[];
}

/**
 * Extract canonical `Operation[]` from a single source file.
 *
 * Uses `@adhd/apigen-core-client's v2 `extract()` function.
 *
 * Returns the resolved `namespace` alongside the operations — the ONLY
 * place `resolveNamespace()` is called for a given source, so downstream
 * consumers (Step 5's `packageSchemas` grouping) key off the exact same
 * namespace `extract()` stamped onto every `Operation.namespace`, with no
 * risk of the two computations drifting.
 *
 * @param entry            - The source entry describing the file and extraction options.
 * @param logger           - Optional logger.
 * @param session          - Optional shared extraction session (schema/program cache).
 * @param usePluginObjects - The loaded `--use` plugin objects (design doc
 *                           Revision 2, R2.6 item 3 / implementation spec
 *                           R2-3). Any plugin declaring the `extractLayer`
 *                           capability wraps the real `extract()` call below
 *                           via `createExtractInvokerFromPlugins` — e.g.
 *                           `apigen-plugin-ir-cache --use ir-cache
 *                           --opt cache=<path>` answering a HIT without
 *                           re-running the real extractor. Omitted/empty (or
 *                           no plugin declaring `extractLayer`) degrades to a
 *                           pure pass-through — byte-identical to calling
 *                           `extract()` directly (a MISS is behaviourally
 *                           unchanged from before this parameter existed).
 * @param extractLayerOptions - This invocation's flat `--opt` bag, passed to
 *                           `createExtractInvokerFromPlugins` so a plugin's
 *                           `createLayer(opts)` sees it. Defaults to `{}`.
 */
async function extractSource(
  entry: SourceEntry,
  logger?: Logger,
  session?: ExtractionSession,
  usePluginObjects: Plugin[] = [],
  extractLayerOptions: Record<string, unknown> = {}
): Promise<SourceExtraction> {
  const lang = detectLang(entry.file);

  if (lang === 'ts') {
    const tsconfig = resolveTsconfig(entry.file, entry.tsconfig);
    const namespace =
      entry.namespace ??
      resolveNamespace(entry.file, { tsconfig: entry.tsconfig });

    logger?.info(`extracting ${entry.file} (host: ts, ns: ${namespace})`);
    const invokeExtract = createExtractInvokerFromPlugins(
      usePluginObjects,
      (call) =>
        extract({
          sourceFile: call.source,
          namespace: call.namespace,
          tsconfig:
            typeof call.extractorOptions?.['tsconfig'] === 'string'
              ? (call.extractorOptions['tsconfig'] as string)
              : undefined,
          session: call.extractorOptions?.['session'] as
            | ExtractionSession
            | undefined,
        }),
      extractLayerOptions
    );
    const ops = await invokeExtract({
      source: entry.file,
      host: 'ts',
      namespace,
      extractorOptions: { tsconfig, session },
    });
    logger?.info(
      `extracted ${ops.length} operations from ${path.basename(entry.file)}`
    );
    logger?.debug({ ops: ops.map((o) => o.id) }, 'operation ids');
    return { namespace, ops };
  }

  // Future hosts: shell to apigen-<lang>-extractor subprocess → parse JSON.
  throw new Error(
    `apigen-orchestrator: host "${lang}" extractor not implemented`
  );
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
  return perSourceOps.flat();
}

/**
 * BUG-APIGEN-034: restores v1's `--export <mode>` scoping of the SERVED
 * surface. v1 ran exactly one of three mutually-exclusive extractors
 * (`extractNamed`/`extractDefault`/`extractNamedObject`) per `exportMode`;
 * v2's `extract()` walks the full export-shape matrix unconditionally (see
 * extract.ts's header comment), so this reclassifies each already-extracted
 * `Operation` by `path` shape and filters Step 5's schema composition only —
 * `descriptor.operations` (collision-check, `--use` mount plugins) stays
 * unscoped, matching pre-v1-retirement behaviour (the old collision-check
 * step never respected `exportMode` either — only what actually got SERVED
 * did).
 *
 * Path-shape correspondence (extract.ts's six-shape matrix):
 *   - `'named'`       → `path.length === 2` (shapes 1/2: a plain named
 *     function/const export). This shape is also produced by shape 6 (a CJS
 *     `module.exports` property) and shape 4's bare
 *     `export default function foo(){}` form — neither is distinguishable
 *     from a plain named export via `path` alone, since `Operation` carries
 *     no export-shape discriminator (that would require extending
 *     `extract()`/`Operation` itself — out of scope here, filed as a
 *     follow-up). v1 never supported CJS sources or a bare default-fn-decl
 *     under ANY `--export` mode (see extract.ts's shape 4/6 comments), so
 *     folding them into `'named'` is a strict superset of v1's true
 *     `extractNamed` coverage, never a subset: nothing v1 used to serve
 *     under `--export` (omitted) goes missing here.
 *   - `'default'`     → `path.length === 3 && path[1].raw === 'default'`
 *     (shape 4's default-OBJECT branch only, e.g. `export default { a, b }`).
 *     v1's `extractDefault` covered EXCLUSIVELY this object-literal
 *     default-export form — never a bare `export default function foo(){}`
 *     (shape 4's fn-decl branch) or an anonymous default fn (shape 5), both
 *     new in v2 with no v1 predecessor — so excluding them here matches v1's
 *     actual historical coverage exactly.
 *   - `'named-object'` → `path.length === 3 && path[1].raw === mode.name`
 *     (shape 3: `export const <mode.name> = { ... }`).
 */
export function opMatchesExportMode(op: Operation, mode: ExportMode): boolean {
  if (mode.type === 'named') return op.path.length === 2;
  if (mode.type === 'default') {
    return op.path.length === 3 && op.path[1]?.raw === 'default';
  }
  // 'named-object'
  return op.path.length === 3 && op.path[1]?.raw === mode.name;
}

/**
 * Build the unified `OrchestratorDescriptor` from a set of source entries.
 *
 * Steps:
 *   1. Detect language per source.
 *   2. Extract canonical `Operation[]` per source (v2 extract).
 *   3. Merge into one list.
 *   4. Run the collision check (SPEC §5 uniqueness invariant).
 *   5. Derive per-source `ComposedSchemas` (the plugin-facing surface every
 *      `OutputPlugin.generate()`/`run()` actually dispatches against) FROM
 *      the operations already extracted in step 2 — see the note on Step 5
 *      below for why this must not re-extract. Scoped per-source by
 *      `SourceEntry.exportMode` (BUG-APIGEN-034) via `opMatchesExportMode()`.
 *
 * @param opts - Orchestrator options.
 */
export async function buildDescriptor(
  opts: OrchestratorOptions
): Promise<OrchestratorDescriptor> {
  const {
    sources,
    overrides = {},
    logger,
    usePluginObjects = [],
    extractLayerOptions = {},
  } = opts;
  // DEBT-APIGEN-ENVELOPE-CAPABILITY-UNWIRED-001: reduce the loaded `--use`
  // plugins' envelope-contributing capabilities ONCE, up front — every
  // namespace's `composeSchemas()` call below merges the SAME set (a plugin
  // loaded via `--use` applies across every source in this run).
  const envelopeMiddlewares = pluginsToEnvelopeMiddlewares(usePluginObjects);

  if (sources.length === 0) {
    throw new Error(
      'apigen-orchestrator: at least one source must be provided'
    );
  }

  // One shared extraction session for the whole run: one ts-morph Project per
  // tsconfig (lib.d.ts parses once, not twice per source), one built schema
  // generator per file, and every (file, typeText) schema computed once.
  // Disposed in `finally` so a one-shot CLI run retains nothing.
  const session = createExtractionSession();
  try {
    // --- Step 1+2: detect + extract per source -------------------------------
    const perSource: SourceExtraction[] = await Promise.all(
      sources.map((entry) =>
        extractSource(entry, logger, session, usePluginObjects, extractLayerOptions)
      )
    );

    // --- Step 3: merge -------------------------------------------------------
    const operations = mergeOperations(perSource.map((r) => r.ops));
    logger?.info(
      `merged ${operations.length} total operations from ${sources.length} source(s)`
    );

    // --- Step 4: collision check (hard error per SPEC §5) --------------------
    // Pass the override config so verb overrides are honoured in projection.
    try {
      checkCollisions(operations, overrides);
    } catch (err) {
      if (err instanceof CollisionDetectedError) {
        logger?.error({ collisions: err.collisions }, err.message);
      }
      throw err;
    }

    // --- Step 5: derive per-source ComposedSchemas from `operations` ---------
    //
    // BUG-APIGEN-CORE-005 (v1 retirement): this step used to call the v1
    // `generateSchemas()` a SECOND time here — an entirely independent
    // extraction pass, still driven by the buggy re-export-blind v1
    // extractors, that silently overwrote what steps 1-4 had already
    // correctly extracted. Every `OutputPlugin.generate()`/`run()` dispatches
    // against `pkg.schemas` (this step's output), not `descriptor.operations`
    // — so a re-export-heavy source produced a correct "merged 140 total
    // operations" log line (from step 3) while the ACTUAL generated/served
    // routes were built from the v1 extractor's 2 physically-local functions.
    // Verified empirically pre-fix: `generate --v2` against memory-core's
    // 40-file re-export barrel logged "merged 140 total operations" but wrote
    // a routes.ts with exactly 2 routes.
    //
    // Fix: group the ALREADY-EXTRACTED `operations` by namespace and adapt
    // each `action`-kind Operation's `{input, output, hasCtx}` — the same
    // shape v1's `GeneratedSchemas.schemas[fnName]` carried — into the
    // existing (extractor-independent, pure) `composeSchemas()`. One
    // canonical extraction pass now backs both `descriptor.operations` and
    // `packageSchemas`; they can never again disagree.
    //
    // `query`/`constructor`/`instance-method` operations are intentionally
    // excluded here (as v1 always was): `ComposedSchemas` entries are
    // dispatched by looking up a live function in `buildFnTable(mod)`
    // (`@adhd/apigen-engine-runtime`), which only picks up `typeof === 'function'`
    // exports — a `query` is a serializable-data const, not callable, and
    // `constructor`/`instance-method` come from the separate `extractClasses()`
    // path (SPEC §10), not wired into this orchestrator.
    const packageSchemas = new Map<
      string,
      {
        id: string;
        schemas: ComposedSchemas;
        importPath: string;
      }
    >();

    // Seed one group per source (in source order). See the BUG-APIGEN-035
    // guard immediately below: a namespace collision now throws rather than
    // silently overwriting the earlier source's group.
    const groups = new Map<
      string,
      {
        namespace: string;
        importPath: string;
        generated: GeneratedSchemas;
        exportMode?: ExportMode;
      }
    >();
    // BUG-APIGEN-035: a namespace collision across sources would otherwise
    // silently last-source-wins via plain `Map.set()` — one source's
    // operations vanish from `packageSchemas` with no error, no warning.
    // Not currently reachable (registry namespaces come from a single
    // `fs.readdirSync`, inherently unique; `generate`/`run` only ever pass
    // one source — BACKLOG BUG-APIGEN-035), but undocumented as a caller
    // invariant. Guard explicitly, mirroring `serve.ts`'s existing
    // duplicate-namespace check (`resolveHosts()`, serve.ts:164-171) for
    // consistency across the CLI.
    for (let i = 0; i < sources.length; i++) {
      const entry = sources[i];
      const namespace = perSource[i].namespace;
      if (groups.has(namespace)) {
        throw new Error(
          `apigen-orchestrator: duplicate namespace "${namespace}" — two sources ` +
            `resolve to the same namespace; the second source's operations would ` +
            `silently overwrite the first's in packageSchemas. Give one source an ` +
            `explicit, distinct \`namespace\` to disambiguate.`
        );
      }
      groups.set(namespace, {
        namespace,
        importPath: entry.importPath ?? entry.file,
        generated: { metadata: { namespace, phase: '' }, schemas: {} },
        exportMode: entry.exportMode,
      });
    }

    for (const op of operations) {
      if (op.kind !== 'action') continue;
      const group = groups.get(op.namespace.raw);
      if (!group) continue; // defensive — every op's namespace comes from a seeded source
      // BUG-APIGEN-034: scope which ops actually get composed/served per the
      // source's `--export <mode>` — see `opMatchesExportMode()` above.
      if (group.exportMode && !opMatchesExportMode(op, group.exportMode)) {
        continue;
      }
      // The flat dispatch-table key: always the terminal path segment's raw
      // spelling — matches v1's `fn.name` for every shape (named, renamed,
      // re-exported, named-object property, default-object property, CJS
      // property, anonymous default) because extract.ts's `opPath` always
      // ends in a segment built from the same name it also passes as the
      // op's own `exportName`/`propName` argument.
      const fnName = op.path[op.path.length - 1].raw;
      group.generated.schemas[fnName] = {
        input: op.input,
        output: op.output,
        ...(op.hasCtx ? { hasCtx: true } : {}),
        // BUG-APIGEN-025: thread op.safe through so composeSchemas() can
        // actually stamp a meaningful x-apigen-safe (previously never wired
        // this far — see compose-schemas.ts).
        safe: op.safe,
      };
    }

    for (const group of groups.values()) {
      logger?.info(
        `composing schemas for namespace "${group.namespace}" (${
          Object.keys(group.generated.schemas).length
        } action(s))`
      );
      const schemas = composeSchemas(group.generated, envelopeMiddlewares, {});
      packageSchemas.set(group.namespace, {
        id: group.namespace,
        schemas,
        importPath: group.importPath,
      });
    }

    return { operations, packageSchemas };
  } finally {
    session.dispose();
  }
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
  pluginOpts: Record<string, unknown> = {}
): Promise<GenerateResult> {
  // `pluginOpts` IS the flat `--opt` bag the command layer already parsed —
  // reuse it as `extractLayerOptions` unless the caller explicitly set a
  // different one, so `--use ir-cache --opt cache=<path>` reaches the
  // extract-stage plugin without every command file having to thread a
  // second, redundant field.
  const descriptor = await buildDescriptor({
    ...opts,
    extractLayerOptions: opts.extractLayerOptions ?? pluginOpts,
  });

  const packages: PluginInput['packages'] = Array.from(
    descriptor.packageSchemas.values()
  ).map((p) => ({ id: p.id, schemas: p.schemas, importPath: p.importPath }));

  const input: PluginInput = {
    packages,
    outputDir,
    options: pluginOpts,
    logger: opts.logger,
    // DEBT-APIGEN-PLUGIN-MCP-GENERATE-OPERATIONS-001: thread the real merged
    // Operation[] through so generate() can call project(op) on real ops
    // (exact for multi-file namespaces / npm-specifier importPath /
    // default-object exports) instead of synthesizing a best-effort stub —
    // mirrors what orchestrateRun() already does for run().
    operations: descriptor.operations,
  };

  const pluginOutput = await plugin.generate(input);
  return { descriptor, pluginOutput };
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
 *                        `(fns, createClient)` for that source.  Receives the
 *                        source's composed `ComposedSchemas` too, so the
 *                        command layer can run schema-driven precondition
 *                        guards (e.g. the `decimal.js` optional-peer-dep
 *                        check) before importing the live module.  Injected
 *                        by the command layer so the orchestrator stays
 *                        testable without live imports.
 * @param signal        - Abort signal forwarded from the process SIGINT handler.
 * @param pluginOpts    - Plugin-level options.
 */
export async function orchestrateRun(
  opts: OrchestratorOptions,
  plugin: OutputPlugin,
  buildFnTables: (
    entry: SourceEntry,
    schemas: ComposedSchemas
  ) => Promise<{
    fns: Record<string, (...args: unknown[]) => unknown>;
    createClient: (envelope: Record<string, unknown>) => Promise<object>;
  }>,
  signal: AbortSignal,
  pluginOpts: Record<string, unknown> = {}
): Promise<void> {
  if (!plugin.run) {
    throw new Error(`Plugin "${plugin.id}" does not support run mode`);
  }

  // Same reasoning as `orchestrateGenerate`: `pluginOpts` is the flat
  // `--opt` bag already parsed by the command layer — reuse it as
  // `extractLayerOptions` unless the caller explicitly set a different one.
  const descriptor = await buildDescriptor({
    ...opts,
    extractLayerOptions: opts.extractLayerOptions ?? pluginOpts,
  });

  // Map each source back to its resolved namespace — NOT its (possibly
  // overridden, see `SourceEntry.importPath`) import specifier — since
  // `packageSchemas` is keyed by namespace (`p.id`). Matching on `importPath`
  // would silently fail to resolve for `generate-registry`/`run-registry`
  // sources, whose `importPath` is a published npm specifier distinct from
  // the physical `file` used for extraction.
  const entryByNamespace = new Map<string, SourceEntry>();
  for (const entry of opts.sources) {
    const namespace =
      entry.namespace ?? resolveNamespace(entry.file, { tsconfig: entry.tsconfig });
    entryByNamespace.set(namespace, entry);
  }

  const packages: RunInput['packages'] = await Promise.all(
    Array.from(descriptor.packageSchemas.values()).map(async (p) => {
      const entry = entryByNamespace.get(p.id);
      if (!entry) {
        throw new Error(
          `apigen-orchestrator: internal error — no source entry for namespace "${p.id}"`
        );
      }
      const { fns, createClient } = await buildFnTables(entry, p.schemas);
      return {
        id: p.id,
        schemas: p.schemas,
        importPath: p.importPath,
        fns,
        createClient,
      };
    })
  );

  const input: RunInput = {
    packages,
    outputDir: '',
    options: pluginOpts,
    signal,
    logger: opts.logger,
    // BUG-APIGEN-024: thread the real merged Operation[] through so `--use`
    // mount plugins (e.g. apigen-plugin-openapi) can build their Descriptor
    // from actual extracted operations instead of an empty stub.
    operations: descriptor.operations,
  };

  await plugin.run(input);
}

// ---------------------------------------------------------------------------
// v2 Descriptor type alias (re-export for consumers that want the SPEC §4 shape)
// ---------------------------------------------------------------------------
// `Descriptor` from @adhd/apigen-core-clientis the full SPEC §4 Descriptor.  The
// `OrchestratorDescriptor` above is the *intermediate* form the orchestrator
// builds; it carries both the neutral Operation[] and the v1-compat
// ComposedSchemas.  Consumers that need only the neutral descriptor can work
// with `descriptor.operations` directly.
export type { Descriptor };
