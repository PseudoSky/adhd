import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverPackages } from '../registry';
import { buildCliLogger } from '../logging';
import { orchestrateGenerate } from '../orchestrator';
import type { SourceEntry } from '../orchestrator';
import type { OutputPlugin } from '@adhd/apigen-core-client';
import { describeTypeOption, unknownTypeError } from '../plugin-registry';
// BUG-APIGEN-CLI-GENERATE-USE-UNRESOLVED-001: `generate-registry` never
// exposed `--use` at all, so no extractLayer plugin (e.g. `ir-cache`) could
// ever be composed for registry-driven extraction. Reuse run.ts's resolver.
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

export function registerGenerateRegistryCommand(
  program: Command,
  plugins: Record<string, OutputPlugin>
): void {
  program
    .command('generate-registry')
    .requiredOption(
      '--packages-dir <path>',
      'Directory containing package subdirectories'
    )
    .requiredOption('--type <plugin-id>', describeTypeOption(plugins))
    .requiredOption('--out-dir <path>', 'Output directory')
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
      async (opts: {
        packagesDir: string;
        type: string;
        outDir: string;
        tag: string[];
        excludeTag: string[];
        tsconfig?: string;
        opt: string[];
        use: string[];
      }) => {
        const plugin = plugins[opts.type];
        if (!plugin) {
          throw unknownTypeError(opts.type, plugins);
        }

        const logger = buildCliLogger(program);
        const options = parseOptPairs(opts.opt);
        const packagesDir = path.resolve(opts.packagesDir);
        const outputDir = path.resolve(opts.outDir);

        const discovered = discoverPackages({
          packagesDir,
          includeTags: opts.tag,
          excludeTags: opts.excludeTag,
        });

        // Build one SourceEntry per discovered package — extraction reads the
        // physical entry file (`file`) but the generated code imports the
        // package's published specifier (`importPath`), which differ for a
        // real npm package (@adhd/foo vs an absolute path to its index.ts).
        // `namespace` is pinned to the directory-derived package id (nx tag
        // discovery convention) rather than left to tsconfig-folder inference
        // — this is the ONLY package-discovery behavior this command owns;
        // everything past this point (extraction, collision-check, codegen)
        // is the same v2 orchestrator every other command uses.
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
            `no packages with an entry file found under ${packagesDir} — nothing to generate`
          );
          return;
        }

        // BUG-APIGEN-CLI-GENERATE-USE-UNRESOLVED-001: resolve `--use`
        // specifiers to loaded Plugin objects and thread as
        // `usePluginObjects` so an `extractLayer` capability (e.g.
        // `apigen-plugin-ir-cache`) is composed into extraction here too.
        const usePlugins = await loadUsePlugins(opts.use);

        const { pluginOutput } = await orchestrateGenerate(
          { sources, usePlugins: opts.use, usePluginObjects: usePlugins, logger },
          plugin,
          outputDir,
          options
        );

        fs.mkdirSync(outputDir, { recursive: true });
        for (const file of pluginOutput.files) {
          const dest = path.join(outputDir, file.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, file.content);
        }
        logger.info(`wrote ${pluginOutput.files.length} files to ${outputDir}`);
      }
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
