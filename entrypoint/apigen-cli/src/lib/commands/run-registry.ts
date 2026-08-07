import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverPackages } from '../registry';
import { importSource } from '../import-source';
import { buildFnTable } from '@adhd/apigen-engine-runtime';
import { resolveTsconfig } from '../resolve-tsconfig';
import { buildCliLogger } from '../logging';
import { orchestrateRun } from '../orchestrator';
import type { SourceEntry } from '../orchestrator';
import type { OutputPlugin } from '@adhd/apigen-core-client';
import {
  describeRunTypeOption,
  unknownTypeError,
  unsupportedRunError,
} from '../plugin-registry';
// BUG-APIGEN-CLI-GENERATE-USE-UNRESOLVED-001: `run-registry` never exposed
// `--use` at all, so no extractLayer/layer/mount plugin could ever be
// composed for registry-driven run. Reuse run.ts's resolver.
import { loadUsePlugins } from './run';

/** Parse --opt key=value pairs into an options record. */
function parseOptPairs(pairs: string[]): Record<string, unknown> {
  return Object.fromEntries(
    pairs.map((s) => {
      const i = s.indexOf('=');
      return [s.slice(0, i), s.slice(i + 1)];
    })
  );
}

/** Find the TypeScript entry file within a package directory. */
function findEntryFile(dir: string): string | undefined {
  const candidates = ['index.ts', 'src/index.ts', 'lib/index.ts'];
  for (const candidate of candidates) {
    const full = path.join(dir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return undefined;
}

export function registerRunRegistryCommand(
  program: Command,
  plugins: Record<string, OutputPlugin>
): void {
  program
    .command('run-registry')
    // DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001: same native `-- <command>
    // <args>` passthrough as `run` — see that command's registration for the
    // full rationale. Threaded onto `RunInput.options['argv']` below.
    .argument(
      '[cliArgs...]',
      'Passthrough command + args for a run-capable plugin (e.g. `-- get-item --id 42`)'
    )
    .requiredOption(
      '--packages-dir <path>',
      'Directory containing package subdirectories'
    )
    .requiredOption('--type <plugin-id>', describeRunTypeOption(plugins))
    .option(
      '--tag <tag>',
      'Include only packages with this tag (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      '--exclude-tag <tag>',
      'Exclude packages with this tag (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      '--tsconfig <path>',
      'Explicit tsconfig.json; default resolves the nearest config or a builtin one'
    )
    .option(
      '--opt <key=value>',
      'Plugin option (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .option(
      '--use <plugin>',
      'Layer/mount/envelope plugin to activate (repeatable; accepts package specifier or local path)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[]
    )
    .action(
      async (
        cliArgs: string[],
        opts: {
          packagesDir: string;
          type: string;
          tag: string[];
          excludeTag: string[];
          tsconfig?: string;
          opt: string[];
          use: string[];
        }
      ) => {
        const plugin = plugins[opts.type];
        if (!plugin) throw unknownTypeError(opts.type, plugins);
        if (!plugin.run) throw unsupportedRunError(opts.type, plugins);

        const logger = buildCliLogger(program);
        const options = parseOptPairs(opts.opt);
        // DEBT-APIGEN-CLI-RUN-ARGV-PASSTHROUGH-001: native passthrough takes
        // precedence over `--opt argv=<string>` when both are present.
        if (cliArgs.length > 0) {
          options['argv'] = cliArgs;
        }
        // BUG-APIGEN-CLI-GENERATE-USE-UNRESOLVED-001: resolve `--use`
        // specifiers to loaded Plugin objects — mirrors `run`'s handling
        // (thread via options.usePlugins for the run plugin's own
        // layer/mount composition AND via OrchestratorOptions.usePluginObjects
        // below so buildDescriptor()/extractSource() can compose a declared
        // `extractLayer` capability, e.g. `apigen-plugin-ir-cache`).
        const usePlugins = await loadUsePlugins(opts.use);
        if (usePlugins.length > 0) {
          options['usePlugins'] = usePlugins;
        }
        const packagesDir = path.resolve(opts.packagesDir);

        const discovered = discoverPackages({
          packagesDir,
          includeTags: opts.tag,
          excludeTags: opts.excludeTag,
        });

        // Same package-discovery contract as generate-registry: `file` drives
        // extraction, `importPath` (npm specifier) drives the generated
        // import statement, `namespace` is pinned to the nx-tag-discovered
        // package id.
        const sources: SourceEntry[] = [];
        for (const meta of discovered) {
          const entryFile = findEntryFile(meta.dir);
          if (!entryFile) continue;
          sources.push({
            file: entryFile,
            namespace: meta.id,
            importPath: meta.importPath,
            tsconfig: opts.tsconfig,
          });
        }

        if (sources.length === 0) {
          logger.info(
            `no packages with an entry file found under ${packagesDir} — nothing to run`
          );
          return;
        }

        const controller = new AbortController();
        process.on('SIGINT', () => controller.abort());
        process.on('SIGTERM', () => controller.abort());

        await orchestrateRun(
          { sources, usePlugins: opts.use, usePluginObjects: usePlugins, logger },
          plugin,
          async (entry: SourceEntry) => {
            const tsconfig = resolveTsconfig(entry.file, entry.tsconfig);
            // Import the source module to get live function table (tsx loader
            // handles .ts). buildFnTable keys default-exported functions by
            // their declaration name.
            const mod = await importSource(entry.file, tsconfig);
            const fns = buildFnTable(mod);
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
