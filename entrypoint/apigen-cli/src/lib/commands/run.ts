import type {
  ComposedSchemas,
  ExportMode,
  OutputPlugin,
  Plugin,
  RunInput,
} from '@adhd/apigen-core-client';
import { effectiveLanguage } from '@adhd/apigen-core-client';
import { buildFnTable } from '@adhd/apigen-engine-runtime';
import { Command } from 'commander';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importSource } from '../import-source';
import { buildCliLogger } from '../logging';
import type { SourceEntry } from '../orchestrator';
import {
  loadOverrideConfig,
  orchestrateRun,
  parseOverrides,
} from '../orchestrator';
import {
  describeRunTypeOption,
  unknownTypeError,
  unsupportedRunError,
} from '../plugin-registry';
import { resolveTsconfig } from '../resolve-tsconfig';
// Built-in `--use` plugins. Statically imported so the vite-bundled CLI inlines
// them (a runtime dynamic `import('@adhd/apigen-plugin-health')` would NOT be in
// the standalone bundle). A bare slug (`--use health`) resolves here; an
// arbitrary package specifier or local path falls through to a dynamic import.
import batchPlugin from '@adhd/apigen-plugin-batch';
import healthPlugin from '@adhd/apigen-plugin-health';
import loggerPlugin from '@adhd/apigen-plugin-logger';
import openapiPlugin from '@adhd/apigen-plugin-openapi';


/** Parse --opt key=value pairs into an options record. */
function parseOptPairs(pairs: string[]): Record<string, unknown> {
  return Object.fromEntries(
    pairs.map((s) => {
      const i = s.indexOf('=');
      return [s.slice(0, i), s.slice(i + 1)];
    })
  );
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
  sourceFile: string
): void {
  if (Object.keys(fns).length === 0) {
    throw new Error(
      `0 functions found in --source ${sourceFile} — ` +
      `looks like generated output or the wrong source file. ` +
      `Point --source at the original TypeScript source that exports your API functions.`
    );
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
  if (depth > 20 || !node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;

  if (obj['format'] === 'decimal') return true;

  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        if (schemaUsesDecimal(item, depth + 1)) return true;
      }
    } else if (schemaUsesDecimal(val, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Collect the names of functions in `schemas` whose input or output schemas
 * reference `format:'decimal'`.
 */
function collectDecimalFunctions(schemas: ComposedSchemas): string[] {
  const names: string[] = [];
  for (const [name, entry] of Object.entries(schemas)) {
    if (schemaUsesDecimal(entry.input) || schemaUsesDecimal(entry.output)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * A resolver function that mimics `require.resolve` for a package name.
 * Injected in tests to simulate absence without actually removing packages.
 */
export type LibResolver = (pkg: string) => string;

/** The default resolver: delegates to Node's `require.resolve`. */
const defaultResolver: LibResolver = (pkg) => require.resolve(pkg);

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
  resolver: LibResolver = defaultResolver
): void {
  const decimalFns = collectDecimalFunctions(schemas);
  if (decimalFns.length === 0) return;

  try {
    resolver('decimal.js');
  } catch {
    const fnList = decimalFns.join(', ');
    throw new Error(
      `function ${decimalFns[0]} takes a Decimal; install \`decimal.js\` ` +
      `(affected functions: ${fnList})`
    );
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
  batch: batchPlugin as Plugin,
  health: healthPlugin as Plugin,
  logger: loggerPlugin as Plugin,
  openapi: openapiPlugin as Plugin,
};

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
  const loaded: Plugin[] = [];
  for (const spec of specifiers) {
    const builtin = BUILTIN_USE_PLUGINS[spec];
    if (builtin) {
      loaded.push(builtin);
      continue;
    }
    // Package specifier or local path — resolve a local path to a file URL so
    // dynamic import works cross-platform.
    const isLocal =
      spec.startsWith('.') ||
      path.isAbsolute(spec) ||
      (!/^[a-zA-Z]+:\/\//.test(spec) && /\.(js|mjs|cjs|ts|json|txt)$/i.test(spec));

    const target = isLocal
      ? pathToFileURL(path.resolve(spec)).href
      : spec;
    const mod = (await import(target)) as Record<string, unknown>;
    const candidate =
      (mod['default'] as Plugin | undefined) ??
      (mod['plugin'] as Plugin | undefined) ??
      Object.values(mod).find(
        (v): v is Plugin =>
          !!v && typeof v === 'object' && 'capabilities' in (v as object)
      );
    if (!candidate) {
      throw new Error(
        `--use ${spec}: module exported no plugin (expected a default export, ` +
        `a \`plugin\` export, or an object with a \`capabilities\` field)`
      );
    }
    loaded.push(candidate);
  }
  return loaded;
}

export function registerRunCommand(
  program: Command,
  plugins: Record<string, OutputPlugin>
): void {
  program
    .command('run')
    // DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001: a trailing variadic argument
    // so `apigen run --source f --type cli -- <command> <args>` reaches a
    // run-capable plugin's argv (e.g. @adhd/apigen-plugin-cli-output) natively
    // — Commander otherwise rejects any positional token (including
    // everything after a literal `--`) with "too many arguments for 'run'"
    // since zero arguments were declared. Threaded onto
    // `RunInput.options['argv']` below (the same key the cli-output plugin's
    // `resolveArgv()` already reads) — the `--opt argv=<string>` delivery
    // path keeps working unchanged for back-compat.
    .argument(
      '[cliArgs...]',
      'Passthrough command + args for a run-capable plugin (e.g. `-- get-item --id 42`)'
    )
    .requiredOption('--source <path>', 'Path to TypeScript source file')
    .requiredOption('--type <plugin-id>', describeRunTypeOption(plugins))
    .option(
      '--export <mode>',
      'Export mode: "default" | "<named-object-name>" | omit for named exports'
    )
    .option(
      '--tsconfig <path>',
      'Explicit tsconfig.json; default resolves the nearest config or a builtin one'
    )
    .option(
      '--namespace <name>',
      'Package namespace/id (default: tsconfig folder name, else source folder)'
    )
    .option(
      '--opt <key=value>',
      'Plugin option (repeatable). Projection overrides: http.verb.<id>=GET',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      '--use <plugin>',
      'Layer/mount/envelope plugin to activate (repeatable; accepts package specifier or local path)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      '--config <path>',
      'Path to apigen.config.json projection-override file (Tenet 1)'
    )
    .action(
      async (
        cliArgs: string[],
        opts: {
          source: string;
          type: string;
          export?: string;
          tsconfig?: string;
          namespace?: string;
          opt: string[];
          use: string[];
          config?: string;
        }
      ) => {
        const plugin = plugins[opts.type];
        if (!plugin) throw unknownTypeError(opts.type, plugins);
        if (!plugin.run) throw unsupportedRunError(opts.type, plugins);

        let exportMode: ExportMode;
        if (opts.export === 'default') {
          exportMode = { type: 'default' };
        } else if (opts.export) {
          exportMode = { type: 'named-object', name: opts.export };
        } else {
          exportMode = { type: 'named' };
        }

        const logger = buildCliLogger(program);
        const allOpts = opts.opt;
        const options = parseOptPairs(allOpts);
        // DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001: the native `-- <command>
        // <args>` positional passthrough takes precedence over the `--opt
        // argv=<string>` delivery path when both are present — it's the more
        // explicit, idiomatic form. `resolveArgv()` (apigen-plugin-cli-
        // output's run.ts) already accepts a real `string[]` here.
        if (cliArgs.length > 0) {
          options['argv'] = cliArgs;
        }
        // BUG-APIGEN-009 / -010: load `--use` plugins and thread the live plugin
        // objects to the run plugin via options.usePlugins so it can compose their
        // layer (validation, logging) + mount (health) capabilities into the
        // served HTTP path. RunInput has no dedicated field, so they ride here.
        const usePlugins = await loadUsePlugins(opts.use);
        if (usePlugins.length > 0) {
          options['usePlugins'] = usePlugins;
        }
        const sourceFile = path.resolve(opts.source);

        const controller = new AbortController();
        // BUG-APIGEN-CLI-RUN-SHUTDOWN-001: aborting the signal alone is not
        // enough to guarantee this process ever exits. `plugin.run()` resolves
        // only once its own server finishes closing (e.g. api-fastify's
        // `run.ts` awaits `app.close()` on abort) — and Fastify/Express-style
        // `close()` does not forcibly end lingering keep-alive sockets by
        // default, so a single open client connection (including one held by
        // `serve`'s own front↔host proxying) can hang that promise forever.
        // `serve` spawns exactly this command as each host child (see
        // orchestrator.ts `spawnHost`), so a hang here is what orphans those
        // children when the parent `serve` process is eventually killed
        // before ever sending them a follow-up SIGKILL. Bound the shutdown
        // phase so this process always exits within a few seconds of a
        // signal, independent of how the plugin's own server behaves.
        let shuttingDown = false;
        const onSignal = (sig: NodeJS.Signals): void => {
          controller.abort();
          if (shuttingDown) return;
          shuttingDown = true;
          const forceExit = setTimeout(() => {
            process.stderr.write(
              `[run] shutdown exceeded deadline after ${sig} — forcing exit\n`
            );
            process.exit(1);
          }, 5000);
          forceExit.unref?.();
        };
        process.on('SIGINT', () => onSignal('SIGINT'));
        process.on('SIGTERM', () => onSignal('SIGTERM'));
        process.on('SIGHUP', () => onSignal('SIGHUP'));

        const pluginLang = effectiveLanguage(plugin);

        // Unified v2 orchestrator path: detect → extract → merge →
        // collision-check → run. This is now the ONLY extraction pipeline
        // (v1's generateSchemas()/extractNamed()/extractDefault()/
        // extractNamedObject() were retired — BUG-APIGEN-CORE-005).

        // Non-TS plugins (e.g. py-flask) do not go through the TS extraction
        // pipeline — the plugin's run() consumes the source file directly.
        if (pluginLang !== 'ts') {
          const namespace =
            opts.namespace ?? path.basename(path.dirname(sourceFile));
          const nonTsInput: RunInput = {
            packages: [{ id: namespace, schemas: {}, importPath: sourceFile }],
            outputDir: '',
            options,
            signal: controller.signal,
            logger,
          };
          await plugin.run(nonTsInput);
          return;
        }

        const cliOverrides = parseOverrides(allOpts);
        const overrides = loadOverrideConfig(opts.config, cliOverrides);

        const sourceEntry: SourceEntry = {
          file: sourceFile,
          exportMode,
          namespace: opts.namespace,
          tsconfig: opts.tsconfig,
        };

        await orchestrateRun(
          {
            sources: [sourceEntry],
            usePlugins: opts.use,
            // DEBT-APIGEN-ENVELOPE-CAPABILITY-UNWIRED-001: thread the LOADED
            // plugin objects (not just their specifier strings) so
            // buildDescriptor() can merge a declared `envelope`/
            // `layer.envelopeFields` capability into the composed schema
            // before this namespace's ComposedSchemas is built.
            usePluginObjects: usePlugins,
            overrides,
            logger,
          },
          plugin,
          async (entry: SourceEntry, schemas: ComposedSchemas) => {
            // [dod.fail-fast] Guard (b): decimal.js optional peer dep
            assertDecimalLibPresent(schemas);

            const tsconfig = resolveTsconfig(entry.file, entry.tsconfig);
            const mod = await importSource(entry.file, tsconfig);
            const fns = buildFnTable(mod);

            // [dod.fail-fast] Guard (a): 0 functions
            assertFnsNonEmpty(fns, entry.file);

            const createClient = async (
              envelope: Record<string, unknown>
            ): Promise<object> => envelope;
            return { fns, createClient };
          },
          controller.signal,
          options
        );
      }
    );
}
