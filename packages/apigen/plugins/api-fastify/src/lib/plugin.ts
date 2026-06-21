import type { OutputPlugin, PluginInput, PluginOutput, RunInput } from '@adhd/apigen-core'
import { generate } from './generate'
import { run } from './run'

export const apiFastifyPlugin: OutputPlugin = {
  id: 'api-fastify',
  description: 'Expose functions as Fastify HTTP POST routes',
  optionsSchema: {
    type: 'object',
    properties: {
      port: { type: 'number', default: 3000 },
      routePrefix: { type: 'string', default: '' },
    },
  },
  generate(input: PluginInput): PluginOutput {
    return generate(input)
  },
  run(input: RunInput): Promise<void> {
    return run(input)
  },
}

export default apiFastifyPlugin
