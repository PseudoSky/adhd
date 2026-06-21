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

// Stubs — implemented in subsequent states
export async function generateSchemas(
  _opts: import('./lib/types').GenerateSchemasOptions
): Promise<import('./lib/types').GeneratedSchemas> {
  throw new Error('not implemented — see schema-extraction state')
}

export function composeSchemas(
  _domainSchemas: import('./lib/types').GeneratedSchemas,
  _middlewares: ReadonlyArray<{ id: string; envelope?: Record<string, unknown> }>,
  _overrides?: Record<string, Record<string, boolean>>,
): import('./lib/types').ComposedSchemas {
  throw new Error('not implemented — see schema-composition state')
}
