import { Project, type SourceFile } from 'ts-morph'
import type { GenerateSchemasOptions, GeneratedSchemas } from './types'
import { extractNamed } from './extractors/named'
import { extractDefault } from './extractors/default-export'
import { extractNamedObject } from './extractors/named-object'
import { buildSchema } from './schema-builders/ts-json-schema'

/**
 * Reads a TypeScript source file and returns `GeneratedSchemas` — domain schemas only,
 * no middleware envelope. Supports three extraction modes: named, default, named-object.
 *
 * @param opts - Extraction options including source file path, export mode, namespace, phase
 */
export async function generateSchemas(opts: GenerateSchemasOptions): Promise<GeneratedSchemas> {
  const { sourceFile: filePath, exportMode = { type: 'named' }, namespace = '', phase = '' } = opts

  const project = new Project({ skipAddingFilesFromTsConfig: true })
  const sf: SourceFile = project.addSourceFileAtPath(filePath)

  type FnParam = { name: string; type: string; optional: boolean }
  type FnInfo = { name: string; params: FnParam[]; returnType: string }

  let fns: FnInfo[]
  if (exportMode.type === 'named') {
    fns = extractNamed(sf)
  } else if (exportMode.type === 'default') {
    fns = extractDefault(sf)
  } else {
    fns = extractNamedObject(sf, exportMode.name)
  }

  const schemas: GeneratedSchemas['schemas'] = {}

  for (const fn of fns) {
    // [inv:ctx-name-only] — filter ctx by name only, no type checking
    const domainParams = fn.params.filter(p => p.name !== 'ctx')
    const required = domainParams.filter(p => !p.optional).map(p => p.name)

    const properties: Record<string, unknown> = {}
    for (const p of domainParams) {
      properties[p.name] = await buildSchema(project, sf, p.type)
    }

    // Unwrap Promise<T> → T for the output schema
    const rawReturn = fn.returnType
    const resolvedReturn = rawReturn.replace(/^Promise<(.+)>$/, '$1').trim()
    const outputSchema = await buildSchema(project, sf, resolvedReturn)

    schemas[fn.name] = {
      input: { type: 'object', properties, required } as Record<string, unknown>,
      output: outputSchema,
    }
  }

  return { metadata: { namespace, phase }, schemas }
}
