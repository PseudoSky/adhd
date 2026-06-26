import type { OutputPlugin, PluginInput, PluginOutput } from '@adhd/apigen-core'
import * as path from 'node:path'

export const jsonschemaPlugin: OutputPlugin = {
  id: 'jsonschema',
  description: 'Emit one JSON Schema file per function per package',
  language: 'ts',
  optionsSchema: {
    type: 'object',
    properties: {
      pretty: { type: 'boolean', description: 'Pretty-print JSON (default: true)' },
    },
  },
  generate(input: PluginInput): PluginOutput {
    const pretty = (input.options['pretty'] as boolean) !== false // default true
    const files: PluginOutput['files'] = []

    for (const pkg of input.packages) {
      for (const [fnName, fnSchema] of Object.entries(pkg.schemas)) {
        files.push({
          path: path.join(pkg.id, `${fnName}.json`),
          content: JSON.stringify(fnSchema, null, pretty ? 2 : 0),
        })
      }
    }

    return { files }
  },
}

export default jsonschemaPlugin
