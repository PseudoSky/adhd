import type {
  OutputPlugin,
  PluginInput,
  PluginOutput,
} from '@adhd/apigen-core';

export const jsonschemaPlugin: OutputPlugin = {
  id: 'jsonschema',
  description: 'Emit one JSON Schema file per function per package',
  optionsSchema: {
    type: 'object',
    properties: {},
  },
  generate(input: PluginInput): PluginOutput {
    // TODO: implement — return { files: [{ path: '...', content: '...' }] }
    return { files: [] };
  },
};

export default jsonschemaPlugin;
