import { Command } from 'commander'
import { registerGenerateCommand } from './lib/commands/generate'
import { registerGenerateRegistryCommand } from './lib/commands/generate-registry'
import { registerRunCommand } from './lib/commands/run'
import { registerRunRegistryCommand } from './lib/commands/run-registry'
import { registerServeCommand } from './lib/commands/serve'
import mcpPlugin from '@adhd/apigen-plugin-mcp'
import jsonschemaPlugin from '@adhd/apigen-plugin-jsonschema'
import fastifyPlugin from '@adhd/apigen-plugin-api-fastify'
import expressPlugin from '@adhd/apigen-plugin-api-express'
import cliOutputPlugin from '@adhd/apigen-plugin-cli-output'
import pyFlaskPlugin from '@adhd/apigen-plugin-py-flask'
import pyGrpcPlugin from '@adhd/apigen-plugin-py-grpc'
import { addLoggingOptions } from './lib/logging'
import type { OutputPlugin } from '@adhd/apigen-core'

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
}

const program = new Command().name('apigen').version('0.1.0')
addLoggingOptions(program)

registerGenerateCommand(program, plugins)
registerGenerateRegistryCommand(program, plugins)
registerRunCommand(program, plugins)
registerRunRegistryCommand(program, plugins)
registerServeCommand(program)

program.parseAsync()
