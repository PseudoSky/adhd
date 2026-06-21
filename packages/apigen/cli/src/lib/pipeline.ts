import { generateSchemas, composeSchemas } from '@adhd/apigen-core'
import type { ComposedSchemas, ExportMode, GenerateSchemasOptions } from '@adhd/apigen-core'

export interface PipelineOptions {
  sourceFile: string
  exportMode?: ExportMode
  middlewares?: Array<{ id: string; envelope?: Record<string, unknown> }>
  overrides?: Record<string, Record<string, boolean>>
  namespace?: string
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
