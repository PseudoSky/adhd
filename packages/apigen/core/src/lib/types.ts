import type { Logger } from 'pino'

// Output of generateSchemas() — domain schemas only, no middleware envelope
export interface GeneratedSchemas {
  metadata: { namespace: string; phase: string }
  schemas: Record<string, {
    input:  Record<string, unknown>
    output: Record<string, unknown>
  }>
}

// Output of composeSchemas() — domain + middleware envelope merged
// data: {} wrapper is ALWAYS present, even for zero-param functions
export type ComposedSchemas = Record<string, {
  input:  Record<string, unknown>
  output: Record<string, unknown>
}>

// Three mutually exclusive extraction modes
export type ExportMode =
  | { type: 'named' }
  | { type: 'default' }
  | { type: 'named-object'; name: string }

// Options for generateSchemas()
export interface GenerateSchemasOptions {
  sourceFile: string       // absolute path to .ts source file
  exportMode?: ExportMode  // default: { type: 'named' }
  namespace?: string       // written to metadata (informational)
  phase?: string           // written to metadata (informational)
  tsconfig?: string        // absolute path to a tsconfig.json driving type resolution
}

// Plugin system — language-agnostic: files[] can contain any language
export interface PluginInput {
  packages: Array<{
    id: string
    schemas: ComposedSchemas
    importPath: string
    fns?: Record<string, (...args: unknown[]) => unknown>
    createClient?: (envelope: Record<string, unknown>) => Promise<unknown>
  }>
  outputDir: string
  options: Record<string, unknown>
  /**
   * Shared structured logger (pino). Built once by the CLI and threaded through
   * the pipeline + plugins. Always targets stderr or a file — never stdout —
   * so the MCP stdio JSON-RPC channel stays clean. Plugins should fall back to
   * a default stderr logger when this is absent.
   */
  logger?: Logger
}

export interface PluginOutput {
  files: Array<{ path: string; content: string }>
  postCommands?: string[]
}

export interface RunInput extends PluginInput {
  signal?: AbortSignal
}

export interface OutputPlugin {
  id: string
  description: string
  optionsSchema?: Record<string, unknown>
  generate(input: PluginInput): PluginOutput | Promise<PluginOutput>
  run?(input: RunInput): Promise<void>
}
