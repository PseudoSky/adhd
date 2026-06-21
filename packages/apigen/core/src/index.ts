export type {
  GeneratedSchemas,
  ComposedSchemas,
  ExportMode,
  GenerateSchemasOptions,
  PluginInput,
  PluginOutput,
  RunInput,
  OutputPlugin,
} from './lib/types'

export { generateSchemas } from './lib/generate-schemas'

export function composeSchemas(
  _domainSchemas: import('./lib/types').GeneratedSchemas,
  _middlewares: ReadonlyArray<{ id: string; envelope?: Record<string, unknown> }>,
  _overrides?: Record<string, Record<string, boolean>>,
): import('./lib/types').ComposedSchemas {
  throw new Error('not implemented — see schema-composition state')
}
