import { generateSchemas, composeSchemas } from '@adhd/apigen-core'
import type { ComposedSchemas, ExportMode, GenerateSchemasOptions } from '@adhd/apigen-core'
import { resolveTsconfig } from './resolve-tsconfig'

export interface PipelineOptions {
  sourceFile: string
  exportMode?: ExportMode
  middlewares?: Array<{ id: string; envelope?: Record<string, unknown> }>
  overrides?: Record<string, Record<string, boolean>>
  namespace?: string
  /** Explicit --tsconfig flag; when omitted, the nearest/builtin config is resolved from sourceFile. */
  tsconfig?: string
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
  const domainSchemas = await generateSchemas(genOpts)
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
