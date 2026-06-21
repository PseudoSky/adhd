import type {
  OutputPlugin,
  PluginInput,
  PluginOutput,
} from '@adhd/apigen-core';

export const cliPlugin: OutputPlugin = {
  id: 'cli',
  description: 'Emit a Commander CLI program for each exported function',
  optionsSchema: {
    type: 'object',
    properties: {},
  },
  generate(input: PluginInput): PluginOutput {
    // TODO: implement — return { files: [{ path: '...', content: '...' }] }
    return { files: [] };
  },
};

export default cliPlugin;
