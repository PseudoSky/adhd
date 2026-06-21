import { createGenerator, type Config } from 'ts-json-schema-generator'
import type { Project, SourceFile } from 'ts-morph'
import { morphFallback } from './morph-fallback'

/** Attempts ts-json-schema-generator first; falls back to morphFallback for inline/anonymous types. */
export async function buildSchema(
  _project: Project,
  sf: SourceFile,
  typeText: string
): Promise<Record<string, unknown>> {
  if (['void', 'undefined', 'null', 'Promise<void>'].includes(typeText)) return { type: 'null' }
  try {
    const config: Config = { path: sf.getFilePath(), type: typeText, skipTypeCheck: true }
    const schema = createGenerator(config).createSchema(typeText)
    return schema as Record<string, unknown>
  } catch {
    return morphFallback(typeText, 0)
  }
}
