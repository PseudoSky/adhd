import { Command } from 'commander'
import { registerGenerateCommand } from './lib/commands/generate'
import { registerGenerateRegistryCommand } from './lib/commands/generate-registry'
import { registerRunCommand } from './lib/commands/run'
import { registerRunRegistryCommand } from './lib/commands/run-registry'
import mcpPlugin from '@adhd/apigen-plugin-mcp'
import jsonschemaPlugin from '@adhd/apigen-plugin-jsonschema'
import fastifyPlugin from '@adhd/apigen-plugin-api-fastify'
import expressPlugin from '@adhd/apigen-plugin-api-express'
import cliOutputPlugin from '@adhd/apigen-plugin-cli-output'
import { addLoggingOptions } from './lib/logging'
import type { OutputPlugin } from '@adhd/apigen-core'

const plugins: Record<string, OutputPlugin> = {
  mcp: mcpPlugin,
  jsonschema: jsonschemaPlugin,
  'api-fastify': fastifyPlugin,
  'api-express': expressPlugin,
  cli: cliOutputPlugin,
}

const program = new Command().name('apigen-cli').version('0.1.0')
addLoggingOptions(program)

registerGenerateCommand(program, plugins)
registerGenerateRegistryCommand(program, plugins)
registerRunCommand(program, plugins)
registerRunRegistryCommand(program, plugins)

program.parseAsync()
