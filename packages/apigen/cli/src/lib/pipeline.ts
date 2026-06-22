import { generateSchemas, composeSchemas } from '@adhd/apigen-core'
import type { ComposedSchemas, ExportMode, GenerateSchemasOptions, Logger } from '@adhd/apigen-core'
import { resolveTsconfig } from './resolve-tsconfig'

export interface PipelineOptions {
  sourceFile: string
  exportMode?: ExportMode
  middlewares?: Array<{ id: string; envelope?: Record<string, unknown> }>
  overrides?: Record<string, Record<string, boolean>>
  namespace?: string
  /** Explicit --tsconfig flag; when omitted, the nearest/builtin config is resolved from sourceFile. */
  tsconfig?: string
  /** Optional shared logger; when present the pipeline logs schema extraction. */
  logger?: Logger
}

export interface PipelineResult {
  schemas: ComposedSchemas
  createClient: (envelope: Record<string, unknown>) => Promise<object>
}

/** Run the generate + compose pipeline for a single source file. */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const genOpts: GenerateSchemasOptions = {
    sourceFile: opts.sourceFile,
    exportMode: opts.exportMode ?? { type: 'named' },
    namespace: opts.namespace,
    tsconfig: resolveTsconfig(opts.sourceFile, opts.tsconfig),
  }
  opts.logger?.info(`compiling ${opts.sourceFile}`)
  const domainSchemas = await generateSchemas(genOpts)
  const fnNames = Object.keys(domainSchemas.schemas)
  opts.logger?.info(`extracted ${fnNames.length} functions`)
  opts.logger?.debug({ functions: fnNames }, 'extracted functions')
  const schemas = composeSchemas(
    domainSchemas,
    opts.middlewares ?? [],
    opts.overrides ?? {}
  )

  const createClient = async (envelope: Record<string, unknown>): Promise<object> => {
    return envelope
  }

  return { schemas, createClient }
}
