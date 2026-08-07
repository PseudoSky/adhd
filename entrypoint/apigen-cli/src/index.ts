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
};

const program = new Command().name('apigen').version('0.1.0');
addLoggingOptions(program);

registerGenerateCommand(program, plugins);
registerGenerateRegistryCommand(program, plugins);
registerRunCommand(program, plugins);
registerRunRegistryCommand(program, plugins);
registerServeCommand(program);
registerListTypesCommand(program, plugins);

program.parseAsync();
