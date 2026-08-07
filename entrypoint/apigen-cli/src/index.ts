import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { registerGenerateCommand } from './lib/commands/generate';
import { registerGenerateRegistryCommand } from './lib/commands/generate-registry';
import { registerRunCommand } from './lib/commands/run';
import { registerRunRegistryCommand } from './lib/commands/run-registry';
import { registerServeCommand } from './lib/commands/serve';
import { registerListTypesCommand } from './lib/commands/list-types';
import mcpPlugin from '@adhd/apigen-plugin-mcp';
import jsonschemaPlugin from '@adhd/apigen-plugin-jsonschema';
import fastifyPlugin from '@adhd/apigen-plugin-api-fastify';
import expressPlugin from '@adhd/apigen-plugin-api-express';
import cliOutputPlugin from '@adhd/apigen-plugin-cli-output';
import pyFlaskPlugin from '@adhd/apigen-plugin-py-flask';
import pyGrpcPlugin from '@adhd/apigen-plugin-py-grpc';
import { irCachePlugin } from '@adhd/apigen-plugin-ir-cache';
import type { IrCacheOptions } from '@adhd/apigen-plugin-ir-cache';
import javaJavalinPlugin from '@adhd/apigen-plugin-java-javalin';
import { addLoggingOptions } from './lib/logging';
import type { OutputPlugin, PluginInput, PluginOutput } from '@adhd/apigen-core-client';

// `irCachePlugin` (`@adhd/apigen-plugin-ir-cache`) is a v2 capability-based
// `Plugin`, not the v1 `OutputPlugin` (`generate(PluginInput): PluginOutput`)
// this CLI's `--type` registry still speaks. Its `target` capability
// (ARTIFACT mode, design doc extract-stage-onion-and-ir-cache.md R2.4) only
// reads `descriptor.operations`, so the adapter below projects that one
// field off `PluginInput` — no other v1↔v2 bridging is needed for this
// plugin. `--use ir-cache` (RUNTIME CACHE mode, `extractLayer` capability)
// needs no such adapter and is registered directly as a v2 `Plugin` in
// `./lib/commands/run.ts`'s `BUILTIN_USE_PLUGINS`.
const irCacheTargetPlugin: OutputPlugin = {
  id: irCachePlugin.id,
  description: irCachePlugin.description ?? '',
  language: irCachePlugin.language,
  optionsSchema: irCachePlugin.optionsSchema,
  async generate(input: PluginInput): Promise<PluginOutput> {
    const target = irCachePlugin.capabilities.target;
    if (!target) {
      throw new Error('apigen-plugin-ir-cache: target capability missing');
    }
    const files = await target.generate(
      { operations: input.operations ?? [], host: 'ts' },
      input.options as unknown as IrCacheOptions
    );
    return { files };
  },
};

const plugins: Record<string, OutputPlugin> = {
  mcp: mcpPlugin,
  jsonschema: jsonschemaPlugin,
  'api-fastify': fastifyPlugin,
  'api-express': expressPlugin,
  cli: cliOutputPlugin,
  // Alias: the published plugin id is `cli`; `cli-output` mirrors the package
  // name (@adhd/apigen-plugin-cli-output) so `--type cli-output` also resolves.
  'cli-output': cliOutputPlugin,
  // Python HTTP target — spawns python3 -m apigen_python.flask_server
  'py-flask': pyFlaskPlugin,
  // Python gRPC target — spawns python3 -m apigen_python.grpc_server
  'py-grpc': pyGrpcPlugin,
  // Extract-stage IR cache, ARTIFACT mode (`--type ir-cache --opt
  // cache=artifact`) — see the adapter comment above.
  'ir-cache': irCacheTargetPlugin,
  // Java HTTP target (FEAT-APIGEN-001) — two-phase spawn: mvn exec:java
  // ApigenJavaExtractor, then a codegen-woven ApigenJavalinServer.
  'java-javalin': javaJavalinPlugin,
};

const program = new Command().name('apigen').version('0.1.0');
addLoggingOptions(program);

registerGenerateCommand(program, plugins);
registerGenerateRegistryCommand(program, plugins);
registerRunCommand(program, plugins);
registerRunRegistryCommand(program, plugins);
registerServeCommand(program);
registerListTypesCommand(program, plugins);

// bin entry-guard (BUG-APIGEN-CLI-VERIFY-DIST-LOAD-ARGV-001): only parse
// argv when this file is the process's actual executed entry point (`node
// dist/index.js`, or the `apigen` bin) — NOT when require()'d/import()'d
// as a dependency. pnpm/npm always install a package's `bin` as a SYMLINK
// (node_modules/.bin/apigen -> the real dist/index.js), and Node resolves
// symlinks (realpath) for the executing module's own import.meta.url but
// leaves process.argv[1] as the raw, unresolved invocation path — so
// comparing them directly would silently never match through the
// symlinked bin. Resolve argv[1] via realpathSync first to close that gap.
//
// realpathSync(argv[1]) itself must be guarded: when this file is merely
// require()'d/import()'d by a host whose OWN argv[1] is not a real
// filesystem path (e.g. `node -e "require(...)" someRandomArg`, where
// `-e`'s trailing token lands in argv[1] verbatim — this is the exact shape
// of the bug's own regression test), realpathSync throws ENOENT and would
// crash the whole host process merely for having imported this module. The
// already-proven guard at entrypoint/agent-mcp/src/index.ts:415-423
// (`computeIsMainModule`) established this same fallback: on a
// realpath failure, fall back to a plain (non-realpath'd) comparison, which
// simply won't match import.meta.url (this file's own resolved URL) and
// so still correctly skips parseAsync() — never a crash.
function resolvedArgv1Url(argv1: string): string {
  try {
    return pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return pathToFileURL(argv1).href;
  }
}

if (process.argv[1] && import.meta.url === resolvedArgv1Url(process.argv[1])) {
  program.parseAsync().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
