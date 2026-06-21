import type { OutputPlugin, PluginInput, PluginOutput, RunInput } from '@adhd/apigen-core'
import { generate } from './generate'
import { run } from './run'

export const mcpPlugin: OutputPlugin = {
  id: 'mcp',
  description: 'Expose functions as MCP tools (stdio, SSE, or streaming-HTTP transport)',
  optionsSchema: {
    type: 'object',
    properties: {
      transport: { type: 'string', enum: ['stdio', 'sse', 'streaming-http'] },
      port: { type: 'number' },
      toolDescriptions: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
  generate(input: PluginInput): PluginOutput {
    return generate(input)
  },
  run(input: RunInput): Promise<void> {
    return run(input)
  },
}

export default mcpPlugin
