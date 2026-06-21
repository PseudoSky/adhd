import type { OutputPlugin, PluginInput, PluginOutput } from '@adhd/apigen-core'
import { generate } from './generate'

export const cliPlugin: OutputPlugin = {
  id: 'cli',
  description: 'Emit a Commander CLI program where each exported function becomes a subcommand',
  optionsSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', default: 'cli' },
      version: { type: 'string', default: '0.1.0' },
    },
  },
  generate(input: PluginInput): PluginOutput {
    return generate(input)
  },
}

export default cliPlugin
