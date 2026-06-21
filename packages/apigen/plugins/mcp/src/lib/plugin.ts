import type {
  OutputPlugin,
  PluginInput,
  PluginOutput,
  RunInput,
} from '@adhd/apigen-core';

export const mcpPlugin: OutputPlugin = {
  id: 'mcp',
  description: 'Expose functions as MCP tools (stdio, SSE, or streaming-HTTP)',
  optionsSchema: {
    type: 'object',
    properties: {},
  },
  generate(input: PluginInput): PluginOutput {
    // TODO: implement — return { files: [{ path: '...', content: '...' }] }
    return { files: [] };
  },

  async run(input: RunInput): Promise<void> {
    // TODO: start server, register handlers, listen for input.signal
    return new Promise<void>((resolve) => {
      if (input.signal) input.signal.addEventListener('abort', () => resolve());
    });
  },
};

export default mcpPlugin;
