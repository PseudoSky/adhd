import type { OutputPlugin, PluginInput, PluginOutput, RunInput } from '@adhd/apigen-core'
import { generate } from './generate'
import { run } from './run'

export const apiExpressPlugin: OutputPlugin = {
  id: 'api-express',
  description: 'Expose functions as Express HTTP POST routes',
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

export default apiExpressPlugin
